
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0,80) || 'video';
}
function asciiFile(name, ext) {
  const ascii = name.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0,30) || 'video';
  return /[a-zA-Z0-9]/.test(ascii) ? `${ascii}.${ext}` : `laqta-video.${ext}`;
}

async function getYtDlp() {
  const mod = await import('yt-dlp-exec');
  return mod.default || mod;
}

// TikTok via tikwm API - works 100% on Render
async function getTikTokInfo(url) {
  try {
    console.log("[TikTok] trying tikwm API...");
    const res = await axios.post('https://www.tikwm.com/api/', { url }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 20000
    });
    if (res.data?.data) {
      const d = res.data.data;
      console.log("[TikTok] tikwm success");
      const qualities = [];
      if (d.hdplay) qualities.push({ height: 1080, quality: "1080p", label: "1080p HD - بدون علامة", ext: 'mp4', url: d.hdplay, direct: true });
      if (d.play) qualities.push({ height: 720, quality: "720p", label: "720p - بدون علامة", ext: 'mp4', url: d.play, direct: true });
      if (d.wmplay) qualities.push({ height: 720, quality: "720p-wm", label: "مع علامة", ext: 'mp4', url: d.wmplay, direct: true });
      
      return {
        title: d.title || "TikTok Video",
        author: d.author?.nickname || d.author?.unique_id || "TikTok",
        cover: d.cover || d.origin_cover || "",
        qualities: qualities,
        originalUrl: url,
        safeTitle: sanitize(d.title || "tiktok"),
        platform: "TikTok",
        hasAudio: true
      };
    }
  } catch (e) {
    console.log("[TikTok] tikwm failed:", e.message?.substring(0,200));
  }
  // Fallback to yt-dlp for TikTok
  return await getInfoYtDlp(url, "TikTok");
}

async function getInfoYtDlp(url, platformName="Video") {
  const ytdlp = await getYtDlp();
  const attempts = [
    { name: "android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android" } },
    { name: "ios", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=ios" } },
    { name: "web", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true } }
  ];
  
  for (const att of attempts) {
    try {
      console.log(`[${platformName}] trying ${att.name}...`);
      const info = await ytdlp(url, att.opts);
      const qualities = [];
      const seen = new Set();
      
      const formats = (info.formats||[]).filter(f=>f.vcodec!=='none'&&f.height).sort((a,b)=>{
        if (a.height===b.height) return (b.tbr||0)-(a.tbr||0);
        return b.height-a.height;
      });
      
      for (const f of formats) {
        if (seen.has(f.height)) continue;
        if (f.height<144) continue;
        qualities.push({ height: f.height, quality: `${f.height}p`, label: f.height>=2160?`${f.height}p 4K`:f.height>=1080?`${f.height}p HD`:`${f.height}p`, ext: 'mp4', direct: false });
        seen.add(f.height);
      }
      
      if (qualities.length===0 && info.height) {
        qualities.push({ height: info.height, quality: `${info.height}p`, label: `${info.height}p`, ext: 'mp4', direct: false });
      }
      
      if (qualities.length>0) {
        console.log(`[${platformName}] success with ${att.name}: ${qualities.length} qualities`);
        return {
          title: info.title || `${platformName} Video`,
          author: info.uploader || info.channel || platformName,
          cover: info.thumbnail || "",
          qualities: qualities.sort((a,b)=>b.height-a.height),
          originalUrl: url,
          safeTitle: sanitize(info.title || "video"),
          platform: platformName,
          hasAudio: true,
          duration: info.duration
        };
      }
    } catch (e) {
      console.log(`[${platformName}] ${att.name} failed: ${e.message?.substring(0,250)}`);
    }
  }
  return null;
}

app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  console.log("\n=== /api/info ===", url?.substring(0,100));
  if (!url) return res.status(400).json({ error: "الرابط ناقص" });
  
  try {
    let data = null;
    
    if (url.includes('tiktok.com') || url.includes('vm.tiktok') || url.includes('vt.tiktok')) {
      data = await getTikTokInfo(url);
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      data = await getInfoYtDlp(url, "YouTube");
    } else if (url.includes('instagram.com')) {
      data = await getInfoYtDlp(url, "Instagram");
    } else if (url.includes('facebook.com') || url.includes('fb.watch')) {
      data = await getInfoYtDlp(url, "Facebook");
    } else if (url.includes('twitter.com') || url.includes('x.com')) {
      data = await getInfoYtDlp(url, "Twitter");
    } else if (url.includes('snapchat.com')) {
      data = await getInfoYtDlp(url, "Snapchat");
    } else {
      data = await getInfoYtDlp(url, "Video");
    }
    
    if (!data) {
      return res.status(500).json({ error: "فشل جلب الفيديو - جرب رابط آخر أو تأكد أنه عام" });
    }
    
    console.log(">>> SUCCESS:", data.platform, data.qualities.map(q=>q.quality).join(", "));
    res.json({ success: true, ...data });
  } catch (err) {
    console.error("ERROR /api/info:", err.message);
    res.status(500).json({ error: err.message || "فشل جلب الفيديو" });
  }
});

// FIX 1: Accept both url, originalUrl, directUrl
app.get("/api/download", async (req, res) => {
  // Support all param names: url, originalUrl, directUrl, videoUrl
  const { title, quality, url, originalUrl, directUrl, videoUrl } = req.query;
  const targetUrl = directUrl || originalUrl || url || videoUrl;
  
  console.log(`\n=== /api/download === title=${title} quality=${quality} hasDirect=${!!directUrl}`);
  console.log(`Target URL: ${targetUrl?.substring(0,100)}`);
  
  if (!targetUrl) {
    console.log("ERROR: url missing, params:", Object.keys(req.query));
    return res.status(400).send("url missing - params: " + JSON.stringify(Object.keys(req.query)));
  }
  
  const height = parseInt(quality) || 720;
  const safeTitle = sanitize(title || "video");
  const asciiName = asciiFile(safeTitle, 'mp4');
  const encodedName = encodeURIComponent(safeTitle + '.mp4');
  
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-cache");
  
  try {
    // If direct URL (TikTok from tikwm), stream directly - fixes url missing issue
    if (directUrl) {
      console.log("Streaming direct URL...");
      const response = await axios({
        method: 'GET',
        url: directUrl,
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tikwm.com/' },
        timeout: 60000
      });
      if (response.headers['content-length']) {
        res.setHeader("Content-Length", response.headers['content-length']);
      }
      response.data.pipe(res);
      return;
    }
    
    // Otherwise use yt-dlp
    console.log(`Using yt-dlp for ${height}p...`);
    const ytdlp = await getYtDlp();
    const tmpFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${height}p.mp4`);
    
    let formatStr;
    if (targetUrl.includes("snapchat")) {
      formatStr = "best[ext=mp4]/best";
    } else {
      formatStr = `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
    }
    
    await ytdlp(targetUrl, {
      format: formatStr,
      output: tmpFile,
      mergeOutputFormat: "mp4",
      noWarnings: true,
      noPlaylist: true,
      extractorArgs: "youtube:player_client=android"
    });
    
    if (!fs.existsSync(tmpFile)) return res.status(500).end("Failed to download");
    
    const stat = fs.statSync(tmpFile);
    console.log(`Ready: ${(stat.size/1024/1024).toFixed(2)} MB`);
    res.setHeader("Content-Length", stat.size);
    
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpFile); } catch {} });
    
  } catch (e) {
    console.error("Download failed:", e.message);
    if (!res.headersSent) res.status(500).send("فشل التحميل: " + e.message);
    else res.end();
  }
});

// FIX 2: MP3 endpoint - fixed params
app.get("/api/download-mp3", async (req, res) => {
  const { title, url, originalUrl, directUrl } = req.query;
  const targetUrl = originalUrl || url || directUrl;
  
  console.log(`\n=== /api/download-mp3 === ${title}`);
  
  if (!targetUrl) return res.status(400).send("url missing");
  
  const safeTitle = sanitize(title || "audio");
  const asciiName = asciiFile(safeTitle, 'mp3');
  const encodedName = encodeURIComponent(safeTitle + '.mp3');
  
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache");
  
  try {
    const ytdlp = await getYtDlp();
    const tmp = path.join(os.tmpdir(), `laqta_${Date.now()}.mp3`);
    await ytdlp(targetUrl, {
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
    console.error("MP3 failed:", e.message);
    if (!res.headersSent) res.status(500).send("MP3 failed: " + e.message);
    else res.end();
  }
});

app.get("/api/status", (req,res)=>{
  res.json({
    status: "Live ✓ V34 FINAL",
    fixes: ["TikTok via API", "url missing fixed (accepts all param names)", "MP3 endpoint fixed"],
    platforms: {
      TikTok: "✓ tikwm API",
      YouTube: "✓ android client",
      Instagram: "✓",
      Facebook: "✓",
      Twitter: "✓",
      Snapchat: "✓",
      MP3: "✓ /api/download-mp3"
    }
  });
});

app.get("/", (req,res)=> res.json({ status: "Laqta V34 FINAL - 6 Platforms + MP3 - Live ✓" }));

app.listen(PORT, () => console.log(`Laqta V34 FINAL on ${PORT} - All fixes applied`));
