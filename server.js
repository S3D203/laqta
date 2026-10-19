
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());

// Fix for Render - set yt-dlp binary path if exists
if (fs.existsSync('/usr/local/bin/yt-dlp')) {
  process.env.YTDLP_PATH = '/usr/local/bin/yt-dlp';
}
if (fs.existsSync('/opt/render/project/src/node_modules/yt-dlp-exec/bin/yt-dlp')) {
  process.env.YTDLP_PATH = '/opt/render/project/src/node_modules/yt-dlp-exec/bin/yt-dlp';
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
  
  // Fix #2: Use android,ios,mweb instead of web (web gives 403 in 2026)
  // Fix #1: SABR-only fix needs latest client
  const tries = isSnap ? [
    { name: "snapchat", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true } }
  ] : isYoutube ? [
    { name: "android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android" } },
    { name: "ios", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=ios" } },
    { name: "mweb", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=mweb" } },
    { name: "web+android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android,ios,mweb" } },
  ] : [
    { name: "web", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true } },
    { name: "android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android" } }
  ];
  
  for (const t of tries) {
    try {
      console.log(`Trying ${t.name} for ${url.substring(0,60)}...`);
      const info = await youtubedlp(url, t.opts);
      
      let qualities = [];
      const seen = new Set();
      
      if (isSnap) {
        qualities.push({ height: 720, quality: "720p", label: "MP4 - الأصلية", ext: 'mp4' });
      } else {
        // Fix #1: Filter SABR-only formats (no direct URL)
        const allVideos = (info.formats || [])
          .filter(f => {
            // Skip SABR-only (no url, only manifest)
            if (!f.url && !f.fragments) return false;
            if (f.vcodec === 'none') return false;
            if (!f.height) return false;
            return true;
          })
          .sort((a,b) => {
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
        console.log(`SUCCESS ${t.name}: ${qualities.length} qualities found`);
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
    if (!data) return res.status(500).json({ error: "فشل جلب الفيديو - جرب رابط ثاني أو انتظر ثواني" });
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
  
  console.log(`\nDOWNLOAD ${height}p: ${safeTitle} | snap=${isSnap}\n`);
  
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  
  try {
    const youtubedlp = await getYtDlp();
    const tmpFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${height}p.mp4`);
    
    // Fix #4: ffmpeg fix - don't force ext=mp4, let yt-dlp merge correctly
    let formatStr;
    if (isSnap) {
      formatStr = "best[ext=mp4]/best";
    } else {
      // Fix #2: android client + don't force mp4 ext, allow VP9 for better quality
      if (height >= 2160) {
        formatStr = `bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
      } else {
        // For 1080p and below, try mp4 first but fallback to best
        formatStr = `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
      }
    }
    
    console.log(`Format: ${formatStr}`);
    
    // Fix #2 & #3: Use android client for download too
    const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
    const extraArgs = isYoutube ? { extractorArgs: "youtube:player_client=android,ios,mweb" } : {};
    
    // Fix #4: Add ffmpeg location if available
    let ffmpegPath = null;
    try {
      const ffmpeg = await import('ffmpeg-static');
      ffmpegPath = ffmpeg.default || ffmpeg;
      console.log(`FFmpeg found: ${ffmpegPath}`);
    } catch {}
    
    const opts = {
      format: formatStr,
      output: tmpFile,
      mergeOutputFormat: "mp4",
      noWarnings: true,
      noPlaylist: true,
      ...extraArgs
    };
    
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      opts.ffmpegLocation = path.dirname(ffmpegPath);
    }
    
    await youtubedlp(targetUrl, opts);
    
    if (!fs.existsSync(tmpFile)) {
      console.error("File not created after download");
      return res.status(500).end("Failed - file not created, ffmpeg missing?");
    }
    
    const stat = fs.statSync(tmpFile);
    if (stat.size === 0) {
      fs.unlinkSync(tmpFile);
      return res.status(500).end("Failed - 0 byte file, ffmpeg missing?");
    }
    
    console.log(`Ready: ${(stat.size/1024/1024).toFixed(2)} MB`);
    
    res.setHeader("Content-Length", stat.size);
    
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpFile); } catch {} });
    stream.on('error', (e)=>{ console.error(e); try{ fs.unlinkSync(tmpFile);}catch{} });
    
  } catch (e) {
    console.error("Download failed:", e.message);
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
  res.setHeader("Cache-Control", "no-cache");
  
  try {
    const youtubedlp = await getYtDlp();
    const tmp = path.join(os.tmpdir(), `laqta_${Date.now()}.mp3`);
    
    let ffmpegPath = null;
    try {
      const ffmpeg = await import('ffmpeg-static');
      ffmpegPath = ffmpeg.default || ffmpeg;
    } catch {}
    
    const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
    const extraArgs = isYoutube ? { extractorArgs: "youtube:player_client=android,ios,mweb" } : {};
    
    const opts = {
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      output: tmp,
      noWarnings: true,
      noPlaylist: true,
      ...extraArgs
    };
    
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      opts.ffmpegLocation = path.dirname(ffmpegPath);
    }
    
    await youtubedlp(targetUrl, opts);
    
    if (!fs.existsSync(tmp)) return res.status(500).end("MP3 failed - ffmpeg missing?");
    
    const stat = fs.statSync(tmp);
    if (stat.size === 0) {
      fs.unlinkSync(tmp);
      return res.status(500).end("MP3 failed - 0 byte");
    }
    
    res.setHeader("Content-Length", stat.size);
    const s = fs.createReadStream(tmp);
    s.pipe(res);
    s.on('end', () => { try { fs.unlinkSync(tmp); } catch {} });
  } catch (e) {
    console.error("MP3 failed:", e.message);
    if (!res.headersSent) res.status(500).send("MP3 failed: " + e.message);
    else res.end();
  }
});

app.get("/health", (req,res)=> res.json({ status: "ok", version: "V30 YouTube 2026 Fixed - android+ffmpeg+SABR" }));
app.get("/", (req,res)=> res.json({ status: "Laqta V30 - YouTube Fixed 2026 - android,ios,mweb + ffmpeg + SABR filter - Live" }));

app.listen(PORT, () => console.log(`Laqta V30 Fixed 2026 on ${PORT} - YouTube android+ffmpeg+SABR`));
