
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

async function getTikTokInfo(url) {
  try {
    console.log("[TikTok] tikwm API...");
    const res = await axios.post('https://www.tikwm.com/api/', { url }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 20000
    });
    if (res.data?.data) {
      const d = res.data.data;
      const playUrl = d.hdplay || d.play || d.wmplay;
      return {
        title: d.title || "TikTok Video",
        author: d.author?.nickname || d.author?.unique_id || "TikTok",
        duration: d.duration || 0,
        cover: d.cover || "",
        playUrl: playUrl,
        downloadUrl: playUrl,
        qualities: [
          ...(d.hdplay ? [{ height: 1080, quality: "1080p", label: "1080p HD", url: d.hdplay, direct: true }] : []),
          ...(d.play ? [{ height: 720, quality: "720p", label: "720p بدون علامة", url: d.play, direct: true }] : [])
        ],
        originalUrl: url,
        safeTitle: sanitize(d.title || "tiktok"),
        platform: "TikTok"
      };
    }
  } catch (e) {
    console.log("[TikTok] tikwm failed:", e.message?.substring(0,200));
  }
  return null;
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
      const bestUrl = info.url || (info.formats?.find(f=>f.ext==='mp4'&&f.height)?.url) || info.formats?.[0]?.url;
      const qualities = [];
      const seen = new Set();
      const formats = (info.formats||[]).filter(f=>f.vcodec!=='none'&&f.height).sort((a,b)=>{
        if (a.height===b.height) return (b.tbr||0)-(a.tbr||0);
        return b.height-a.height;
      });
      for (const f of formats) {
        if (seen.has(f.height)) continue;
        if (f.height<144) continue;
        qualities.push({ height: f.height, quality: `${f.height}p`, label: `${f.height}p`, ext: 'mp4', url: f.url, direct: false });
        seen.add(f.height);
      }
      if (qualities.length>0 || bestUrl) {
        const playUrl = bestUrl || qualities[0]?.url;
        return {
          title: info.title || `${platformName} Video`,
          author: info.uploader || info.channel || platformName,
          duration: info.duration || 0,
          cover: info.thumbnail || "",
          playUrl: playUrl,
          downloadUrl: playUrl,
          qualities: qualities.sort((a,b)=>b.height-a.height),
          originalUrl: url,
          safeTitle: sanitize(info.title || "video"),
          platform: platformName
        };
      }
    } catch (e) {
      console.log(`[${platformName}] ${att.name} failed: ${e.message?.substring(0,300)}`);
    }
  }
  return null;
}

app.get("/health", (req,res)=> res.json({ status: "ok", version: "V35 FINAL" }));
app.get("/api/health", (req,res)=> res.json({ status: "ok" }));

app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  console.log("\n=== /api/info ===", url?.substring(0,120));
  if (!url) return res.status(400).json({ error: "الرابط ناقص" });
  try {
    let data = null;
    const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok') || url.includes('vt.tiktok');
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    const isInsta = url.includes('instagram.com');
    const isFb = url.includes('facebook.com') || url.includes('fb.watch');
    const isTwitter = url.includes('twitter.com') || url.includes('x.com');
    const isSnap = url.includes('snapchat.com');
    
    if (isTikTok) {
      data = await getTikTokInfo(url);
      if (!data) data = await getInfoYtDlp(url, "TikTok");
    } else if (isYouTube) {
      data = await getInfoYtDlp(url, "YouTube");
    } else if (isInsta) {
      data = await getInfoYtDlp(url, "Instagram");
    } else if (isFb) {
      data = await getInfoYtDlp(url, "Facebook");
    } else if (isTwitter) {
      data = await getInfoYtDlp(url, "Twitter");
    } else if (isSnap) {
      data = await getInfoYtDlp(url, "Snapchat");
    } else {
      data = await getInfoYtDlp(url, "Video");
    }
    
    if (!data) return res.status(500).json({ error: "فشل جلب الفيديو" });
    res.json({
      success: true,
      title: data.title,
      author: data.author,
      duration: data.duration,
      cover: data.cover,
      thumbnail: data.cover,
      playUrl: data.playUrl,
      downloadUrl: data.downloadUrl,
      qualities: data.qualities,
      originalUrl: data.originalUrl,
      safeTitle: data.safeTitle,
      platform: data.platform
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "فشل" });
  }
});

app.get("/api/download", async (req, res) => {
  const { title, quality, url, originalUrl, directUrl } = req.query;
  const targetUrl = directUrl || originalUrl || url;
  if (!targetUrl) return res.status(400).send("url missing");
  const height = parseInt(quality) || 720;
  const safeTitle = sanitize(title || "video");
  const asciiName = asciiFile(safeTitle, 'mp4');
  const encodedName = encodeURIComponent(safeTitle + '.mp4');
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-cache");
  try {
    if (directUrl) {
      const response = await axios({ method: 'GET', url: directUrl, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tikwm.com/' }, timeout: 60000 });
      if (response.headers['content-length']) res.setHeader("Content-Length", response.headers['content-length']);
      response.data.pipe(res);
      return;
    }
    const ytdlp = await getYtDlp();
    const tmpFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${height}p.mp4`);
    const formatStr = targetUrl.includes('snapchat') ? "best[ext=mp4]/best" : `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
    await ytdlp(targetUrl, { format: formatStr, output: tmpFile, mergeOutputFormat: "mp4", noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android" });
    if (!fs.existsSync(tmpFile)) return res.status(500).end("Failed");
    const stat = fs.statSync(tmpFile);
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpFile); } catch {} });
  } catch (e) {
    if (!res.headersSent) res.status(500).send("Failed: " + e.message);
    else res.end();
  }
});

app.get("/api/download-mp3", async (req, res) => {
  const { title, url, originalUrl } = req.query;
  const targetUrl = originalUrl || url;
  if (!targetUrl) return res.status(400).send("url missing");
  const safeTitle = sanitize(title || "audio");
  const asciiName = asciiFile(safeTitle, 'mp3');
  const encodedName = encodeURIComponent(safeTitle + '.mp3');
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Type", "audio/mpeg");
  try {
    const ytdlp = await getYtDlp();
    const tmp = path.join(os.tmpdir(), `laqta_${Date.now()}.mp3`);
    await ytdlp(targetUrl, { extractAudio: true, audioFormat: "mp3", audioQuality: 0, output: tmp, noWarnings: true, noPlaylist: true });
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

app.get("/", (req,res)=> res.json({ status: "Laqta V35 FINAL - 6 Platforms + MP3 + Title Filename" }));
app.listen(PORT, () => console.log(`Laqta V35 FINAL on ${PORT}`));
