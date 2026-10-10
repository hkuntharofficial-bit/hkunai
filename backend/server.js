const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { pipeline } = require("stream/promises");

const {
  GoogleGenAI
} = require("@google/genai");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const {
  getSignedUrl
} = require("@aws-sdk/s3-request-presigner");


/* =========================================================
   APP
========================================================= */

const app = express();

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ ok: true, service: "hkunai-backend", uptimeSeconds: Math.round(process.uptime()) });
});

const PORT =
  process.env.PORT || 3000;

const FRONTEND_ORIGIN =
  "https://hkuntharofficial-bit.github.io";


/* =========================================================
   BASIC MIDDLEWARE
========================================================= */

app.use(
  cors({
    origin: FRONTEND_ORIGIN,

    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type"
    ]
  })
);

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  (req, res, next) => {

    res.header(
      "Access-Control-Allow-Origin",
      FRONTEND_ORIGIN
    );

    res.header(
      "Access-Control-Allow-Methods",
      "GET,POST,OPTIONS"
    );

    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  }
);


/* =========================================================
   R2 CONFIG
========================================================= */

const R2 =
  new S3Client({

    region:
      "auto",

    endpoint:
      process.env.R2_ENDPOINT,

    forcePathStyle:
      true,

    credentials: {

      accessKeyId:
        process.env.R2_ACCESS_KEY_ID,

      secretAccessKey:
        process.env.R2_SECRET_ACCESS_KEY

    }

  });


const BUCKET =
  process.env.R2_BUCKET ||
  "hkunai-videos";


/* =========================================================
   GEMINI CONFIG
========================================================= */

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";


const GEMINI =
  GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey:
          GEMINI_API_KEY
      })
    : null;


/*
  Current Gemini video model.
*/

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";


/*
  Gemini File API limits depend on account/tier.

  Default safety limit:
  2 GB.

  This can be increased through Render:

  GEMINI_MAX_FILE_BYTES
*/

const GEMINI_MAX_FILE_BYTES =
  Number(
    process.env.GEMINI_MAX_FILE_BYTES ||
    2 * 1024 * 1024 * 1024
  );


/* =========================================================
   TEMP DIRECTORY
========================================================= */

const TEMP_DIR =
  path.join(
    os.tmpdir(),
    "hkun-ai-uploads"
  );


if (!fs.existsSync(TEMP_DIR)) {

  fs.mkdirSync(
    TEMP_DIR,
    {
      recursive: true
    }
  );

}


/* =========================================================
   MULTER
========================================================= */

const upload =
  multer({

    dest:
      TEMP_DIR,

    limits: {

      /*
        Each browser upload part:
        maximum 32 MB.

        HKUN AI frontend normally:
        16 MB per part.
      */

      fileSize:
        32 * 1024 * 1024

    }

  });


/* =========================================================
   MULTIPART SESSION STORAGE
========================================================= */

const multipartSessions =
  new Map();


/* =========================================================
   HELPERS
========================================================= */

function safeFilename(
  filename
) {

  return String(
    filename ||
    "video.mp4"
  )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

}


function createStorageKey(
  filename
) {

  return (
    "uploads/" +
    Date.now() +
    "-" +
    crypto.randomUUID() +
    "-" +
    safeFilename(filename)
  );

}


function removeTempFile(
  filePath
) {

  if (!filePath) {
    return;
  }

  try {

    if (
      fs.existsSync(
        filePath
      )
    ) {

      fs.unlinkSync(
        filePath
      );

    }

  } catch (error) {

    console.error(
      "Temp cleanup error:",
      error
    );

  }

}


/*
  Download one R2 object to
  Render temporary storage.
*/

async function downloadR2Object(
  key,
  destination
) {

  const result =
    await R2.send(
      new GetObjectCommand({

        Bucket:
          BUCKET,

        Key:
          key

      })
    );


  if (!result.Body) {

    throw new Error(
      "R2 object has no body"
    );

  }


  await pipeline(
    result.Body,
    fs.createWriteStream(
      destination
    )
  );


  return {

    contentType:
      result.ContentType ||
      "video/mp4",

    contentLength:
      result.ContentLength || null

  };

}


/*
  Wait until Gemini has processed
  the uploaded video.
*/

async function waitForGeminiFile(file) {
  let current = file;
  const startedAt = Date.now();
  const maxWaitMs = 15 * 60 * 1000;
  while (current && current.state === "PROCESSING") {
    if (Date.now() - startedAt > maxWaitMs) throw new Error("Gemini is still processing this video after 15 minutes. Please retry; longer videos can take more time.");
    await new Promise(resolve => setTimeout(resolve, 5000));
    current = await GEMINI.files.get({ name: current.name });
  }
  if (current && current.state === "FAILED") throw new Error("Gemini video processing failed. Try an MP4 H.264 video.");
  if (!current || !current.uri || current.state !== "ACTIVE") throw new Error("Gemini did not finish processing the video. Current state: " + (current?.state || "unknown"));
  return current;
}

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      service:
        "HKUN AI Backend",

      status:
        "online"

    });

  }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok:
        true,

      service:
        "HKUN AI Backend",

      geminiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      geminiModel:
        GEMINI_MODEL

    });

  }
);


/* =========================================================
   CREATE MULTIPART UPLOAD
========================================================= */

app.post(
  "/api/upload-init",
  async (req, res) => {

    try {

      const {
        filename,
        contentType,
        fileSize
      } =
        req.body || {};


      if (!filename) {

        return res.status(400).json({

          ok:
            false,

          error:
            "filename is required"

        });

      }


      const size =
        Number(
          fileSize || 0
        );


      if (
        !Number.isFinite(size) ||
        size <= 0
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "fileSize is required"

        });

      }


      /*
        Maximum R2 upload size:
        5 GB.
      */

      if (
        size >
        5 *
        1024 *
        1024 *
        1024
      ) {

        return res.status(413).json({

          ok:
            false,

          error:
            "Video size is larger than 5 GB"

        });

      }


      const mimeType =
        contentType ||
        "video/mp4";


      const key =
        createStorageKey(
          filename
        );


      const command =
        new CreateMultipartUploadCommand({

          Bucket:
            BUCKET,

          Key:
            key,

          ContentType:
            mimeType

        });


      const result =
        await R2.send(
          command
        );


      if (
        !result.UploadId
      ) {

        throw new Error(
          "R2 UploadId was not returned"
        );

      }


      /*
        16 MB chunks.
      */

      const partSize =
        16 *
        1024 *
        1024;


      const session = {

        uploadId:
          result.UploadId,

        key,

        filename:
          safeFilename(
            filename
          ),

        contentType:
          mimeType,

        fileSize:
          size,

        partSize,

        createdAt:
          Date.now(),

        parts:
          new Map()

      };


      multipartSessions.set(
        result.UploadId,
        session
      );


      res.json({

        ok:
          true,

        kind:
          "multipart",

        uploadId:
          result.UploadId,

        key,

        partSizeBytes:
          partSize,

        totalParts:
          Math.ceil(
            size /
            partSize
          )

      });


    } catch (error) {

      console.error(
        "UPLOAD INIT ERROR:",
        error
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Failed to initialize R2 multipart upload"

      });

    }

  }
);


/* =========================================================
   UPLOAD ONE PART
========================================================= */

app.post(
  "/api/upload-part",
  upload.single("part"),
  async (req, res) => {

    let tempFile =
      null;


    try {

      if (!req.file) {

        return res.status(400).json({

          ok:
            false,

          error:
            "part file is required"

        });

      }


      tempFile =
        req.file.path;


      const uploadId =
        String(
          req.body.uploadId ||
          ""
        );


      const partNumber =
        Number(
          req.body.partNumber
        );


      if (!uploadId) {

        removeTempFile(
          tempFile
        );

        return res.status(400).json({

          ok:
            false,

          error:
            "uploadId is required"

        });

      }


      if (
        !Number.isInteger(
          partNumber
        ) ||
        partNumber < 1 ||
        partNumber > 10000
      ) {

        removeTempFile(
          tempFile
        );

        return res.status(400).json({

          ok:
            false,

          error:
            "Invalid partNumber"

        });

      }


      const session =
        multipartSessions.get(
          uploadId
        );


      if (!session) {

        removeTempFile(
          tempFile
        );

        return res.status(404).json({

          ok:
            false,

          error:
            "Upload session not found"

        });

      }


      const body =
        fs.createReadStream(
          tempFile
        );


      const command =
        new UploadPartCommand({

          Bucket:
            BUCKET,

          Key:
            session.key,

          UploadId:
            uploadId,

          PartNumber:
            partNumber,

          Body:
            body,

          ContentLength:
            req.file.size

        });


      const result =
        await R2.send(
          command
        );


      const eTag =
        result.ETag;


      if (!eTag) {

        throw new Error(
          "R2 did not return ETag"
        );

      }


      const cleanETag =
        eTag.replace(
          /^"|"$/g,
          ""
        );


      session.parts.set(
        partNumber,
        cleanETag
      );


      removeTempFile(
        tempFile
      );


      tempFile =
        null;


      res.json({

        ok:
          true,

        partNumber,

        eTag:
          cleanETag

      });


    } catch (error) {

      console.error(
        "UPLOAD PART ERROR:",
        error
      );


      removeTempFile(
        tempFile
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Failed to upload video part",

        message:
          error.message

      });

    }

  }
);


/* =========================================================
   COMPLETE MULTIPART UPLOAD
========================================================= */

app.post(
  "/api/upload-complete",
  async (req, res) => {

    try {

      const {
        uploadId
      } =
        req.body || {};


      if (!uploadId) {

        return res.status(400).json({

          ok:
            false,

          error:
            "uploadId is required"

        });

      }


      const session =
        multipartSessions.get(
          uploadId
        );


      if (!session) {

        return res.status(404).json({

          ok:
            false,

          error:
            "Upload session not found"

        });

      }


      if (
        session.parts.size === 0
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "No uploaded parts found"

        });

      }


      const expectedParts = Math.ceil(session.fileSize / session.partSize);
      if (session.parts.size !== expectedParts) {
        return res.status(400).json({
          ok: false,
          error: "Upload is incomplete",
          expectedParts,
          receivedParts: session.parts.size
        });
      }

      const parts =
        Array.from(
          session.parts.entries()
        )
        .sort(
          (a, b) =>
            a[0] - b[0]
        )
        .map(
          ([partNumber, eTag]) => ({

            PartNumber:
              partNumber,

            ETag:
              eTag

          })
        );


      const command =
        new CompleteMultipartUploadCommand({

          Bucket:
            BUCKET,

          Key:
            session.key,

          UploadId:
            uploadId,

          MultipartUpload: {

            Parts:
              parts

          }

        });


      const result =
        await R2.send(
          command
        );


      multipartSessions.delete(
        uploadId
      );


      res.json({

        ok:
          true,

        key:
          session.key,

        bucket:
          BUCKET,

        location:
          result.Location ||
          null,

        message:
          "Video uploaded successfully"

      });


    } catch (error) {

      console.error(
        "UPLOAD COMPLETE ERROR:",
        error
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Failed to complete R2 multipart upload",

        message:
          error.message

      });

    }

  }
);


/* =========================================================
   ABORT MULTIPART UPLOAD
========================================================= */

app.post(
  "/api/upload-abort",
  async (req, res) => {

    try {

      const {
        uploadId
      } =
        req.body || {};


      if (!uploadId) {

        return res.status(400).json({

          ok:
            false,

          error:
            "uploadId is required"

        });

      }


      const session =
        multipartSessions.get(
          uploadId
        );


      if (!session) {

        return res.json({

          ok:
            true,

          aborted:
            false

        });

      }


      await R2.send(
        new AbortMultipartUploadCommand({

          Bucket:
            BUCKET,

          Key:
            session.key,

          UploadId:
            uploadId

        })
      );


      multipartSessions.delete(
        uploadId
      );


      res.json({

        ok:
          true,

        aborted:
          true

      });


    } catch (error) {

      console.error(
        "UPLOAD ABORT ERROR:",
        error
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Failed to abort upload"

      });

    }

  }
);


/* =========================================================
   GEMINI VIDEO ANALYSIS
========================================================= */

/*
  Frontend sends:

  POST /api/analyze-video

  {
    "key": "uploads/....mp4",
    "prompt": "Analyze this movie..."
  }


  Backend:

  1. Finds video in R2
  2. Downloads to Render temp storage
  3. Uploads to Gemini File API
  4. Waits for Gemini processing
  5. Gemini analyzes the actual video
  6. Returns analysis
  7. Deletes Render temporary file

  IMPORTANT:
  Gemini File API stores uploaded files temporarily.
*/


app.post(
  "/api/analyze-video",
  async (req, res) => {

    let localVideo =
      null;


    try {

      if (!GEMINI) {

        return res.status(503).json({

          ok:
            false,

          error:
            "GEMINI_API_KEY is not configured"

        });

      }


      const {
        key,
        prompt,
        mimeType
      } =
        req.body || {};


      if (!key) {

        return res.status(400).json({

          ok:
            false,

          error:
            "R2 video key is required"

        });

      }


      /*
        Only allow videos stored
        inside uploads/.
      */

      if (
        !String(key).startsWith(
          "uploads/"
        )
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "Invalid video key"

        });

      }


      /*
        Get object metadata first.
      */

      const head =
        await R2.send(
          new GetObjectCommand({

            Bucket:
              BUCKET,

            Key:
              key

          })
        );


      const contentLength =
        Number(
          head.ContentLength || 0
        );


      if (
        contentLength >
        GEMINI_MAX_FILE_BYTES
      ) {

        return res.status(413).json({

          ok:
            false,

          error:
            "Video is larger than the current Gemini processing limit",

          maxBytes:
            GEMINI_MAX_FILE_BYTES,

          fileBytes:
            contentLength,

          message:
            "For very large movies, HKUN AI will use automatic chunk processing in the next processing stage."

        });

      }


      /*
        Close metadata stream if present.
      */

      if (
        head.Body &&
        typeof head.Body.destroy ===
          "function"
      ) {

        head.Body.destroy();

      }


      /*
        Unique Render temp filename.
      */

      localVideo =
        path.join(
          TEMP_DIR,
          "gemini-" +
            crypto.randomUUID() +
            "-" +
            safeFilename(
              path.basename(
                key
              )
            )
        );


      /*
        Download R2 video.
      */

      await downloadR2Object(
        key,
        localVideo
      );


      /*
        Upload video to Gemini Files API.
      */

      console.log(
        "Uploading video to Gemini:",
        key
      );


      let videoFile =
        await GEMINI.files.upload({

          file:
            localVideo,

          config: {

            mimeType:
              mimeType ||
              "video/mp4"

          }

        });


      console.log(
        "Gemini file:",
        videoFile.name
      );


      /*
        Wait for Gemini video
        processing.
      */

      videoFile =
        await waitForGeminiFile(
          videoFile
        );


      if (
        !videoFile ||
        !videoFile.uri
      ) {

        throw new Error(
          "Gemini video URI was not returned"
        );

      }


      /*
        Default HKUN AI analysis
        instruction.

        User can send a custom
        prompt from frontend.
      */

      const analysisPrompt =
        prompt ||
        `
You are HKUN AI, a professional Myanmar Movie Recap video analyst.

Analyze the ACTUAL video carefully.

Do NOT invent events, characters, locations, dialogue, relationships, or facts.

Identify the important story events in chronological order.

For every important event:
- Give an approximate timestamp.
- Describe what actually happens.
- Identify the important characters involved.
- Describe the important visual scene.
- Explain why the scene matters to the story.

Focus on scenes that can later be matched to a Myanmar narration timeline.

Return clear chronological information.

The final result must be useful for:
1. Myanmar Movie Recap narration.
2. Semantic scene matching.
3. Selecting relevant original footage.
4. Maintaining story continuity.

Do not create unrelated scenes.
Do not assume information that is not visible or supported by the video.
`;


      /*
        Ask Gemini to analyze the
        uploaded video.
      */

      const analysisContents = [{ role: "user", parts: [{ fileData: { fileUri: videoFile.uri, mimeType: videoFile.mimeType || mimeType || "video/mp4" } }, { text: analysisPrompt }] }];
      let response;
      try {
        response = await GEMINI.models.generateContent({ model: GEMINI_MODEL, contents: analysisContents });
      } catch (primaryError) {
        const fallbackModel = "gemini-2.5-flash";
        if (GEMINI_MODEL === fallbackModel) throw primaryError;
        console.error("Primary Gemini video model failed; retrying with", fallbackModel, primaryError?.message);
        response = await GEMINI.models.generateContent({ model: fallbackModel, contents: analysisContents });
      }


      const analysisText =
        response.text ||
        "";


      if (!analysisText) {

        throw new Error(
          "Gemini returned an empty analysis"
        );

      }


      /*
        Cleanup Render temporary
        video immediately.

        Gemini has its own temporary
        File API copy.
      */

      removeTempFile(
        localVideo
      );

      localVideo =
        null;


      res.json({

        ok:
          true,

        key,

        geminiFile:
          videoFile.name,

        model:
          GEMINI_MODEL,

        analysis:
          analysisText,

        message:
          "Video analysis completed"

      });


    } catch (error) {

      console.error(
        "GEMINI VIDEO ANALYSIS ERROR:",
        error
      );


      removeTempFile(
        localVideo
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Gemini video analysis failed",

        message:
          error.message

      });

    }

  }
);



/* =========================================================
   CHUNKED VIDEO ANALYSIS
   Split long source videos into 10–45 second pieces, analyze
   each piece independently, then return ordered summaries.
========================================================= */
app.post("/api/analyze-video-chunks", async (req, res) => {
  const body = req.body || {};
  const key = String(body.key || "");
  const mimeType = String(body.mimeType || "video/mp4");
  const recapStyle = String(body.recapStyle || "Movie Recap");
  const localVideo = path.join(TEMP_DIR, "chunk-source-" + crypto.randomUUID() + ".mp4");
  const workDir = path.join(TEMP_DIR, "chunk-work-" + crypto.randomUUID());
  const temporaryFiles = [localVideo];

  try {
    if (!GEMINI) return res.status(503).json({ ok: false, error: "GEMINI_API_KEY is not configured" });
    if (!key.startsWith("uploads/")) return res.status(400).json({ ok: false, error: "A valid uploaded video key is required" });

    fs.mkdirSync(workDir, { recursive: true });
    await downloadR2Object(key, localVideo);
    const probe = spawnSync(ffmpegPath, ["-hide_banner", "-i", localVideo], { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const probeText = String(probe.stderr || "") + "\n" + String(probe.stdout || "");
    const match = probeText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("မူရင်းဗီဒီယိုကြာချိန်ကို မဖတ်နိုင်ပါ။");

    // Aim for 45-second chunks, evenly distribute the tail so chunks
    // are normally between 10 and 45 seconds rather than leaving a tiny tail.
    const chunkCount = Math.max(1, Math.ceil(duration / 45));
    const chunkDuration = duration / chunkCount;
    const segments = [];

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkDuration;
      const length = Math.min(chunkDuration, duration - start);
      const chunkPath = path.join(workDir, "segment-" + String(i + 1).padStart(5, "0") + ".mp4");
      temporaryFiles.push(chunkPath);
      const splitArgs = [
        "-hide_banner", "-y", "-loglevel", "error",
        "-ss", start.toFixed(3), "-i", localVideo, "-t", length.toFixed(3),
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-threads", "1",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
        chunkPath
      ];
      await runFFmpeg(splitArgs);
      if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size < 1024) {
        throw new Error("ဗီဒီယိုအပိုင်း " + (i + 1) + " ကို ခွဲထုတ်မရပါ။");
      }

      let videoFile = await GEMINI.files.upload({
        file: chunkPath,
        config: { mimeType: "video/mp4" }
      });
      videoFile = await waitForGeminiFile(videoFile);
      const prompt = [
        "You are HKUN AI, analyzing one chronological segment of a movie for Myanmar recap.",
        "This is source segment " + (i + 1) + " of " + chunkCount + ".",
        "Its source-video time range is " + start.toFixed(2) + " to " + (start + length).toFixed(2) + " seconds.",
        "Recap style: " + recapStyle,
        "Analyze only visible events in this segment. Do not invent characters, events, relationships, or dialogue.",
        "Summarize the actual events in chronological order, important characters and visuals, and why each event matters.",
        "Use absolute source-video timestamps by adding " + start.toFixed(2) + " seconds to timestamps within this segment.",
        "Mention continuity with the previous segment only if the footage supports it. Return a concise, detailed recap analysis suitable for generating a Myanmar narration."
      ].join("\n\n");

      let analysisResponse;
      try {
        analysisResponse = await GEMINI.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ role: "user", parts: [
            { fileData: { fileUri: videoFile.uri, mimeType: videoFile.mimeType || "video/mp4" } },
            { text: prompt }
          ] }]
        });
      } catch (primaryError) {
        if (GEMINI_MODEL === "gemini-2.5-flash") throw primaryError;
        analysisResponse = await GEMINI.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [
            { fileData: { fileUri: videoFile.uri, mimeType: videoFile.mimeType || "video/mp4" } },
            { text: prompt }
          ] }]
        });
      }

      const analysis = String(analysisResponse.text || "").trim();
      if (!analysis) throw new Error("ဗီဒီယိုအပိုင်း " + (i + 1) + " အတွက် AI analysis မရရှိပါ။");
      segments.push({
        index: i + 1,
        start: Number(start.toFixed(3)),
        end: Number((start + length).toFixed(3)),
        duration: Number(length.toFixed(3)),
        analysis
      });
      console.log("CHUNK ANALYZED:", i + 1, "/", chunkCount, "source seconds", start, "-", start + length);
      // Release the local chunk immediately; retain only its textual recap.
      removeTempFile(chunkPath);
    }

    return res.json({
      ok: true,
      key,
      sourceDuration: Number(duration.toFixed(3)),
      chunkDuration: Number(chunkDuration.toFixed(3)),
      segments,
      analysis: segments.map(s => "[SEGMENT " + s.index + " | " + s.start + "–" + s.end + " sec]\n" + s.analysis).join("\n\n")
    });
  } catch (error) {
    console.error("CHUNKED VIDEO ANALYSIS ERROR:", error?.stack || error);
    if (!res.headersSent) return res.status(500).json({
      ok: false,
      error: "Chunked video analysis failed",
      message: String(error?.message || error).slice(0, 1000)
    });
  } finally {
    for (const file of temporaryFiles) removeTempFile(file);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});


/* =========================================================
   DELETE R2 VIDEO
========================================================= */

app.post(
  "/api/delete-video",
  async (req, res) => {

    try {

      const {
        key
      } =
        req.body || {};


      if (!key) {

        return res.status(400).json({

          ok:
            false,

          error:
            "R2 video key is required"

        });

      }


      if (
        !String(key).startsWith(
          "uploads/"
        )
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "Invalid video key"

        });

      }


      await R2.send(
        new DeleteObjectCommand({

          Bucket:
            BUCKET,

          Key:
            key

        })
      );


      res.json({

        ok:
          true,

        key,

        deleted:
          true

      });


    } catch (error) {

      console.error(
        "DELETE VIDEO ERROR:",
        error
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Failed to delete video",

        message:
          error.message

      });

    }

  }
);


/* =========================================================
   OLD SINGLE UPLOAD URL
========================================================= */

app.get(
  "/api/upload-url-get",
  async (req, res) => {

    try {

      const {
        filename,
        contentType
      } =
        req.query;


      if (!filename) {

        return res.status(400).json({

          ok:
            false,

          error:
            "filename is required"

        });

      }


      const safeName =
        safeFilename(
          filename
        );


      const key =
        "uploads/" +
        Date.now() +
        "-" +
        safeName;


      const command =
        new PutObjectCommand({

          Bucket:
            BUCKET,

          Key:
            key,

          ContentType:
            contentType ||
            "video/mp4"

        });


      const uploadUrl =
        await getSignedUrl(
          R2,
          command,
          {
            expiresIn:
              3600
          }
        );


      res.json({

        ok:
          true,

        uploadUrl,

        key,

        bucket:
          BUCKET

      });


    } catch (error) {

      console.error(
        "SIGNED URL ERROR:",
        error
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Failed to create upload URL"

      });

    }

  }
);

/* =========================================================
   GEMINI RECAP SCRIPT GENERATION
========================================================= */

app.post(
  "/api/generate-script",
  async (req, res) => {

    try {

      if (!GEMINI) {

        return res.status(500).json({

          ok: false,

          error:
            "GEMINI_API_KEY is not configured"

        });

      }


      const {
        analysis,
        recapStyle,
        voice
      } = req.body || {};


      if (!analysis) {

        return res.status(400).json({

          ok: false,

          error:
            "Gemini analysis is required"

        });

      }


      const style =
        recapStyle ||
        "Movie Recap";


      const selectedVoice =
        voice ||
        "Myanmar Male 01";


      const scriptPrompt = `

You are HKUN AI, a professional
Myanmar Original Movie Recap Script Writer.

Write a natural Myanmar-language
movie recap narration script based
ONLY on the confirmed video analysis
below.

IMPORTANT RULES:

1. Do NOT invent events.
2. Do NOT invent characters.
3. Do NOT invent locations.
4. Do NOT invent relationships.
5. Do NOT add information that is
   not supported by the video analysis.
6. Keep the original chronology.
7. Maintain story continuity.
8. Do NOT write editing instructions.
9. Do NOT write camera instructions.
10. Do NOT write subtitle instructions.
11. Do NOT write timestamps in the
    narration unless they are necessary.
12. The result must sound like a
    professional Myanmar Movie Recap
    narrator speaking naturally.
13. Do not simply translate dialogue.
14. Summarize and explain the story
    in original Myanmar narration.
15. Keep important story information.
16. Do not skip important events.

RECAP STYLE:
${style}

VOICE:
${selectedVoice}

VIDEO ANALYSIS:
${analysis}

OUTPUT:

Return ONLY the Myanmar narration
script.

The script must be continuous,
natural and easy for Myanmar TTS
to pronounce.

`;

      const result =
        await GEMINI.models.generateContent({

          model:
            GEMINI_MODEL,

          contents:
            scriptPrompt

        });


      const scriptText =
        result.text || "";


      if (!scriptText.trim()) {

        throw new Error(
          "Gemini returned an empty recap script"
        );

      }


      res.json({

        ok: true,

        model:
          GEMINI_MODEL,

        recapStyle:
          style,

        voice:
          selectedVoice,

        script:
          scriptText,

        message:
          "Myanmar recap script generated"

      });


    } catch (error) {

      console.error(
        "GEMINI SCRIPT ERROR:",
        error
      );


      res.status(500).json({

        ok: false,

        error:
          "Failed to generate Myanmar recap script",

        message:
          error.message

      });

    }

  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "SERVER ERROR:",
      error
    );


    if (
      error.code ===
      "LIMIT_FILE_SIZE"
    ) {

      return res.status(413).json({

        ok:
          false,

        error:
          "Upload part is larger than 32 MB"

      });

    }


    res.status(500).json({

      ok:
        false,

      error:
        error.message ||
        "Internal server error"

    });

  }
);


/* =========================================================
   CLEAN EXPIRED MULTIPART SESSIONS
========================================================= */

setInterval(
  async () => {

    const now =
      Date.now();


    for (
      const [
        uploadId,
        session
      ]
      of multipartSessions
    ) {

      /*
        3 hour expiration.
      */

      if (
        now -
        session.createdAt >
        3 *
        60 *
        60 *
        1000
      ) {

        try {

          await R2.send(
            new AbortMultipartUploadCommand({

              Bucket:
                BUCKET,

              Key:
                session.key,

              UploadId:
                uploadId

            })
          );


        } catch (error) {

          console.error(
            "Expired upload cleanup error:",
            error
          );

        }


        multipartSessions.delete(
          uploadId
        );

      }

    }

  },
  10 *
  60 *
  1000
);


/* =========================================================
   FINAL MP4 RENDERING
   Receives the generated narration and SRT, combines them
   with the source video stored in R2, then saves the MP4 to R2.
========================================================= */

const renderUpload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1,
    fields: 10
  }
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg binary is unavailable"));
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    child.on("error", error => reject(new Error("Could not start FFmpeg: " + error.message)));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const reason = signal ? "signal " + signal : "code " + code;
      reject(new Error("FFmpeg exited with " + reason + ": " + (stderr.slice(-3500) || "No FFmpeg diagnostic output; the hosting instance may have terminated the render process.")));
    });
  });
}

// Generate a source-timestamp scene plan aligned to the actual Myanmar narration.
app.post("/api/scene-plan", async (req, res) => {
  try {
    if (!GEMINI) return res.status(503).json({ ok: false, error: "GEMINI_API_KEY is not configured" });
    const body = req.body || {};
    const analysis = String(body.analysis || "");
    const script = String(body.script || "");
    const duration = Number(body.audioDuration);
    if (!analysis.trim() || !script.trim()) return res.status(400).json({ ok: false, error: "Video analysis and narration script are required" });
    if (!Number.isFinite(duration) || duration < 1 || duration > 7200) return res.status(400).json({ ok: false, error: "Valid narration duration is required" });
    const prompt = [
      "Return ONLY JSON: {\"scenes\":[{\"start\":0,\"end\":5,\"narration\":\"phrase\"}]}.",
      "Create a movie recap edit plan matching the narration to source video scenes.",
      "Source analysis with source-video timestamps:", analysis.slice(0, 24000),
      "Narration script:", script.slice(0, 18000),
      "Narration audio duration seconds: " + duration.toFixed(2),
      "Use only source timestamps explicitly supported by the analysis. start/end are SOURCE video seconds, end > start. Choose distinct relevant scenes in story order. Usually 5-15 scenes. Return valid JSON only."
    ].join("\n\n");
    let response;
    try { response = await GEMINI.models.generateContent({ model: GEMINI_MODEL, contents: prompt }); }
    catch (e) { response = await GEMINI.models.generateContent({ model: "gemini-2.5-flash", contents: prompt }); }
    const raw = String(response.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.scenes)) throw new Error("No scenes array returned");
    const scenes = parsed.scenes.slice(0, 12).map(s => ({ start: Number(s.start), end: Number(s.end), narration: String(s.narration || "").slice(0, 400) })).filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end - s.start >= 0.5);
    if (!scenes.length) throw new Error("No valid scene timestamps returned");
    scenes.sort((a, b) => a.start - b.start);
    console.log("SCENE PLAN CREATED:", scenes.length, "scenes");
    return res.json({ ok: true, scenes });
  } catch (error) {
    console.error("SCENE PLAN ERROR:", error?.stack || error);
    return res.status(500).json({ ok: false, error: "Could not create narration-matched scene plan", message: String(error?.message || error).slice(0, 800) });
  }
});

app.post("/api/render-video", renderUpload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const sourcePath = path.join(TEMP_DIR, "hkun-source-" + crypto.randomUUID() + ".mp4");
  const subtitlePath = path.join(TEMP_DIR, "hkun-subtitles-" + crypto.randomUUID() + ".srt");
  const outputPath = path.join(TEMP_DIR, "hkun-final-" + crypto.randomUUID() + ".mp4");

  try {
    const key = String(req.body?.key || "");
    const subtitle = String(req.body?.subtitle || "").replace(/^\uFEFF/, "");
    const audioDuration = Number(req.body?.audioDuration);
    const requestedVolume = Number(req.body?.audioVolume ?? 1);
    const audioVolume = Number.isFinite(requestedVolume) ? Math.max(0, Math.min(2, requestedVolume)) : 1;
    let scenePlan = [];
    try {
      const rawPlan = req.body?.scenePlan;
      const parsedPlan = rawPlan ? JSON.parse(String(rawPlan)) : null;
      if (Array.isArray(parsedPlan)) scenePlan = parsedPlan.slice(0, 40).map(s => ({ start: Number(s.start), end: Number(s.end) })).filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start);
    } catch (planError) { console.warn("Invalid scene plan; using full source video:", planError.message); }

    if (!key.startsWith("uploads/")) {
      return res.status(400).json({ ok: false, error: "A valid uploaded video key is required" });
    }
    if (!req.file || !req.file.size) {
      return res.status(400).json({ ok: false, error: "Generated narration audio is required" });
    }
    if (!subtitle.trim() || subtitle.length > 2_000_000) {
      return res.status(400).json({ ok: false, error: "Valid SRT subtitle text is required (maximum 2 MB)" });
    }

    fs.writeFileSync(subtitlePath, subtitle, "utf8");

    console.log("FINAL RENDER START:", key, "audioBytes:", req.file.size, "audioPath:", audioPath);
    // Download the source locally first. Streaming a long signed R2 URL directly
    // into FFmpeg can fail on slow/free instances and hides useful network errors.
    await downloadR2Object(key, sourcePath);
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.size) throw new Error("Source video download is empty");

    // Low-memory render: decode the source only once to avoid FFmpeg OOM on Render.
    // The generated narration is passed through unchanged; only video timing is adjusted.
    const probe = spawnSync(ffmpegPath, ["-hide_banner", "-i", sourcePath], { encoding: "utf8", timeout: 20000 });
    const probeText = String(probe.stderr || "") + "\n" + String(probe.stdout || "");
    const match = probeText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    const sourceDuration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("Could not determine source video duration");
    if (!Number.isFinite(audioDuration) || audioDuration <= 0 || audioDuration > 7200) throw new Error("Invalid narration duration");

    // Concatenate selected source scenes in planned order before synchronizing
    // the complete video to the single continuous narration track.
    const effectiveScenes = (scenePlan.length ? scenePlan : [{ start: 0, end: sourceDuration }])
      .map(s => ({
        start: Math.max(0, Math.min(sourceDuration, s.start)),
        end: Math.max(0, Math.min(sourceDuration, s.end))
      }))
      .filter(s => s.end > s.start + 0.05)
      .slice(0, 40);
    if (!effectiveScenes.length) effectiveScenes.push({ start: 0, end: sourceDuration });
    const totalSelectedDuration = effectiveScenes.reduce((sum, s) => sum + s.end - s.start, 0);
    if (!(totalSelectedDuration > 0)) throw new Error("Scene plan contains no usable video segments");
    const scale = audioDuration / totalSelectedDuration;
    const filterParts = [];
    if (effectiveScenes.length === 1) {
      const s = effectiveScenes[0];
      filterParts.push("[0:v:0]trim=start=" + s.start.toFixed(3) + ":end=" + s.end.toFixed(3) + ",setpts=PTS-STARTPTS[vjoined]");
    } else {
      const sourceLabels = effectiveScenes.map((_, i) => "[src" + i + "]");
      filterParts.push("[0:v:0]split=" + effectiveScenes.length + sourceLabels.join(""));
      effectiveScenes.forEach((s, i) => {
        filterParts.push(sourceLabels[i] + "trim=start=" + s.start.toFixed(3) +
          ":end=" + s.end.toFixed(3) + ",setpts=PTS-STARTPTS[v" + i + "]");
      });
      filterParts.push(effectiveScenes.map((_, i) => "[v" + i + "]").join("") +
        "concat=n=" + effectiveScenes.length + ":v=1:a=0[vjoined]");
    }
    filterParts.push("[vjoined]setpts=(PTS-STARTPTS)*" + scale.toFixed(8) +
      ",tpad=stop_mode=clone:stop_duration=1,trim=duration=" + audioDuration.toFixed(3) +
      ",setpts=PTS-STARTPTS[vout]");
    const args = [
      "-hide_banner", "-y", "-loglevel", "warning",
      "-i", sourcePath, "-i", audioPath, "-f", "srt", "-i", subtitlePath,
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]", "-map", "1:a:0", "-map", "2:0", "-t", audioDuration.toFixed(3),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-threads", "1", "-pix_fmt", "yuv420p",
      "-af", "volume=" + audioVolume.toFixed(2),
      "-c:a", "aac", "-b:a", "128k", "-c:s", "mov_text", "-max_muxing_queue_size", "512",
      "-map_metadata", "0", "-movflags", "+faststart", outputPath
    ];
    console.log("SEGMENT-CONCAT FINAL RENDER:", {
      sourceDuration, audioDuration, totalSelectedDuration, scale, audioVolume,
      sceneCount: effectiveScenes.length
    });
    await runFFmpeg(args);

    const stat = fs.statSync(outputPath);
    if (!stat.size || stat.size < 1024) throw new Error("Rendered MP4 is empty or invalid");

    const outputKey = "outputs/hkun-recap-" + Date.now() + "-" + crypto.randomUUID() + ".mp4";
    await R2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: outputKey,
      Body: fs.createReadStream(outputPath),
      ContentLength: stat.size,
      ContentType: "video/mp4"
    }));

    const downloadUrl = await getSignedUrl(
      R2,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: outputKey,
        ResponseContentType: "video/mp4",
        ResponseContentDisposition: 'attachment; filename="hkun-ai-recap.mp4"'
      }),
      { expiresIn: 86400 }
    );

    console.log("FINAL RENDER COMPLETE:", outputKey, "bytes:", stat.size);
    return res.json({
      ok: true,
      key: outputKey,
      downloadUrl,
      sizeBytes: stat.size,
      expiresInSeconds: 86400,
      message: "MP4 rendered with Myanmar narration and embedded subtitles"
    });
  } catch (error) {
    console.error("FINAL RENDER ERROR:", error?.stack || error);
    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: "Final MP4 rendering failed",
        message: String(error?.message || error).slice(0, 1200)
      });
    }
  } finally {
    for (const file of [audioPath, sourcePath, subtitlePath, outputPath]) {
      if (file) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
    }
  }
});


/* =========================================================
MYANMAR TEXT TO SPEECH
========================================================= */

const { EdgeTTS } = require("node-edge-tts");

app.post("/api/tts", async (req, res) => {
  let tempDir;

  try {
    const { text, voice, speed, voicePitch } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ ok: false, error: "Myanmar text is required" });
    }
    if (text.length > 20000) {
      return res.status(400).json({ ok: false, error: "စာလုံး ၂၀,၀၀၀ ထက်ကျော်နေပါတယ်။ အပိုင်းခွဲပါ။" });
    }

    const selectedVoice =
      voice === "Myanmar Female 01" || voice === "Myanmar Female 02"
        ? "my-MM-NilarNeural"
        : "my-MM-ThihaNeural";
    const rateValue = Number(speed ?? 1);
    const safeRate = Number.isFinite(rateValue) ? Math.max(0.8, Math.min(1.2, rateValue)) : 1;
    const rate = `${Math.round((safeRate - 1) * 100)}%`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hkun-tts-"));
    const audioPath = path.join(tempDir, "speech.mp3");

    // Retry once for transient Edge TTS websocket failures.
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const tts = new EdgeTTS({
          voice: selectedVoice,
          lang: "my-MM",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          rate,
          timeout: 90000
        });
        await tts.ttsPromise(text.trim(), audioPath);

        const stat = fs.statSync(audioPath);
        if (!stat.isFile() || stat.size < 100) {
          throw new Error("TTS returned an empty or invalid audio file");
        }
        const requestedPitch = Number(voicePitch ?? 1);
        const pitchFactor = Number.isFinite(requestedPitch) ? Math.max(0.85, Math.min(1.20, requestedPitch)) : 1;
        if (pitchFactor !== 1) {
          const pitchedPath = path.join(tempDir, "speech-pitched.mp3");
          const pitchResult = spawnSync(ffmpegPath, [
            "-y", "-hide_banner", "-loglevel", "error",
            "-i", audioPath,
            "-af", `asetrate=24000*${pitchFactor},aresample=24000,atempo=${(1 / pitchFactor).toFixed(5)}`,
            "-codec:a", "libmp3lame", "-b:a", "48k",
            pitchedPath
          ], { encoding: "utf8", timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
          if (pitchResult.error || pitchResult.status !== 0 || !fs.existsSync(pitchedPath) || fs.statSync(pitchedPath).size < 100) {
            throw new Error("Voice style audio processing failed: " + (pitchResult.error?.message || pitchResult.stderr || pitchResult.status));
          }
          fs.renameSync(pitchedPath, audioPath);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700));
      }
    }
    if (lastError) throw lastError;

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", fs.statSync(audioPath).size);
    res.setHeader("Content-Disposition", 'attachment; filename="hkun-myanmar-voice.mp3"');
    res.sendFile(audioPath, err => {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (err) console.error("Myanmar TTS audio delivery error:", err);
    });
  } catch (error) {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    console.error("Myanmar TTS error:", error?.stack || error);
    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        error: "အသံထုတ်မရပါ။ Edge TTS ချိတ်ဆက်မှုကို စစ်ပြီး ပြန်ကြိုးစားပါ။",
        detail: process.env.NODE_ENV === "production" ? undefined : String(error?.message || error)
      });
    }
  }
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "HKUN AI Backend running on port " +
      PORT
    );

    console.log(
      "Gemini configured: " +
      Boolean(
        GEMINI_API_KEY
      )
    );

    console.log(
      "Gemini model: " +
      GEMINI_MODEL
    );

  }
);
