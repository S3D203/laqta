
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const PORT = 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0,80) || 'video';
}
function asciiFile(name, ext) {
  const ascii = name.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0,30) || 'video';
  return /[a-zA-Z0-9]/.test(ascii) ? `${ascii}.${ext}` : `laqta-video.${ext}`;
}

async function getInfo(url) {
  const youtubedlp = (await import('yt-dlp-exec')).default;
  const isSnap = url.includes("snapchat");
  
  const tries = isSnap ? [
    { name: "snapchat", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true } }
  ] : [
    { name: "web", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true } },
    { name: "android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android" } }
  ];
  
  for (const t of tries) {
    try {
      const info = await youtubedlp(url, t.opts);
      
      let qualities = [];
      const seen = new Set();
      
      if (isSnap) {
        qualities.push({ height: 720, quality: "720p", label: "MP4 - الأصلية", ext: 'mp4' });
      } else {
        // خذ كل الجودات - فضل الأفضل جودة (أعلى bitrate)
        const allVideos = (info.formats || [])
          .filter(f => f.vcodec !== 'none' && f.height)
          .sort((a,b) => {
            // نفس الارتفاع، فضل الأعلى bitrate
            if (a.height === b.height) return (b.tbr || b.bitrate || 0) - (a.tbr || a.bitrate || 0);
            return b.height - a.height;
          });
        
        for (const f of allVideos) {
          if (seen.has(f.height)) continue;
          if (f.height < 144) continue;
          qualities.push({
            height: f.height,
            quality: `${f.height}p`,
            label: f.height >= 2160 ? `${f.height}p 4K` : f.height >= 1440 ? `${f.height}p 2K` : `${f.height}p`,
            ext: 'mp4'
          });
          seen.add(f.height);
        }
      }
      
      qualities = qualities.sort((a,b) => b.height - a.height);
      
      if (qualities.length > 0) {
        return {
          title: info.title || (isSnap ? "Snapchat Video" : "Video"),
          author: info.uploader || info.channel || (isSnap ? "Snapchat" : "User"),
          cover: info.thumbnail || "",
          qualities: qualities,
          originalUrl: url,
          safeTitle: sanitize(info.title || "video"),
          method: t.name,
          duration: info.duration,
          durationStr: info.duration ? `${Math.floor(info.duration/60)}د ${info.duration%60}ث` : ""
        };
      }
    } catch (e) {
      console.log(`FAILED ${t.name}: ${e.message?.substring(0,500)}`);
    }
  }
  return null;
}

app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL missing" });
  try {
    let data = await getInfo(url);
    if (!data) return res.status(500).json({ error: "فشل جلب الفيديو" });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  const { title, quality, originalUrl } = req.query;
  const targetUrl = originalUrl;
  if (!targetUrl) return res.status(400).send("url missing");
  
  const height = parseInt(quality) || 720;
  const safeTitle = sanitize(title || "video");
  const asciiName = asciiFile(safeTitle, 'mp4');
  const encodedName = encodeURIComponent(safeTitle + '.mp4');
  const isSnap = targetUrl.includes("snapchat");
  
  console.log(`\nDOWNLOAD ${height}p: ${safeTitle} | snap=${isSnap}\n`);
  
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  
  try {
    const youtubedlp = (await import('yt-dlp-exec')).default;
    const tmpFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${height}p.mp4`);
    
    let formatStr;
    if (isSnap) {
      formatStr = "best[ext=mp4]/best";
    } else {
      // V28: أفضل جودة بدون تغبيش - خذ أعلى bitrate لنفس الارتفاع
      // لا نفضل H264 على حساب الجودة، نأخذ الأفضل جودة حقيقية
      // الترتيب: أفضل فيديو بهذا الارتفاع (أعلى bitrate) + أفضل صوت
      if (height >= 2160) {
        // 4K: خذ أفضل 4K (VP9 أفضل جودة من AV1 الخفيف) + صوت
        formatStr = `bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
      } else if (height >= 1080) {
        // 1080p: MP4 H264 عالي الجودة
        formatStr = `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}][ext=mp4]+bestaudio/best[height<=${height}]`;
      } else {
        formatStr = `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
      }
    }
    
    console.log(`Format (best quality): ${formatStr}`);
    
    await youtubedlp(targetUrl, {
      format: formatStr,
      output: tmpFile,
      mergeOutputFormat: "mp4",
      noWarnings: true,
      noPlaylist: true
    });
    
    if (!fs.existsSync(tmpFile)) return res.status(500).end("Failed");
    
    const stat = fs.statSync(tmpFile);
    console.log(`Ready: ${(stat.size/1024/1024).toFixed(2)} MB - best quality`);
    
    res.setHeader("Content-Length", stat.size);
    
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpFile); } catch {} });
    
  } catch (e) {
    console.error("Download failed:", e.message);
    if (!res.headersSent) res.status(500).send("Failed: " + e.message);
    else res.end();
  }
});

app.get("/api/download-mp3", async (req, res) => {
  const { originalUrl, title } = req.query;
  const targetUrl = originalUrl;
  if (!targetUrl) return res.status(400).send("url missing");
  
  const safeTitle = sanitize(title || "audio");
  const asciiName = asciiFile(safeTitle, 'mp3');
  const encodedName = encodeURIComponent(safeTitle + '.mp3');
  
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache");
  
  try {
    const youtubedlp = (await import('yt-dlp-exec')).default;
    const tmp = path.join(os.tmpdir(), `laqta_${Date.now()}.mp3`);
    await youtubedlp(targetUrl, {
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      output: tmp,
      noWarnings: true,
      noPlaylist: true
    });
    if (!fs.existsSync(tmp)) return res.status(500).end("MP3 failed");
    const stat = fs.statSync(tmp);
    res.setHeader("Content-Length", stat.size);
    const s = fs.createReadStream(tmp);
    s.pipe(res);
    s.on('end', () => { try { fs.unlinkSync(tmp); } catch {} });
  } catch (e) {
    if (!res.headersSent) res.status(500).send("MP3 failed");
    else res.end();
  }
});

app.listen(PORT, () => console.log(`Laqta v28 on http://localhost:${PORT} - Best quality + salat`));
