const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');
const crypto = require('crypto');
const unzipper = require('unzipper');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: '10mb' }));

// Directorio base para archivos extraídos (servidos estáticamente)
const EXTRACTED_DIR = path.join(os.tmpdir(), 'extracted');
if (!fs.existsSync(EXTRACTED_DIR)) {
  fs.mkdirSync(EXTRACTED_DIR, { recursive: true });
}

// Servir archivos extraídos estáticamente en /temp/<sessionId>/<filename>
app.use('/temp', express.static(EXTRACTED_DIR));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FFmpeg frame extractor + ZIP decompressor' });
});

// Limpieza proactiva: borrar carpetas extraídas con más de 30 min
function cleanOldExtractions() {
  try {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutos
    if (!fs.existsSync(EXTRACTED_DIR)) return;
    
    const folders = fs.readdirSync(EXTRACTED_DIR);
    for (const folder of folders) {
      const folderPath = path.join(EXTRACTED_DIR, folder);
      const stats = fs.statSync(folderPath);
      if (stats.isDirectory() && (now - stats.mtimeMs) > maxAge) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`[cleanup] Removed old extraction: ${folder}`);
      }
    }
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
  }
}

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
    
    const response = await axios.get(videoUrl, { 
      responseType: 'stream',
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024
    });
    
    const writer = fs.createWriteStream(videoPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log(`[${id}] Video downloaded, extracting frame`);
    
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(0)
        .frames(1)
        .output(framePath)
        .outputOptions(['-q:v', '2'])
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    console.log(`[${id}] Frame extracted, sending response`);
    
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

// NUEVO ENDPOINT: Decompress ZIP from URL
// Body: { "zipUrl": "https://..." }
// Response: { "images": ["url1", "url2", ...], "count": N, "sessionId": "abc" }
app.post('/decompress-zip', async (req, res) => {
  cleanOldExtractions();
  
  const sessionId = crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(EXTRACTED_DIR, sessionId);
  const zipPath = path.join(os.tmpdir(), `${sessionId}.zip`);
  
  try {
    const { zipUrl } = req.body;
    if (!zipUrl) {
      return res.status(400).json({ error: 'zipUrl is required in body' });
    }
    
    fs.mkdirSync(sessionDir, { recursive: true });
    console.log(`[${sessionId}] Downloading ZIP from ${zipUrl}`);
    
    // 1. Descargar ZIP a disco (streaming, sin cargar todo en RAM)
    const response = await axios.get(zipUrl, {
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: 500 * 1024 * 1024 // 500 MB max
    });
    
    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log(`[${sessionId}] ZIP downloaded, extracting files`);
    
    // 2. Descomprimir desde disco (lee el ZIP del filesystem, no de RAM)
    const directory = await unzipper.Open.file(zipPath);
    const extractedFiles = [];
    
    for (const file of directory.files) {
      if (file.type !== 'File' || file.path.startsWith('__MACOSX/')) continue;
      
      const filename = path.basename(file.path);
      if (!filename || filename.startsWith('.')) continue;
      
      const outputPath = path.join(sessionDir, filename);
      
      // Extraer archivo a archivo (cada uno en disco, sin acumular en RAM)
      await new Promise((resolve, reject) => {
        file.stream()
          .pipe(fs.createWriteStream(outputPath))
          .on('finish', resolve)
          .on('error', reject);
      });
      
      extractedFiles.push(filename);
      console.log(`[${sessionId}] Extracted: ${filename}`);
    }
    
    // 3. Borrar el ZIP descargado (ya no se necesita)
    try { fs.unlinkSync(zipPath); } catch (e) {}
    
    if (extractedFiles.length === 0) {
      throw new Error('No files extracted from ZIP');
    }
    
    // 4. Construir URLs públicas y devolverlas
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const urls = extractedFiles.map(f => `${baseUrl}/temp/${sessionId}/${f}`);
    
    console.log(`[${sessionId}] Done. Extracted ${urls.length} files`);
    res.json({ images: urls, count: urls.length, sessionId });
    
  } catch (err) {
    console.error(`[${sessionId}] Decompress error:`, err.message);
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e) {}
    try { if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg frame API + ZIP decompressor listening on port ${PORT}`);
});
