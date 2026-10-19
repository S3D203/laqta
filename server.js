
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0,80) || 'video';
}
function isUrlType(url, keywords) {
  return keywords.some(k => url.toLowerCase().includes(k));
}

async function getYtDlp() {
  try {
    const mod = await import('yt-dlp-exec');
    return mod.default || mod;
  } catch (e) {
    console.log("yt-dlp-exec not available, will use API fallbacks");
    return null;
  }
}

// 1. TIKTOK - tikwm API (أفضل حل)
async function getTikTok(url) {
  try {
    const res = await axios.post('https://www.tikwm.com/api/', { url }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    });
    if (res.data?.data) {
      const d = res.data.data;
      const qualities = [];
      if (d.hdplay) qualities.push({ height: 1080, quality: "1080p", label: "1080p HD - بدون علامة", url: d.hdplay, direct: true });
      if (d.play) qualities.push({ height: 720, quality: "720p", label: "720p - بدون علامة", url: d.play, direct: true });
      if (d.wmplay) qualities.push({ height: 720, quality: "720p-wm", label: "مع علامة", url: d.wmplay, direct: true });
      return {
        title: d.title || "TikTok Video",
        author: d.author?.nickname || "TikTok",
        cover: d.cover || "",
        qualities: qualities,
        originalUrl: url,
        safeTitle: sanitize(d.title || "tiktok"),
        platform: "TikTok"
      };
    }
  } catch (e) { console.log("TikTok API fail:", e.message?.substring(0,150)); }
  // Fallback yt-dlp
  return await getWithYtDlp(url, "TikTok");
}

// 2-6. باقي المنصات - yt-dlp مع حلول ذكية
async function getWithYtDlp(url, platformName) {
  const ytdlp = await getYtDlp();
  if (!ytdlp) throw new Error("yt-dlp not installed");
  
  // ترتيب المحاولات - Android يتجاوز حظر يوتيوب في Render
  const attempts = [
    { name: "android", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=android" } },
    { name: "ios", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true, extractorArgs: "youtube:player_client=ios" } },
    { name: "web", opts: { dumpSingleJson: true, noWarnings: true, noPlaylist: true } }
  ];
  
  for (const att of attempts) {
    try {
      console.log(`Trying ${platformName} via ${att.name}...`);
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
        qualities.push({ 
          height: f.height, 
          quality: `${f.height}p`, 
          label: f.height>=2160?`${f.height}p 4K`:f.height>=1080?`${f.height}p HD`:`${f.height}p`,
          direct: false
        });
        seen.add(f.height);
      }
      
      // لو ما فيه جودات فيديو، خذ best
      if (qualities.length===0 && info.height) {
        qualities.push({ height: info.height, quality: `${info.height}p`, label: `${info.height}p`, direct: false });
      }
      
      if (qualities.length>0) {
        return {
          title: info.title || `${platformName} Video`,
          author: info.uploader || info.channel || platformName,
          cover: info.thumbnail || "",
          qualities: qualities.sort((a,b)=>b.height-a.height),
          originalUrl: url,
          safeTitle: sanitize(info.title || "video"),
          platform: platformName,
          duration: info.duration
        };
      }
    } catch (e) {
      console.log(`${platformName} ${att.name} failed: ${e.message?.substring(0,200)}`);
    }
  }
  throw new Error(`فشل جلب فيديو ${platformName}`);
}

app.get("/api/info", async (req,res)=>{
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "الرابط ناقص" });
  
  console.log("\n=== NEW REQUEST ===", url.substring(0,100));
  
  try {
    let data;
    
    if (isUrlType(url, ['tiktok.com', 'vm.tiktok', 'vt.tiktok'])) {
      data = await getTikTok(url);
    } else if (isUrlType(url, ['youtube.com', 'youtu.be'])) {
      data = await getWithYtDlp(url, "YouTube");
    } else if (isUrlType(url, ['instagram.com', 'instagr.am'])) {
      data = await getWithYtDlp(url, "Instagram");
    } else if (isUrlType(url, ['facebook.com', 'fb.watch', 'fb.com'])) {
      data = await getWithYtDlp(url, "Facebook");
    } else if (isUrlType(url, ['twitter.com', 'x.com', 't.co'])) {
      data = await getWithYtDlp(url, "Twitter/X");
    } else if (isUrlType(url, ['snapchat.com', 'snap.com'])) {
      data = await getWithYtDlp(url, "Snapchat");
    } else {
      // منصة غير معروفة - جرب yt-dlp
      data = await getWithYtDlp(url, "Video");
    }
    
    if (!data) throw new Error("ما قدرنا نجيب الفيديو");
    res.json({ success: true, ...data });
    
  } catch (err) {
    console.error("INFO ERROR:", err.message);
    
    // رسائل واضحة للمستخدم
    let userMsg = err.message;
    if (err.message.includes('Sign in') || err.message.includes('bot') || err.message.includes('403')) {
      userMsg = "يوتيوب حظر سيرفر Render مؤقتاً (مشكلة معروفة). التيك توك وانستا وفيسبوك وتويتر شغالين 100%. لليوتيوب استخدم VPN أو جرب بعد شوي.";
    }
    
    res.status(500).json({ error: userMsg, platform: "unknown" });
  }
});

app.get("/api/download", async (req,res)=>{
  const { title, quality, originalUrl, directUrl } = req.query;
  if (!originalUrl) return res.status(400).send("url missing");
  
  const height = parseInt(quality) || 720;
  const safeTitle = sanitize(title || "video");
  const encodedName = encodeURIComponent(safeTitle + '.mp4');
  
  console.log(`DOWNLOAD ${height}p: ${safeTitle} - direct=${!!directUrl}`);
  
  try {
    // تحميل مباشر (تيك توك)
    if (directUrl) {
      const response = await axios({
        method: 'GET', url: directUrl, responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tikwm.com/' },
        timeout: 30000
      });
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`);
      res.setHeader("Content-Type", "video/mp4");
      if (response.headers['content-length']) res.setHeader("Content-Length", response.headers['content-length']);
      response.data.pipe(res);
      return;
    }
    
    // yt-dlp للباقي
    const ytdlp = await getYtDlp();
    if (!ytdlp) throw new Error("yt-dlp not available");
    
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    const { default: os } = await import('os');
    
    const tmpFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${height}p.mp4`);
    const formatStr = `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
    
    await ytdlp(originalUrl, {
      format: formatStr,
      output: tmpFile,
      mergeOutputFormat: "mp4",
      noWarnings: true,
      noPlaylist: true,
      extractorArgs: "youtube:player_client=android"
    });
    
    if (!fs.existsSync(tmpFile)) throw new Error("Download failed");
    const stat = fs.statSync(tmpFile);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', ()=>{ try{fs.unlinkSync(tmpFile);}catch{} });
    
  } catch (e) {
    console.error("Download error:", e.message);
    if (!res.headersSent) res.status(500).send("فشل التحميل: " + e.message);
    else res.end();
  }
});

app.get("/api/status", (req,res)=>{
  res.json({
    status: "Live ✓",
    version: "V32 - 6 Platforms",
    platforms: {
      "TikTok": "✓ يعمل 100% (tikwm API)",
      "Instagram": "✓ يعمل (yt-dlp)",
      "Facebook": "✓ يعمل (yt-dlp)",
      "Twitter/X": "✓ يعمل (yt-dlp)",
      "Snapchat": "✓ يعمل (yt-dlp)",
      "YouTube": "⚠ يعمل مع Android client، قد يحتاج VPN إذا حظره Render"
    },
    note: "Render يحظر يوتيوب أحياناً بسبب IP مشترك، باقي المنصات شغالة تمام"
  });
});

app.get("/", (req,res)=> res.send("Laqta V32 - 6 Platforms: TikTok, YouTube, Instagram, Facebook, Twitter, Snapchat - Live"));

app.listen(PORT, ()=> console.log(`Laqta V32 - 6 Platforms on ${PORT}`));
