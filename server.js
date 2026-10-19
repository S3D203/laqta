
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0,80) || 'video';
}

console.log("=== Laqta V33 - NO YTDLP - Pure API ===");

// TikTok - tikwm
async function getTikTok(url) {
  console.log("[TikTok] Fetching:", url.substring(0,60));
  const res = await axios.post('https://www.tikwm.com/api/', { url }, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    timeout: 20000
  });
  if (!res.data?.data) throw new Error("tikwm empty");
  const d = res.data.data;
  console.log("[TikTok] Success:", d.title?.substring(0,40));
  const qualities = [];
  if (d.hdplay) qualities.push({ height: 1080, quality: "1080p", label: "1080p HD - بدون علامة", url: d.hdplay, direct: true });
  if (d.play) qualities.push({ height: 720, quality: "720p", label: "720p - بدون علامة", url: d.play, direct: true });
  if (qualities.length===0) throw new Error("No TikTok URLs");
  return {
    title: d.title || "TikTok Video",
    author: d.author?.nickname || "TikTok",
    cover: d.cover || "",
    qualities,
    originalUrl: url,
    safeTitle: sanitize(d.title || "tiktok"),
    platform: "TikTok"
  };
}

// All platforms via cobalt API (supports YouTube, Instagram, Facebook, Twitter, etc)
async function getViaCobalt(url) {
  console.log("[Cobalt] Fetching:", url.substring(0,60));
  // cobalt API - public instance
  const res = await axios.post('https://co.wuk.sh/api/json', {
    url: url,
    vQuality: "1080",
    filenamePattern: "basic",
    isAudioOnly: false
  }, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    timeout: 30000
  });
  
  console.log("[Cobalt] Response:", JSON.stringify(res.data).substring(0,500));
  
  if (!res.data || res.data.status === "error") {
    throw new Error(res.data?.text || "Cobalt error");
  }
  
  // Cobalt returns url or picker
  let qualities = [];
  if (res.data.picker) {
    // Multiple qualities
    for (const item of res.data.picker) {
      const h = item.url?.includes('1080') ? 1080 : item.url?.includes('720') ? 720 : 480;
      qualities.push({
        height: h,
        quality: `${h}p`,
        label: `${h}p`,
        url: item.url,
        direct: true
      });
    }
  } else if (res.data.url) {
    qualities.push({
      height: 720,
      quality: "720p",
      label: "MP4",
      url: res.data.url,
      direct: true
    });
  }
  
  if (qualities.length===0) throw new Error("Cobalt returned no URL");
  
  return {
    title: res.data.filename || "Video",
    author: "User",
    cover: "",
    qualities: qualities.sort((a,b)=>b.height-a.height),
    originalUrl: url,
    safeTitle: sanitize(res.data.filename || "video"),
    platform: "Video"
  };
}

app.get("/api/info", async (req,res)=>{
  const { url } = req.query;
  console.log("\n>>> /api/info:", url);
  if (!url) return res.status(400).json({ error: "الرابط ناقص" });
  
  try {
    let data;
    if (url.includes('tiktok.com') || url.includes('vm.tiktok') || url.includes('vt.tiktok')) {
      try {
        data = await getTikTok(url);
      } catch (e) {
        console.log("TikTok failed, trying Cobalt fallback:", e.message);
        data = await getViaCobalt(url);
      }
    } else {
      data = await getViaCobalt(url);
    }
    console.log("SUCCESS:", data.platform, data.qualities.length, "qualities");
    res.json({ success: true, ...data });
  } catch (err) {
    console.error("ERROR /api/info:", err.message, err.response?.data);
    res.status(500).json({ 
      error: err.message || "فشل جلب الفيديو",
      details: err.response?.data || err.stack?.substring(0,300)
    });
  }
});

app.get("/api/download", async (req,res)=>{
  const { title, directUrl, originalUrl } = req.query;
  const videoUrl = directUrl || originalUrl;
  console.log(">>> /api/download:", videoUrl?.substring(0,80));
  if (!videoUrl) return res.status(400).send("url missing");
  
  const safeTitle = sanitize(title || "video");
  const encodedName = encodeURIComponent(safeTitle + '.mp4');
  
  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 60000
    });
    
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader("Content-Type", "video/mp4");
    if (response.headers['content-length']) {
      res.setHeader("Content-Length", response.headers['content-length']);
    }
    
    response.data.pipe(res);
  } catch (e) {
    console.error("Download error:", e.message);
    res.status(500).send("فشل التحميل: " + e.message);
  }
});

app.get("/api/test", async (req,res)=>{
  res.json({ status: "OK", version: "V33 NO-YTDLP", time: new Date().toISOString() });
});

app.get("/", (req,res)=> res.json({ 
  status: "Laqta V33 - 6 Platforms - NO YT-DLP - Live ✓",
  endpoints: ["/api/info?url=...", "/api/download?directUrl=...", "/api/test"],
  platforms: ["TikTok (tikwm)", "YouTube/Instagram/Facebook/Twitter via Cobalt"]
}));

app.listen(PORT, ()=> console.log(`Laqta V33 NO-YTDLP on ${PORT}`));
