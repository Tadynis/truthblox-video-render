const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");
const { exec, execFile } = require("child_process");

// SVARBU:
// nenaudojame ffmpeg-static, nes tavo buildas gali neturėti drawtext.
// Naudojame system ffmpeg arba FFMPEG_PATH iš env.
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Render aplinkoje saugiausia naudoti /tmp
const WORK_DIR = "/tmp";
const OUTPUT_DIR = "/tmp/videos";

// Užtikriname, kad reikalingi katalogai egzistuoja
fs.ensureDirSync(WORK_DIR);
fs.ensureDirSync(OUTPUT_DIR);

app.use("/videos", express.static(OUTPUT_DIR));

function normalizeUrl(value) {
  if (!value) return "";

  let url = String(value).trim();

  // pašalina visus escape simbolius
  url = url.replace(/\\/g, "");

  // pašalina visas kabutes iš pradžios
  while (url.startsWith('"') || url.startsWith("'")) {
    url = url.substring(1);
  }

  // pašalina visas kabutes iš galo
  while (url.endsWith('"') || url.endsWith("'")) {
    url = url.slice(0, -1);
  }

  return url.trim();
}

function normalizeOverlayText(value, fallback = "") {
  const text = String(value ?? fallback)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return text || fallback;
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (!text) return "";

  if (text.length <= maxLength) return text;

  return text.slice(0, maxLength).trim();
}

function escapeFilterValue(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/=/g, "\\=");
}

function getFontPath() {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Font file not found. Checked: ${candidates.join(", ")}`
  );
}

async function writeTextFile(filePath, text) {
  // ffmpeg drawtext per textfile mėgsta paprastą utf-8 tekstą
  await fs.writeFile(filePath, String(text || ""), "utf8");
}

async function downloadFile(url, outputPath) {
  console.log("RAW URL >>>", url);

  const safeUrl = normalizeUrl(url);
  console.log("NORMALIZED URL >>>", safeUrl);

  if (!safeUrl) {
    throw new Error("downloadFile: empty URL");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(safeUrl);
  } catch (err) {
    throw new Error(`downloadFile: invalid URL -> ${safeUrl}`);
  }

  console.log("Downloading file from:", parsedUrl.toString());
  console.log("Downloading file to:", outputPath);

  const response = await axios({
    method: "GET",
    url: parsedUrl.toString(),
    responseType: "stream",
    timeout: 60000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0 (Truthblox Video Render)",
      Accept: "*/*",
    },
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  const exists = await fs.pathExists(outputPath);
  if (!exists) {
    throw new Error(`downloadFile: file was not written -> ${outputPath}`);
  }

  const stats = await fs.stat(outputPath);
  if (!stats.size || stats.size <= 0) {
    throw new Error(`downloadFile: downloaded file is empty -> ${outputPath}`);
  }

  console.log("Downloaded file size:", stats.size);
}

async function cleanupFiles(files = []) {
  for (const file of files) {
    try {
      if (file && (await fs.pathExists(file))) {
        await fs.remove(file);
      }
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }
  }
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log("Running ffmpeg:", ffmpegPath, args.join(" "));

    execFile(
      ffmpegPath,
      args,
      { maxBuffer: 1024 * 1024 * 20 },
      (error, stdout, stderr) => {
        if (stderr) {
          console.log("FFmpeg stderr:", stderr);
        }

        if (error) {
          console.error("FFmpeg args failed:", args);
          console.error("FFmpeg stderr:", stderr);
          return reject(new Error(stderr || error.message));
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

app.get("/", (_req, res) => {
  res.json({
    service: "truthblox-video-render",
    status: "ok",
    endpoints: {
      health: "/health",
      test_ffmpeg: "/test-ffmpeg",
      render: "/render",
      overlay_video: "/overlay-video",
      videos: "/videos/:file",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "truthblox-video-render",
    ffmpegPath,
  });
});

app.get("/test-ffmpeg", (_req, res) => {
  exec(`${ffmpegPath} -version`, (error, stdout, stderr) => {
    if (error) {
      console.error("ffmpeg test error:", error);
      return res.status(500).json({
        ok: false,
        error: "ffmpeg execution failed",
        details: error.message,
        stderr,
        ffmpegPath,
      });
    }

    return res.json({
      ok: true,
      message: "ffmpeg works",
      ffmpegPath,
      output: stdout,
    });
  });
});

// Senas endpointas: image -> video
app.post("/render", async (req, res) => {
  let inputImagePath = null;

  try {
    const { image, duration = 6, format = "1080x1920" } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Missing image URL" });
    }

    const safeImageUrl = normalizeUrl(image);

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

    fs.ensureDirSync(OUTPUT_DIR);

    await downloadFile(safeImageUrl, inputImagePath);

    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      `zoompan=z='min(zoom+0.0008,1.08)':d=${Math.floor(
        safeDuration * 25
      )}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=25`,
    ];

    await new Promise((resolve, reject) => {
      ffmpeg(inputImagePath)
        .loop(safeDuration)
        .videoFilters(filters)
        .outputOptions([
          "-t",
          String(safeDuration),
          "-pix_fmt",
          "yuv420p",
          "-c:v",
          "libx264",
          "-movflags",
          "+faststart",
          "-an",
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
          console.error("FFmpeg render error:", err);
          reject(err);
        })
        .save(outputVideoPath);
    });

    const videoUrl = `${BASE_URL}/videos/${outputVideoName}`;

    if (inputImagePath && (await fs.pathExists(inputImagePath))) {
      await fs.remove(inputImagePath);
    }

    return res.json({
      video_url: videoUrl,
      status: "video_ready",
      ffmpeg_path: ffmpegPath,
    });
  } catch (error) {
    console.error("Render error:", error);

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
      ffmpeg_path: ffmpegPath,
    });
  }
});

// Naujas endpointas: video + line1 + line2 + CTA
app.post("/overlay-video", async (req, res) => {
  const tempFiles = [];

  try {
    const {
      video,
      line1 = "LINE1",
      line2 = "LINE2",
      cta = "truthblox.com",
      width = 720,
      height = 1280,
      fontsize = 48,
    } = req.body;

    console.log("Overlay request body video RAW >>>", video);

    const safeVideoUrl = normalizeUrl(video);
    console.log("Overlay request body video NORMALIZED >>>", safeVideoUrl);

    if (!safeVideoUrl) {
      return res.status(400).json({ error: "Missing video URL" });
    }

    const safeWidth = Number(width);
    const safeHeight = Number(height);
    const safeFontsize = Number(fontsize);

    if (!safeWidth || !safeHeight) {
      return res.status(400).json({ error: "Invalid width/height" });
    }

    if (!safeFontsize || safeFontsize <= 0) {
      return res.status(400).json({ error: "Invalid fontsize" });
    }

    const safeLine1 = truncateText(normalizeOverlayText(line1, "LINE1"), 40);
    const safeLine2 = truncateText(normalizeOverlayText(line2, "LINE2"), 40);
    const safeCta = truncateText(normalizeOverlayText(cta, "truthblox.com"), 30);

    const jobId = uuidv4();

    const inputPath = path.join(WORK_DIR, `${jobId}-input.mp4`);
    const tempPath = path.join(WORK_DIR, `${jobId}-temp.mp4`);
    const ctaPath = path.join(WORK_DIR, `${jobId}-cta.mp4`);
    const finalPath = path.join(OUTPUT_DIR, `${jobId}-final.mp4`);

    const line1Path = path.join(WORK_DIR, `${jobId}-line1.txt`);
    const line2Path = path.join(WORK_DIR, `${jobId}-line2.txt`);
    const ctaTextPath = path.join(WORK_DIR, `${jobId}-cta.txt`);

    tempFiles.push(
      inputPath,
      tempPath,
      ctaPath,
      line1Path,
      line2Path,
      ctaTextPath
    );

    fs.ensureDirSync(OUTPUT_DIR);

    await downloadFile(safeVideoUrl, inputPath);

    const fontPath = getFontPath();
    const safeFontPath = escapeFilterValue(fontPath);
    const safeLine1Path = escapeFilterValue(line1Path);
    const safeLine2Path = escapeFilterValue(line2Path);
    const safeCtaPath = escapeFilterValue(ctaTextPath);

    await writeTextFile(line1Path, safeLine1);
    await writeTextFile(line2Path, safeLine2);
    await writeTextFile(ctaTextPath, safeCta);

    const overlayFilter =
      `scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=increase,` +
      `crop=${safeWidth}:${safeHeight},` +
      `drawtext=fontfile=${safeFontPath}:textfile=${safeLine1Path}:reload=0:enable='between(t,0,3)':x=(w-text_w)/2:y=h-220:fontsize=${safeFontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20,` +
      `drawtext=fontfile=${safeFontPath}:textfile=${safeLine2Path}:reload=0:enable='between(t,3,6)':x=(w-text_w)/2:y=h-220:fontsize=${safeFontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20`;

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      overlayFilter,
      "-t",
      "6",
      "-r",
      "25",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      tempPath,
    ]);

    const ctaFilter =
      `drawtext=fontfile=${safeFontPath}:textfile=${safeCtaPath}:reload=0:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${safeFontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20`;

    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${safeWidth}x${safeHeight}:d=3:r=25`,
      "-vf",
      ctaFilter,
      "-r",
      "25",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      ctaPath,
    ]);

    await runFfmpeg([
      "-y",
      "-i",
      tempPath,
      "-i",
      ctaPath,
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      finalPath,
    ]);

    const finalUrl = `${BASE_URL}/videos/${path.basename(finalPath)}`;

    await cleanupFiles(tempFiles);

    return res.json({
      ok: true,
      status: "video_ready",
      video_url: finalUrl,
      ffmpeg_path: ffmpegPath,
    });
  } catch (error) {
    console.error("Overlay video error:", error);

    await cleanupFiles(tempFiles);

    return res.status(500).json({
      ok: false,
      error: "Overlay video failed",
      details: error.message,
      ffmpeg_path: ffmpegPath,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Truthblox video render server listening on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`WORK_DIR: ${WORK_DIR}`);
  console.log(`OUTPUT_DIR: ${OUTPUT_DIR}`);
  console.log(`FFMPEG_PATH: ${ffmpegPath}`);
});
