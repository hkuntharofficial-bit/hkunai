const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const {
  getSignedUrl
} = require("@aws-sdk/s3-request-presigner");

const app = express();

const PORT = process.env.PORT || 3000;

const FRONTEND_ORIGIN =
  "https://hkuntharofficial-bit.github.io";

/* =========================================================
   BASIC MIDDLEWARE
========================================================= */

app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: [
    "GET",
    "POST",
    "OPTIONS"
  ],
  allowedHeaders: [
    "Content-Type"
  ]
}));

app.use(express.json({
  limit: "10mb"
}));

app.use((req, res, next) => {

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
});

/* =========================================================
   R2 CONFIG
========================================================= */

const R2 = new S3Client({
  region: "auto",

  endpoint:
    process.env.R2_ENDPOINT,

  forcePathStyle: true,

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
   TEMP UPLOAD DIRECTORY
========================================================= */

const TEMP_DIR = path.join(
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

const upload = multer({

  dest: TEMP_DIR,

  limits: {

    /*
      32 MB maximum per uploaded part.
      HKUN AI will normally use 16 MB chunks.
    */

    fileSize:
      32 * 1024 * 1024

  }
});

/* =========================================================
   MULTIPART SESSION STORAGE
========================================================= */

/*
  Render process memory ထဲမှာ temporary session သိမ်းမယ်။

  Upload ပြီးတဲ့အထိသာ လိုအပ်ပါတယ်။
*/

const multipartSessions =
  new Map();

/* =========================================================
   HELPERS
========================================================= */

function safeFilename(filename) {

  return String(filename || "video.mp4")
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );
}

function createStorageKey(filename) {

  return (
    "uploads/" +
    Date.now() +
    "-" +
    crypto.randomUUID() +
    "-" +
    safeFilename(filename)
  );
}

function removeTempFile(filePath) {

  if (!filePath) {
    return;
  }

  try {

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

  } catch (error) {

    console.error(
      "Temp cleanup error:",
      error
    );

  }
}

/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {

  res.json({

    service:
      "HKUN AI Backend",

    status:
      "online"

  });

});

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "HKUN AI Backend"

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
      } = req.body || {};

      if (!filename) {

        return res.status(400).json({

          ok: false,

          error:
            "filename is required"

        });

      }

      const size =
        Number(fileSize || 0);

      if (
        !Number.isFinite(size) ||
        size <= 0
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "fileSize is required"

        });

      }

      /*
        120 minute movie support.

        5 GB limit for now.
      */

      if (
        size >
        5 * 1024 * 1024 * 1024
      ) {

        return res.status(413).json({

          ok: false,

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

      /*
        Start R2 multipart upload
      */

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
        await R2.send(command);

      if (!result.UploadId) {

        throw new Error(
          "R2 UploadId was not returned"
        );

      }

      /*
        16 MB default chunk size
      */

      const partSize =
        16 * 1024 * 1024;

      const session = {

        uploadId:
          result.UploadId,

        key,

        filename:
          safeFilename(filename),

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

        ok: true,

        kind:
          "multipart",

        uploadId:
          result.UploadId,

        key,

        partSizeBytes:
          partSize,

        totalParts:
          Math.ceil(
            size / partSize
          )

      });

    } catch (error) {

      console.error(
        "UPLOAD INIT ERROR:",
        error
      );

      res.status(500).json({

        ok: false,

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

    let tempFile = null;

    try {

      if (!req.file) {

        return res.status(400).json({

          ok: false,

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

          ok: false,

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

          ok: false,

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

          ok: false,

          error:
            "Upload session not found"

        });

      }

      /*
        Read temporary chunk
      */

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

      tempFile = null;

      res.json({

        ok: true,

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

        ok: false,

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

          ok: false,

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

          ok: false,

          error:
            "Upload session not found"

        });

      }

      if (
        session.parts.size === 0
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "No uploaded parts found"

        });

      }

      /*
        Sort parts by part number.
      */

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

      /*
        Complete R2 multipart upload
      */

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

      /*
        Session no longer needed.
      */

      multipartSessions.delete(
        uploadId
      );

      res.json({

        ok: true,

        key:
          session.key,

        bucket:
          BUCKET,

        location:
          result.Location || null,

        message:
          "Video uploaded successfully"

      });

    } catch (error) {

      console.error(
        "UPLOAD COMPLETE ERROR:",
        error
      );

      res.status(500).json({

        ok: false,

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

          ok: false,

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

          ok: true,

          aborted: false

        });

      }

      const command =
        new AbortMultipartUploadCommand({

          Bucket:
            BUCKET,

          Key:
            session.key,

          UploadId:
            uploadId

        });

      await R2.send(
        command
      );

      multipartSessions.delete(
        uploadId
      );

      res.json({

        ok: true,

        aborted: true

      });

    } catch (error) {

      console.error(
        "UPLOAD ABORT ERROR:",
        error
      );

      res.status(500).json({

        ok: false,

        error:
          "Failed to abort upload"

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
      } = req.query;

      if (!filename) {

        return res.status(400).json({

          ok: false,

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

        ok: true,

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

        ok: false,

        error:
          "Failed to create upload URL"

      });

    }

  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      error
    );

    if (
      error.code ===
      "LIMIT_FILE_SIZE"
    ) {

      return res.status(413).json({

        ok: false,

        error:
          "Upload part is larger than 32 MB"

      });

    }

    res.status(500).json({

      ok: false,

      error:
        error.message ||
        "Internal server error"

    });

  }
);

/* =========================================================
   CLEAN EXPIRED SESSIONS
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
        3 hour expiration
      */

      if (
        now -
        session.createdAt >
        3 * 60 * 60 * 1000
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
  10 * 60 * 1000
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `HKUN AI Backend running on port ${PORT}`
    );

  }
);
