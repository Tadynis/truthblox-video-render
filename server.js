const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const OUTPUT_DIR = path.join("/tmp", "videos");
fs.ensureDirSync(OUTPUT_DIR);

app.use("/videos", express.static(OUTPUT_DIR));

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.trim();
}

async function downloadFile(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 60000,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function parseFormat(format) {
  const fallback = { width: 720, height: 1280 };

  if (!format || typeof format !== "string") return fallback;

  const match = format.match(/^(\d+)x(\d+)$/);
  if (!match) return fallback;

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "truthblox-video-render",
    endpoint: "/render",
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  const tempFiles = [];

  try {
    const {
      image,
      frame_1_url,
      frame_2_url,

      cta_image_url,
      cta_url,
      cta_duration = 3,

      duration = 6,
      format = "720x1280",
      content_id = "",
    } = req.body;

    const safeSingleImageUrl = normalizeUrl(image);
    const safeFrame1Url = normalizeUrl(frame_1_url);
    const safeFrame2Url = normalizeUrl(frame_2_url);
    const safeCtaUrl = normalizeUrl(cta_image_url || cta_url);

    const { width, height } = parseFormat(format);

    const mainDuration = Number(duration) || 6;
    const ctaDuration = Number(cta_duration) || 3;

    const jobId = content_id || uuidv4();

    const frame1Path = path.join("/tmp", `${jobId}_frame1.jpg`);
    const frame2Path = path.join("/tmp", `${jobId}_frame2.jpg`);
    const ctaPath = path.join("/tmp", `${jobId}_cta.jpg`);
    const listPath = path.join("/tmp", `${jobId}_list.txt`);
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

    tempFiles.push(frame1Path, frame2Path, ctaPath, listPath);

    if (safeFrame1Url && safeFrame2Url) {
      await downloadFile(safeFrame1Url, frame1Path);
      await downloadFile(safeFrame2Url, frame2Path);
    } else if (safeSingleImageUrl) {
      await downloadFile(safeSingleImageUrl, frame1Path);
      await downloadFile(safeSingleImageUrl, frame2Path);
    } else {
      return res.status(400).json({
        ok: false,
        error: "Missing image, frame_1_url or frame_2_url",
      });
    }

    const frameDuration = mainDuration / 2;

    let listContent = "";

    listContent += `file '${frame1Path}'\n`;
    listContent += `duration ${frameDuration}\n`;

    listContent += `file '${frame2Path}'\n`;
    listContent += `duration ${frameDuration}\n`;

    if (safeCtaUrl) {
      await downloadFile(safeCtaUrl, ctaPath);

      listContent += `file '${ctaPath}'\n`;
      listContent += `duration ${ctaDuration}\n`;
      listContent += `file '${ctaPath}'\n`;
    } else {
      listContent += `file '${frame2Path}'\n`;
    }

    await fs.writeFile(listPath, listContent);

    await runFfmpeg(
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions([
          "-vf",
          `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
          "-r 30",
          "-c:v libx264",
          "-preset veryfast",
          "-movflags +faststart",
        ])
        .output(outputPath)
    );

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    return res.json({
      ok: true,
      video_url: `${baseUrl}/videos/${jobId}.mp4`,
      content_id: jobId,
      used_cta: Boolean(safeCtaUrl),
      duration_seconds: safeCtaUrl ? mainDuration + ctaDuration : mainDuration,
      format: `${width}x${height}`,
    });
  } catch (error) {
    console.error("Render error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown render error",
    });
  } finally {
    for (const file of tempFiles) {
      try {
        if (await fs.pathExists(file)) {
          await fs.remove(file);
        }
      } catch (e) {
        console.warn("Failed to remove temp file:", file);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
