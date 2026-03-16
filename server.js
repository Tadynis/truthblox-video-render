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
const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_DIR = path.join(PUBLIC_DIR, "videos");

// Užtikriname, kad visi reikalingi katalogai egzistuoja
fs.ensureDirSync(WORK_DIR);
fs.ensureDirSync(PUBLIC_DIR);
fs.ensureDirSync(OUTPUT_DIR);

app.use("/videos", express.static(OUTPUT_DIR));

async function downloadImage(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 30000,
    maxRedirects: 5,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.get("/", (_req, res) => {
  res.json({
    service: "truthblox-video-render",
    status: "ok",
    endpoints: {
      health: "/health",
      render: "/render",
      videos: "/videos/:file",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  let inputImagePath = null;

  try {
    const {
      image,
      duration = 6,
      format = "1080x1920",
    } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Missing image URL" });
    }

    const [width, height] = format.split("x").map(Number);
    if (!width || !height) {
      return res.status(400).json({
        error: "Invalid format, expected WIDTHxHEIGHT",
      });
    }

    const safeDuration = Number(duration);
    if (!safeDuration || safeDuration <= 0) {
      return res.status(400).json({
        error: "Invalid duration",
      });
    }

    const jobId = uuidv4();
    inputImagePath = path.join(WORK_DIR, `${jobId}.png`);
    const outputVideoName = `${jobId}.mp4`;
    const outputVideoPath = path.join(OUTPUT_DIR, outputVideoName);

    // Dar kartą užtikriname, kad output katalogas egzistuoja runtime metu
    fs.ensureDirSync(OUTPUT_DIR);

    await downloadImage(image, inputImagePath);

    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      `zoompan=z='min(zoom+0.0008,1.08)':d=${Math.floor(safeDuration * 25)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=25`,
    ];

    await new Promise((resolve, reject) => {
      ffmpeg(inputImagePath)
        .loop(safeDuration)
        .videoFilters(filters)
        .outputOptions([
          "-t", String(safeDuration),
          "-pix_fmt", "yuv420p",
          "-c:v", "libx264",
          "-movflags", "+faststart",
        ])
        .size(`${width}x${height}`)
        .fps(25)
        .on("start", (commandLine) => {
          console.log("FFmpeg start:", commandLine);
        })
        .on("stderr", (stderrLine) => {
          console.log("FFmpeg stderr:", stderrLine);
        })
        .on("end", resolve)
        .on("error", (err) => {
          reject(err);
        })
        .save(outputVideoPath);
    });

    const videoUrl = `${BASE_URL}/videos/${outputVideoName}`;

    // Ištrinam laikiną paveikslėlį po sėkmingo renderio
    if (inputImagePath && (await fs.pathExists(inputImagePath))) {
      await fs.remove(inputImagePath);
    }

    return res.json({
      video_url: videoUrl,
      status: "video_ready",
    });
  } catch (error) {
    console.error("Render error:", error);

    // Bandome išvalyti laikiną failą ir klaidos atveju
    try {
      if (inputImagePath && (await fs.pathExists(inputImagePath))) {
        await fs.remove(inputImagePath);
      }
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }

    return res.status(500).json({
      error: "Render failed",
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Truthblox video render server listening on port ${PORT}`);
  console.log(`WORK_DIR: ${WORK_DIR}`);
  console.log(`OUTPUT_DIR: ${OUTPUT_DIR}`);
});
