const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
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

app.post("/api/render-video", renderUpload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const sourcePath = path.join(TEMP_DIR, "hkun-source-" + crypto.randomUUID() + ".mp4");
  const subtitlePath = path.join(TEMP_DIR, "hkun-subtitles-" + crypto.randomUUID() + ".srt");
  const outputPath = path.join(TEMP_DIR, "hkun-final-" + crypto.randomUUID() + ".mp4");

  try {
    const key = String(req.body?.key || "");
    const subtitle = String(req.body?.subtitle || "").replace(/^\uFEFF/, "");

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

    console.log("FINAL RENDER START:", key, "audioBytes:", req.file.size);
    // Download the source locally first. Streaming a long signed R2 URL directly
    // into FFmpeg can fail on slow/free instances and hides useful network errors.
    await downloadR2Object(key, sourcePath);
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.size) throw new Error("Source video download is empty");

    await runFFmpeg([
      "-hide_banner", "-y", "-loglevel", "warning",
      "-i", sourcePath,
      "-i", audioPath,
      "-f", "srt", "-i", subtitlePath,
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:0",
      // Keep peak memory low on Render's free instance; 720p is sufficient for recap output.
      "-vf", "scale='min(960,iw)':-2",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
      "-threads", "1",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k",
      "-c:s", "mov_text",
      "-max_muxing_queue_size", "2048",
      "-map_metadata", "-1",
      "-shortest", "-movflags", "+faststart",
      outputPath
    ]);

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
    const { text, voice, speed } = req.body || {};
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
