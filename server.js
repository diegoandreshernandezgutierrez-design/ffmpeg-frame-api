const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FFmpeg frame extractor' });
});

// Extract first frame from video URL
app.post('/extract-frame', async (req, res) => {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPath = path.join(tmpDir, `video_${id}.mp4`);
  const framePath = path.join(tmpDir, `frame_${id}.jpg`);
  
  const cleanup = () => {
    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch (e) {}
    try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch (e) {}
  };
  
  try {
    const { videoUrl } = req.body;
    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required in body' });
    }
    
    console.log(`[${id}] Downloading video from ${videoUrl}`);
    
    // Descargar video a archivo temporal
    const response = await axios.get(videoUrl, { 
      responseType: 'stream',
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024 // 100 MB max
    });
    
    const writer = fs.createWriteStream(videoPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log(`[${id}] Video downloaded, extracting frame`);
    
    // Extraer primer frame con ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(0)
        .frames(1)
        .output(framePath)
        .outputOptions(['-q:v', '2']) // calidad alta
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    console.log(`[${id}] Frame extracted, sending response`);
    
    // Devolver imagen JPG
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="frame_${id}.jpg"`);
    
    const frameBuffer = fs.readFileSync(framePath);
    res.send(frameBuffer);
    
    cleanup();
    
  } catch (err) {
    console.error(`[${id}] Error:`, err.message);
    cleanup();
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg frame API listening on port ${PORT}`);
});
