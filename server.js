import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "ffmpeg-static";

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());

console.log("FFmpeg:", ffmpeg, "exists:", fs.existsSync(ffmpeg || ""));

// Render fix: yt-dlp binary path
if (fs.existsSync('/usr/local/bin/yt-dlp')) {
  process.env.YTDLP_PATH = '/usr/local/bin/yt-dlp';
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0,80) || 'video';
}
function asciiFile(name, ext) {
  const ascii = name.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0,30) || 'video';
  return /[a-zA-Z0-9]/.test(ascii) ? `${ascii}.${ext}` : `laqta-video.${ext}`;
}

async function getYtDlp(){
  const mod = await import('yt-dlp-exec');
  return mod.default || mod;
}

async function getInfo(url) {
  const youtubedlp = await getYtDlp();
  const isSnap = url.includes("snapchat");
  const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
  
  // الحل النهائي 2026 - جرب كل العملاء
  const tries = isSnap ? [
    { name: "snapchat", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ffmpegLocation: ffmpeg } }
  ] : isYoutube ? [
    // الترتيب مهم: android أولا هو اللي يشتغل الآن
    { name: "android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android", ffmpegLocation: ffmpeg } },
    { name: "android+ios+mweb", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android,ios,mweb", ffmpegLocation: ffmpeg } },
    { name: "ios", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=ios", ffmpegLocation: ffmpeg } },
    { name: "tv+android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=tv,android", ffmpegLocation: ffmpeg } },
  ] : [
    { name: "web", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ffmpegLocation: ffmpeg } },
  ];
  
  for (const t of tries) {
    try {
      console.log(`[INFO] Trying ${t.name}...`);
      const info = await youtubedlp(url, t.opts);
      
      let qualities = [];
      const seen = new Set();
      
      if (isSnap) {
        qualities.push({ height: 720, quality: "720p", label: "MP4 - الأصلية", ext: 'mp4' });
      } else {
        // فلتر SABR - تجاهل الصيغ اللي ما لها رابط مباشر
        const allVideos = (info.formats || [])
          .filter(f => {
            if (!f.url && !f.fragments) return false;
            if (f.vcodec === 'none') return false;
            if (!f.height) return false;
            // تجاهل الصيغ اللي فيها مشكلة
            if (f.protocol === 'm3u8_native' && !f.url) return false;
            return true;
          })
          .sort((a,b) => {
            if (a.height === b.height) return (b.tbr || 0) - (a.tbr || 0);
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
        console.log(`[INFO] SUCCESS ${t.name}: ${qualities.length} qualities`);
        return {
          title: info.title || "Video",
          author: info.uploader || info.channel || "User",
          cover: info.thumbnail || info.thumbnails?.pop()?.url || "",
          qualities,
          originalUrl: url,
          safeTitle: sanitize(info.title || "video"),
          method: t.name,
          duration: info.duration,
        };
      }
    } catch (e) {
      console.log(`[INFO] FAILED ${t.name}: ${e.message?.substring(0,400)}`);
    }
  }
  return null;
}

app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL missing" });
  try {
    const data = await getInfo(url);
    if (!data) return res.status(500).json({ error: "فشل جلب الفيديو - يوتيوب حظر الطلب، جرب بعد دقيقة" });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  const { title, quality, originalUrl, url, directUrl } = req.query;
  const targetUrl = originalUrl || url || directUrl;
  if (!targetUrl) return res.status(400).send("url missing");
  
  const height = parseInt(quality) || 720;
  const safeTitle = sanitize(title || "video");
  const asciiName = asciiFile(safeTitle, 'mp4');
  const encodedName = encodeURIComponent(safeTitle + '.mp4');
  const isSnap = targetUrl.includes("snapchat");
  
  console.log(`\n[DL] ${height}p: ${safeTitle}\n`);

  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  
  try {
    const youtubedlp = await getYtDlp();
    const tmpFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${height}p.mp4`);
    
    let formatStr = isSnap ? "best[ext=mp4]/best" :
      `bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
    
    console.log(`[DL] Format: ${formatStr}`);

    const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
    
    const opts = {
      format: formatStr,
      output: tmpFile,
      mergeOutputFormat: "mp4",
      noWarnings: true,
      noPlaylist: true,
      ffmpegLocation: ffmpeg,
      ...(isYoutube ? { extractorArgs: "youtube:player_client=android,ios,mweb" } : {}),
    };
    
    await youtubedlp(targetUrl, opts);
    
    if (!fs.existsSync(tmpFile)) return res.status(500).end("File not created - ffmpeg?");
    const stat = fs.statSync(tmpFile);
    if (stat.size === 0) { fs.unlinkSync(tmpFile); return res.status(500).end("0 byte file"); }
    
    console.log(`[DL] Ready: ${(stat.size/1024/1024).toFixed(2)} MB`);
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpFile); } catch {} });
    
  } catch (e) {
    console.error("[DL] Failed:", e.message);
    if (!res.headersSent) res.status(500).send("Failed: " + e.message);
    else res.end();
  }
});

app.get("/api/download-mp3", async (req, res) => {
  const { originalUrl, title, url, directUrl } = req.query;
  const targetUrl = originalUrl || url || directUrl;
  if (!targetUrl) return res.status(400).send("url missing");
  
  const safeTitle = sanitize(title || "audio");
  const asciiName = asciiFile(safeTitle, 'mp3');
  const encodedName = encodeURIComponent(safeTitle + '.mp3');
  
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "audio/mpeg");
  
  try {
    const youtubedlp = await getYtDlp();
    const tmp = path.join(os.tmpdir(), `laqta_${Date.now()}.mp3`);
    const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
    
    await youtubedlp(targetUrl, {
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      output: tmp,
      noWarnings: true,
      noPlaylist: true,
      ffmpegLocation: ffmpeg,
      ...(isYoutube ? { extractorArgs: "youtube:player_client=android,ios,mweb" } : {}),
    });
    
    if (!fs.existsSync(tmp)) return res.status(500).end("MP3 failed");
    const stat = fs.statSync(tmp);
    res.setHeader("Content-Length", stat.size);
    const s = fs.createReadStream(tmp);
    s.pipe(res);
    s.on('end', () => { try { fs.unlinkSync(tmp); } catch {} });
  } catch (e) {
    if (!res.headersSent) res.status(500).send("MP3 failed: " + e.message);
    else res.end();
  }
});

app.get("/health", (req,res)=> res.json({ status: "ok", version: "V31 FINAL", ffmpeg: !!ffmpeg, ffmpegExists: fs.existsSync(ffmpeg||"") }));
app.get("/", (req,res)=> res.json({ status: "Laqta V31 Final - YouTube Fixed" }));
app.listen(PORT, () => console.log(`Laqta V31 FINAL on ${PORT}`));
