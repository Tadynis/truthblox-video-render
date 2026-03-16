const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const WORK_DIR = path.join(__dirname, "tmp");
const OUTPUT_DIR = path.join(__dirname, "public", "videos");

fs.ensureDirSync(WORK_DIR);
fs.ensureDirSync(OUTPUT_DIR);

app.use("/videos", express.static(OUTPUT_DIR));

function escapeText(text = "") {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\n/g, " ");
}

async function downloadImage(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  try {
    const {
      image,
      line1 = "",
      line2 = "",
      cta = "",
      duration = 6,
      format = "1080x1920",
    } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Missing image URL" });
    }

    const [width, height] = format.split("x").map(Number);
    if (!width || !height) {
      return res.status(400).json({ error: "Invalid format, expected WIDTHxHEIGHT" });
    }

    const jobId = uuidv4();
    const inputImagePath = path.join(WORK_DIR, `${jobId}.png`);
    const outputVideoName = `${jobId}.mp4`;
    const outputVideoPath = path.join(OUTPUT_DIR, outputVideoName);

    await downloadImage(image, inputImagePath);

    const safeLine1 = escapeText(line1);
    const safeLine2 = escapeText(line2);
    const safeCta = escapeText(cta);

    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      `zoompan=z='min(zoom+0.0008,1.08)':d=${Math.floor(Number(duration) * 25)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=25`,
      `drawtext=text='${safeLine1}':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-text_w)/2:y=h*0.15`,
      `drawtext=text='${safeLine2}':fontcolor=white:fontsize=42:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-text_w)/2:y=h*0.32`,
      `drawtext=text='${safeCta}':fontcolor=white:fontsize=46:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h*0.80`,
    ];

    await new Promise((resolve, reject) => {
      ffmpeg(inputImagePath)
        .loop(Number(duration))
        .videoFilters(filters)
        .outputOptions([
          "-t", String(duration),
          "-pix_fmt", "yuv420p",
          "-c:v", "libx264",
          "-movflags", "+faststart"
        ])
        .size(`${width}x${height}`)
        .fps(25)
        .save(outputVideoPath)
        .on("end", resolve)
        .on("error", reject);
    });

    const videoUrl = `${BASE_URL}/videos/${outputVideoName}`;

    return res.json({
      video_url: videoUrl,
      status: "video_ready",
    });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({
      error: "Render failed",
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Truthblox video render server listening on port ${PORT}`);
});
