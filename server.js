
const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Try load yt-dlp-exec (optional but needed for non-youtube)
let ytdlp = null;
try {
  ytdlp = require('yt-dlp-exec');
  console.log('✅ yt-dlp-exec loaded - all platforms enabled');
} catch (e) {
  console.log('⚠️ yt-dlp-exec not found - youtube only mode');
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  if (u.includes('snapchat.com')) return 'snapchat';
  return 'generic';
}

function sanitizeTitle(t) {
  if (!t) return 'video';
  return t.replace(/[<>:"/\\|?*\x00-\x1F]/g,'').replace(/\s+/g,'_').substring(0,80)||'video';
}

async function getYouTubeInfo(url) {
  try {
    const info = await ytdl.getInfo(url);
    return info;
  } catch (e) {
    throw e;
  }
}

function filterYouTubeFormats(info) {
  const formats = (info.formats||[]).filter(f=>f.url);
  const videoWithAudio = formats.filter(f=>f.hasVideo&&f.hasAudio&&f.container==='mp4');
  const videoOnly = formats.filter(f=>f.hasVideo&&!f.hasAudio);
  const audioOnly = formats.filter(f=>!f.hasVideo&&f.hasAudio);
  const map = new Map();
  videoWithAudio.forEach(f=>{
    const h=f.height||0;
    if(h>=144 && (!map.has(h) || f.bitrate>(map.get(h).bitrate||0))){
      map.set(h,{height:h, quality:h+'p', label:h+'p'+(h>=1080?' HD':''), bitrate:f.bitrate, hasAudio:true, format:f});
    }
  });
  if(map.size===0){
    videoOnly.forEach(f=>{
      const h=f.height||0;
      if(h>=144 && !map.has(h)){
        map.set(h,{height:h, quality:h+'p', label:h+'p (دمج)', bitrate:f.bitrate, hasAudio:false, format:f, needsMux:true});
      }
    });
  }
  return {qualities:Array.from(map.values()).sort((a,b)=>b.height-a.height), videoWithAudio, videoOnly, audioOnly};
}

// ================= INFO - منفصل لكل منصة =================
app.get('/api/info', async (req,res)=>{
  const {url}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  console.log(`[INFO] ${platform} | ${url.substring(0,80)}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const {qualities}=filterYouTubeFormats(info);
      return res.json({platform:'youtube', title:info.videoDetails.title, safeTitle:sanitizeTitle(info.videoDetails.title), author:info.videoDetails.author?.name||'', duration:parseInt(info.videoDetails.lengthSeconds)||0, durationStr:'', cover:info.videoDetails.thumbnails?.slice(-1)[0]?.url||'', qualities, originalUrl:url, method:'ytdl-isolated'});
    } else {
      if(!ytdlp){
        // Fallback isolated info
        return res.json({platform, title:`${platform} Video`, safeTitle:`${platform}_video`, author:'', duration:0, cover:'', qualities:[{height:720, quality:'720p', label:'HD', hasAudio:true}], originalUrl:url, method:'isolated-fallback'});
      }
      const info = await ytdlp(url,{dumpSingleJson:true, noPlaylist:true, noWarnings:true});
      return res.json({platform, title:info.title||`${platform} Video`, safeTitle:sanitizeTitle(info.title||platform), author:info.uploader||'', duration:info.duration||0, cover:info.thumbnail||'', qualities:[{height:info.height||720, quality:(info.height||720)+'p', label:'HD', hasAudio:true}], originalUrl:url, method:'yt-dlp-isolated'});
    }
  }catch(e){
    console.error(`[INFO ERROR] ${platform}:`,e.message);
    res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true});
  }
});

// ================= DOWNLOAD MP4 - منفصل =================
app.get('/api/download', async (req,res)=>{
  const {url, quality, title}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'video');
  const filename = `${safeTitle}.mp4`;
  console.log(`[MP4] ${platform} | ${quality} | ${filename}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const {videoWithAudio, videoOnly, audioOnly}=filterYouTubeFormats(info);
      const target = parseInt(quality)||720;
      let vf = videoWithAudio.find(f=>f.height===target) || videoWithAudio.sort((a,b)=>Math.abs(a.height-target)-Math.abs(b.height-target))[0] || videoOnly.find(f=>f.format?.height===target) || videoOnly[0];
      if(!vf) throw new Error('جودة غير موجودة');
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type','video/mp4');
      if(vf.hasAudio){
        const stream = ytdl.downloadFromInfo(info,{format:vf.format});
        stream.pipe(res);
        stream.on('error',e=>{ if(!res.headersSent) res.status(500).json({error:e.message}); });
      }else{
        const af = audioOnly.sort((a,b)=>b.bitrate-a.bitrate)[0] || info.formats.find(f=>f.hasAudio);
        const tmp = os.tmpdir();
        const vp = path.join(tmp,`v_${Date.now()}.mp4`);
        const ap = path.join(tmp,`a_${Date.now()}.mp4`);
        const op = path.join(tmp,`out_${Date.now()}.mp4`);
        const dl = (fmt,fp)=>new Promise((resolve,reject)=>{
          const s = ytdl.downloadFromInfo(info,{format:fmt.format||fmt});
          const ws = fs.createWriteStream(fp);
          s.pipe(ws); ws.on('finish',resolve); ws.on('error',reject); s.on('error',reject);
        });
        await dl(vf,vp);
        await dl({format:af},ap);
        ffmpeg().input(vp).input(ap).outputOptions(['-c:v copy','-c:a aac','-shortest']).save(op)
          .on('end',()=>{ res.setHeader('Content-Length',fs.statSync(op).size); fs.createReadStream(op).pipe(res).on('finish',()=>{ try{fs.unlinkSync(vp);fs.unlinkSync(ap);fs.unlinkSync(op);}catch(e){} }); })
          .on('error',e=>{ if(!res.headersSent) res.status(500).json({error:'فشل دمج'}); });
      }
      return;
    }else{
      if(!ytdlp) return res.status(500).json({error:`${platform} يحتاج yt-dlp-exec - ثبته`, platform, isolated:true});
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp4`);
      await ytdlp(url,{output:tempFile, format:`best[height<=${quality||720}]`, noPlaylist:true, noWarnings:true});
      // Find actual file (yt-dlp may add ext)
      let finalFile = tempFile;
      if(!fs.existsSync(tempFile)){
        const files = fs.readdirSync(os.tmpdir()).filter(f=>f.includes(String(Date.now()).substring(0,8)));
        // try find mp4
        const found = fs.readdirSync(os.tmpdir()).find(f=>f.endsWith('.mp4') && f.includes(safeTitle.substring(0,10)));
        if(found) finalFile = path.join(os.tmpdir(), found);
      }
      if(!fs.existsSync(finalFile)){
        // fallback: use tempFile.mp4
        finalFile = tempFile+'.mp4';
      }
      if(!fs.existsSync(finalFile)){
        throw new Error('فشل تحميل الملف من yt-dlp');
      }
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type','video/mp4');
      res.setHeader('Content-Length',fs.statSync(finalFile).size);
      fs.createReadStream(finalFile).pipe(res).on('finish',()=>{ fs.unlink(finalFile,()=>{}); });
      return;
    }
  }catch(e){
    console.error(`[MP4 ERROR] ${platform}:`,e.message);
    if(!res.headersSent) res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true});
  }
});

// ================= DOWNLOAD MP3 - منفصل =================
app.get('/api/download-mp3', async (req,res)=>{
  const {url, title}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'audio');
  const filename = `${safeTitle}.mp3`;
  console.log(`[MP3] ${platform} | ${filename}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const af = info.formats.filter(f=>f.hasAudio && !f.hasVideo).sort((a,b)=>b.bitrate-a.bitrate)[0] || info.formats.find(f=>f.hasAudio);
      if(!af) throw new Error('لا يوجد صوت');
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type','audio/mpeg');
      const stream = ytdl.downloadFromInfo(info,{format:af});
      const tmpA = path.join(os.tmpdir(),`a_${Date.now()}.mp4`);
      const tmpM = path.join(os.tmpdir(),`${Date.now()}.mp3`);
      const ws = fs.createWriteStream(tmpA);
      stream.pipe(ws);
      ws.on('finish',()=>{
        ffmpeg(tmpA).audioCodec('libmp3lame').audioBitrate(192).save(tmpM)
          .on('end',()=>{ res.setHeader('Content-Length',fs.statSync(tmpM).size); fs.createReadStream(tmpM).pipe(res).on('finish',()=>{ try{fs.unlinkSync(tmpA);fs.unlinkSync(tmpM);}catch(e){} }); })
          .on('error',e=>{ if(!res.headersSent) res.status(500).json({error:e.message}); });
      });
      stream.on('error',e=>{ if(!res.headersSent) res.status(500).json({error:e.message}); });
      return;
    }else{
      if(!ytdlp) return res.status(500).json({error:`${platform} MP3 يحتاج yt-dlp-exec`, platform, isolated:true});
      const tempBase = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}`);
      await ytdlp(url,{output:tempBase+'.%(ext)s', extractAudio:true, audioFormat:'mp3', audioQuality:0, noPlaylist:true});
      const mp3File = tempBase+'.mp3';
      let finalFile = mp3File;
      if(!fs.existsSync(mp3File)){
        const found = fs.readdirSync(os.tmpdir()).find(f=>f.startsWith(path.basename(tempBase)) && f.endsWith('.mp3'));
        if(found) finalFile = path.join(os.tmpdir(), found);
      }
      if(!fs.existsSync(finalFile)) throw new Error('فشل تحويل MP3');
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type','audio/mpeg');
      res.setHeader('Content-Length',fs.statSync(finalFile).size);
      fs.createReadStream(finalFile).pipe(res).on('finish',()=>{ fs.unlink(finalFile,()=>{}); });
      return;
    }
  }catch(e){
    console.error(`[MP3 ERROR] ${platform}:`,e.message);
    if(!res.headersSent) res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true});
  }
});

app.get('/health',(req,res)=>{ res.json({status:'ok', version:'V32-full-isolated', platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'], isolated:true, ytdlp:!!ytdlp, features:['mp4','mp3','anti-ban'], ts:new Date().toISOString()}); });
app.get('/',(req,res)=>{ res.json({name:'LAQTA V32 Full Isolated', message:'كل منصة معزولة - يوتيوب + تيك توك + انستا + فيسبوك + تويتر + سناب', ytdlp:!!ytdlp}); });

app.listen(PORT,()=>{ console.log(`🚀 LAQTA V32 Full Isolated on ${PORT} | yt-dlp: ${!!ytdlp}`); });
