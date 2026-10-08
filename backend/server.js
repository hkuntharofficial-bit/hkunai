const express = require("express");
const cors = require("cors");

const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const {
  getSignedUrl
} = require("@aws-sdk/s3-request-presigner");

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {

  res.header(
    "Access-Control-Allow-Origin",
    "https://hkuntharofficial-bit.github.io"
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

const PORT = process.env.PORT || 3000;

const R2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.R2_BUCKET || "hkunai-videos";

app.get("/", (req, res) => {
  res.json({
    service: "HKUN AI Backend",
    status: "online"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "HKUN AI Backend"
  });
});

app.get("/api/upload-url-get", async (req, res) => {
  try {
    const { filename, contentType } = req.query;

    if (!filename) {
      return res.status(400).json({
        error: "filename is required"
      });
    }

    const safeName = String(filename)
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    const key =
      `uploads/${Date.now()}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType || "video/mp4"
    });

    const uploadUrl = await getSignedUrl(
      R2,
      command,
      { expiresIn: 3600 }
    );

    res.json({
      ok: true,
      uploadUrl,
      key,
      bucket: BUCKET
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Failed to create upload URL"
    });
  }
});

app.post("/api/upload-url", async (req, res) => {
  try {
    const { filename, contentType } = req.body;

    if (!filename) {
      return res.status(400).json({
        error: "filename is required"
      });
    }

    const safeName = filename
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    const key =
      `uploads/${Date.now()}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType || "video/mp4"
    });

    const uploadUrl = await getSignedUrl(
      R2,
      command,
      { expiresIn: 3600 }
    );

    res.json({
      ok: true,
      uploadUrl,
      key,
      bucket: BUCKET
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Failed to create upload URL"
    });
  }
});

app.listen(PORT, () => {
  console.log(`HKUN AI Backend running on port ${PORT}`);
});
