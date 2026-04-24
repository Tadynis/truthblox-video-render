app.post("/render", async (req, res) => {
  const tempFiles = [];

  try {
    const {
      image,
      frame_1_url,
      frame_2_url,

      // CTA IMAGE
      cta_image_url,
      cta_url,
      cta_duration = 3,

      // duration = pagrindinių 2 frame trukmė, pvz 6s
      duration = 6,
      format = "720x1280",
      content_id = "",
    } = req.body;

    const safeSingleImageUrl = normalizeUrl(image);
    const safeFrame1Url = normalizeUrl(frame_1_url);
    const safeFrame2Url = normalizeUrl(frame_2_url);
    const safeCtaUrl = normalizeUrl(cta_image_url || cta_url);

    const [width, height] = String(format).split("x").map(Number);
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

    const safeCtaDuration = Number(cta_duration) || 3;
    if (safeCtaDuration <= 0) {
      return res.status(400).json({
        error: "Invalid cta_duration",
      });
    }

    const jobId = uuidv4();
    const outputVideoName = content_id
      ? `${content_id}-${jobId}.mp4`
      : `${jobId}.mp4`;

    const outputVideoPath = path.join(OUTPUT_DIR, outputVideoName);

    fs.ensureDirSync(OUTPUT_DIR);

    console.log("Render request body >>>", req.body);

    // ===== SENAS 1 paveikslėlio režimas =====
    if (safeSingleImageUrl) {
      const inputImagePath = path.join(WORK_DIR, `${jobId}.png`);
      tempFiles.push(inputImagePath);

      await downloadFile(safeSingleImageUrl, inputImagePath);

      const filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
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
            "-preset",
            "veryfast",
            "-movflags",
            "+faststart",
            "-an",
          ])
          .size(`${width}x${height}`)
          .fps(25)
          .on("start", (commandLine) => {
            console.log("FFmpeg single-image start:", commandLine);
          })
          .on("stderr", (stderrLine) => {
            console.log("FFmpeg single-image stderr:", stderrLine);
          })
          .on("end", resolve)
          .on("error", (err) => {
            console.error("FFmpeg single-image render error:", err);
            reject(err);
          })
          .save(outputVideoPath);
      });

      await cleanupFiles(tempFiles);

      const videoUrl = `${BASE_URL}/videos/${outputVideoName}`;

      return res.json({
        video_url: videoUrl,
        status: "video_ready",
        ffmpeg_path: ffmpegPath,
        mode: "single_image",
        duration: safeDuration,
      });
    }

    // ===== 2 paveikslėliai + optional CTA paveikslėlis =====
    if (!safeFrame1Url || !safeFrame2Url) {
      return res.status(400).json({
        error: "Missing frame URL(s)",
        received: {
          image: !!safeSingleImageUrl,
          frame_1_url: !!safeFrame1Url,
          frame_2_url: !!safeFrame2Url,
          cta_image_url: !!safeCtaUrl,
        },
      });
    }

    const frame1Path = path.join(WORK_DIR, `${jobId}-frame1.png`);
    const frame2Path = path.join(WORK_DIR, `${jobId}-frame2.png`);
    const ctaImagePath = path.join(WORK_DIR, `${jobId}-cta.png`);

    const clip1Path = path.join(WORK_DIR, `${jobId}-clip1.mp4`);
    const clip2Path = path.join(WORK_DIR, `${jobId}-clip2.mp4`);
    const ctaClipPath = path.join(WORK_DIR, `${jobId}-cta.mp4`);

    const concatListPath = path.join(WORK_DIR, `${jobId}-concat.txt`);

    tempFiles.push(
      frame1Path,
      frame2Path,
      clip1Path,
      clip2Path,
      concatListPath
    );

    await downloadFile(safeFrame1Url, frame1Path);
    await downloadFile(safeFrame2Url, frame2Path);

    const frameClipDuration = safeDuration / 2;

    const buildStillClip = async (inputImagePath, outputClipPath, clipDuration) => {
      const filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
      ];

      await new Promise((resolve, reject) => {
        ffmpeg(inputImagePath)
          .loop(clipDuration)
          .videoFilters(filters)
          .outputOptions([
            "-t",
            String(clipDuration),
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-movflags",
            "+faststart",
            "-an",
          ])
          .size(`${width}x${height}`)
          .fps(25)
          .on("start", (commandLine) => {
            console.log("FFmpeg still clip start:", commandLine);
          })
          .on("stderr", (stderrLine) => {
            console.log("FFmpeg still clip stderr:", stderrLine);
          })
          .on("end", resolve)
          .on("error", (err) => {
            console.error("FFmpeg still clip error:", err);
            reject(err);
          })
          .save(outputClipPath);
      });
    };

    await buildStillClip(frame1Path, clip1Path, frameClipDuration);
    await buildStillClip(frame2Path, clip2Path, frameClipDuration);

    const concatFiles = [
      `file '${clip1Path}'`,
      `file '${clip2Path}'`,
    ];

    let mode = "two_frames";
    let totalDuration = safeDuration;

    // ===== CTA paveikslėlis kaip 3 sekundžių final frame =====
    if (safeCtaUrl) {
      tempFiles.push(ctaImagePath, ctaClipPath);

      await downloadFile(safeCtaUrl, ctaImagePath);
      await buildStillClip(ctaImagePath, ctaClipPath, safeCtaDuration);

      concatFiles.push(`file '${ctaClipPath}'`);

      mode = "two_frames_plus_cta";
      totalDuration = safeDuration + safeCtaDuration;
    }

    const concatFileContent = concatFiles.join("\n");

    await fs.writeFile(concatListPath, concatFileContent, "utf8");

    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      outputVideoPath,
    ]);

    await cleanupFiles(tempFiles);

    const videoUrl = `${BASE_URL}/videos/${outputVideoName}`;

    return res.json({
      video_url: videoUrl,
      status: "video_ready",
      ffmpeg_path: ffmpegPath,
      mode,
      duration: totalDuration,
      frame_duration: frameClipDuration,
      cta_duration: safeCtaUrl ? safeCtaDuration : 0,
      has_cta: !!safeCtaUrl,
    });
  } catch (error) {
    console.error("Render error:", error);

    await cleanupFiles(tempFiles);

    return res.status(500).json({
      error: "Render failed",
      details: error.message,
      ffmpeg_path: ffmpegPath,
    });
  }
});
