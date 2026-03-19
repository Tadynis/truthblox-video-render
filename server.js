app.post("/overlay-video", async (req, res) => {
  const tempFiles = [];

  try {
    const {
      video,
      line1 = "LINE1",
      line2 = "LINE2",
      cta = "www.truthblox.com",
      width = 720,
      height = 1280,
      fontsize = 48,
    } = req.body;

    if (!video) {
      return res.status(400).json({ error: "Missing video URL" });
    }

    const safeWidth = Number(width);
    const safeHeight = Number(height);
    const safeFontsize = Number(fontsize);

    if (!safeWidth || !safeHeight) {
      return res.status(400).json({ error: "Invalid width/height" });
    }

    const jobId = uuidv4();

    const inputPath = path.join(WORK_DIR, `${jobId}-input.mp4`);
    const tempPath = path.join(WORK_DIR, `${jobId}-temp.mp4`);
    const ctaPath = path.join(WORK_DIR, `${jobId}-cta.mp4`);
    const listPath = path.join(WORK_DIR, `${jobId}-list.txt`);
    const finalName = `${jobId}-final.mp4`;
    const finalPath = path.join(OUTPUT_DIR, finalName);

    tempFiles.push(inputPath, tempPath, ctaPath, listPath);

    fs.ensureDirSync(OUTPUT_DIR);

    await downloadFile(video, inputPath);

    const safeLine1 = sanitizeDrawtext(line1);
    const safeLine2 = sanitizeDrawtext(line2);
    const safeCta = sanitizeDrawtext(cta);

    const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

    const overlayFilter =
      `drawtext=fontfile=${fontPath}:text='${safeLine1}':enable='between(t,0,3)':x=(w-text_w)/2:y=h-200:fontsize=${safeFontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20,` +
      `drawtext=fontfile=${fontPath}:text='${safeLine2}':enable='between(t,3,6)':x=(w-text_w)/2:y=h-200:fontsize=${safeFontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20`;

    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-vf", overlayFilter,
      "-t", "6",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      tempPath,
    ]);

    const ctaFilter =
      `drawtext=fontfile=${fontPath}:text='${safeCta}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${safeFontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20`;

    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `color=c=black:s=${safeWidth}x${safeHeight}:d=3`,
      "-vf", ctaFilter,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      ctaPath,
    ]);

    const listContent = `file '${tempPath}'\nfile '${ctaPath}'\n`;
    await fs.writeFile(listPath, listContent, "utf8");

    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      finalPath,
    ]);

    const finalUrl = `${BASE_URL}/videos/${finalName}`;

    for (const file of tempFiles) {
      if (await fs.pathExists(file)) {
        await fs.remove(file);
      }
    }

    return res.json({
      ok: true,
      status: "video_ready",
      video_url: finalUrl,
      ffmpeg_path: ffmpegPath,
    });
  } catch (error) {
    console.error("Overlay video error:", error);

    for (const file of tempFiles) {
      try {
        if (await fs.pathExists(file)) {
          await fs.remove(file);
        }
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
    }

    return res.status(500).json({
      ok: false,
      error: "Overlay video failed",
      details: error.message,
      ffmpeg_path: ffmpegPath,
    });
  }
});
