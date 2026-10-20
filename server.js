
const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

let ytdlp = null;
try {
  ytdlp = require('yt-dlp-exec');
  console.log('✅ yt-dlp-exec loaded');
} catch (e) {
  console.log('⚠️ yt-dlp-exec not found');
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com') || u.includes('tt.site') || u.includes('vm.tiktok') || u.includes('vt.tiktok')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  if (u.includes('snapchat.com')) return 'snapchat';
  return 'generic';
}

function parseQuality(q){
  if(!q) return 720;
  const num = parseInt(String(q).replace(/[^0-9]/g,''));
  return isNaN(num) ? 720 : num;
}

function sanitizeTitle(t) {
  if (!t) return 'video';
  return t.replace(/[<>:"/\\|?*\x00-\x1F]/g,'').replace(/\s+/g,'_').substring(0,80)||'video';
}

// Resolve short URLs like tt.site, vm.tiktok
async function resolveUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
      },
      validateStatus: (s) => s < 400
    });
    // axios follows redirects, final url is in request
    return res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || shortUrl;
  } catch (e) {
    return e.response?.request?.res?.responseUrl || shortUrl;
  }
}

async function getYouTubeInfo(url) {
  const info = await ytdl.getInfo(url);
  return info;
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
        map.set(h,{height:h, quality:h+'p', label:h+'p (دمج)', bitrate:f.bitrate, hasAudio:false, format:f});
      }
    });
  }
  return {qualities:Array.from(map.values()).sort((a,b)=>b.height-a.height), videoWithAudio, videoOnly, audioOnly};
}

// TikTok with better options and fallback
async function getTikTokInfoWithFallback(url) {
  if (!ytdlp) throw new Error('yt-dlp not loaded');
  
  let finalUrl = url;
  // Resolve short url first
  if (url.includes('tt.site') || url.includes('vm.tiktok') || url.includes('vt.tiktok')) {
    try {
      finalUrl = await resolveUrl(url);
      console.log(`[TikTok] Resolved ${url} -> ${finalUrl.substring(0,100)}`);
    } catch (e) {
      console.log(`[TikTok] Resolve failed, using original`);
    }
  }

  const ytDlpOptions = {
    dumpSingleJson: true,
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    addHeader: [
      'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
      'Referer:https://www.tiktok.com/'
    ],
    // Update yt-dlp to latest TikTok workaround
    extractorArgs: 'tiktok:api_hostname=api16-normal-c-useast2a.tiktokv.com;app_info=7355728856975265797'
  };

  try {
    const info = await ytdlp(finalUrl, ytDlpOptions);
    return info;
  } catch (e1) {
    console.log(`[TikTok] First try failed: ${e1.message.substring(0,200)}`);
    // Retry with different options - without addHeader, with extractor args
    try {
      const info2 = await ytdlp(finalUrl, {
        dumpSingleJson: true,
        noPlaylist: true,
        extractorArgs: 'tiktok:api_hostname=api16-normal-c-useast2a.tiktokv.com'
      });
      return info2;
    } catch (e2) {
      console.log(`[TikTok] Second try failed: ${e2.message.substring(0,200)}`);
      throw new Error(`TikTok محظور مؤقتاً من السيرفر. جرب رابط مباشر من tiktok.com بدون tt.site. الخطأ: ${e1.message.substring(0,100)}`);
    }
  }
}

app.get('/api/info', async (req,res)=>{
  const {url}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  console.log(`[INFO] ${platform} | ${url.substring(0,100)}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const {qualities}=filterYouTubeFormats(info);
      return res.json({platform:'youtube', title:info.videoDetails.title, safeTitle:sanitizeTitle(info.videoDetails.title), author:info.videoDetails.author?.name||'', duration:parseInt(info.videoDetails.lengthSeconds)||0, cover:info.videoDetails.thumbnails?.slice(-1)[0]?.url||'', qualities, originalUrl:url, method:'ytdl-isolated'});
    } else if(platform==='tiktok'){
      try{
        const info = await getTikTokInfoWithFallback(url);
        return res.json({platform:'tiktok', title:info.title||'TikTok Video', safeTitle:sanitizeTitle(info.title||'tiktok'), author:info.uploader||'', duration:info.duration||0, cover:info.thumbnail||'', qualities:[{height:720, quality:'720p', label:'HD - بدون علامة مائية', hasAudio:true}], originalUrl:url, method:'yt-dlp-tiktok-isolated'});
      }catch(e){
        console.error(`[TikTok INFO ERROR]:`, e.message);
        // Isolated error - return 200 with fallback so frontend shows message but other platforms work
        return res.status(200).json({
          platform:'tiktok',
          title:'TikTok Video',
          safeTitle:'tiktok_video',
          author:'',
          duration:0,
          cover:'',
          qualities:[],
          originalUrl:url,
          method:'tiktok-fallback',
          warning: e.message,
          errorIsolated: true,
          suggestion: 'جرب رابط tiktok.com مباشر بدل tt.site، أو حدث yt-dlp: pip install -U yt-dlp'
        });
      }
    } else {
      if(!ytdlp){
        return res.json({platform, title:`${platform} Video`, safeTitle:`${platform}_video`, author:'', duration:0, cover:'', qualities:[{height:720, quality:'720p', label:'HD', hasAudio:true}], originalUrl:url, method:'isolated-fallback'});
      }
      try{
        const info = await ytdlp(url,{dumpSingleJson:true, noPlaylist:true, noWarnings:true});
        return res.json({platform, title:info.title||`${platform} Video`, safeTitle:sanitizeTitle(info.title||platform), author:info.uploader||'', duration:info.duration||0, cover:info.thumbnail||'', qualities:[{height:720, quality:'720p', label:'HD', hasAudio:true}], originalUrl:url, method:'yt-dlp-isolated'});
      }catch(e){
        console.error(`[${platform} INFO ERROR]:`, e.message);
        // Isolated - don't crash other platforms
        return res.status(200).json({
          platform,
          title:`${platform} Video`,
          safeTitle:`${platform}_video`,
          author:'',
          duration:0,
          cover:'',
          qualities:[],
          originalUrl:url,
          warning: e.message,
          errorIsolated: true
        });
      }
    }
  }catch(e){
    console.error(`[INFO ERROR] ${platform}:`,e.message);
    res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true});
  }
});

app.get('/api/download', async (req,res)=>{
  const {url, quality, title}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'video');
  const filename = `${safeTitle}.mp4`;
  const qParsed = parseQuality(quality);
  console.log(`[MP4] ${platform} | ${qParsed} (raw:${quality}) | ${filename}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const {videoWithAudio, videoOnly, audioOnly}=filterYouTubeFormats(info);
      const target = parseQuality(quality);
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
      if(!ytdlp) return res.status(500).json({error:`${platform} يحتاج yt-dlp`, platform, isolated:true});
      
      // For tiktok, resolve short url first
      let finalUrl = url;
      if(platform==='tiktok' && (url.includes('tt.site') || url.includes('vm.tiktok') || url.includes('vt.tiktok'))){
        try{ finalUrl = await resolveUrl(url); }catch(e){}
      }
      
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp4`);
      try{
        const qNum = parseQuality(quality);
        const formatStr = `best[height<=${qNum}]`;
        await ytdlp(finalUrl,{
          output: tempFile,
          format: formatStr,
          noPlaylist: true,
          noWarnings: true,
          addHeader: platform==='tiktok' ? ['User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'] : []
        });
      }catch(e){
        console.error(`[${platform} DL ERROR]:`, e.message);
        return res.status(500).json({error:`${platform}: ${e.message.substring(0,200)} - جرب رابط مباشر`, platform, isolated:true});
      }
      
      let finalFile = tempFile;
      if(!fs.existsSync(tempFile)){
        finalFile = tempFile+'.mp4';
      }
      if(!fs.existsSync(finalFile)){
        // search
        const found = fs.readdirSync(os.tmpdir()).find(f=>f.includes(safeTitle.substring(0,10)) && f.endsWith('.mp4'));
        if(found) finalFile = path.join(os.tmpdir(), found);
      }
      if(!fs.existsSync(finalFile)) throw new Error('فشل تحميل');
      
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
      return;
    }else{
      if(!ytdlp) return res.status(500).json({error:`${platform} MP3 يحتاج yt-dlp`, platform, isolated:true});
      let finalUrl = url;
      if(platform==='tiktok' && (url.includes('tt.site') || url.includes('vm.tiktok'))){
        try{ finalUrl = await resolveUrl(url); }catch(e){}
      }
      const tempBase = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}`);
      await ytdlp(finalUrl,{output:tempBase+'.%(ext)s', extractAudio:true, audioFormat:'mp3', audioQuality:0, noPlaylist:true});
      const mp3File = tempBase+'.mp3';
      let finalFile = mp3File;
      if(!fs.existsSync(mp3File)){
        const found = fs.readdirSync(os.tmpdir()).find(f=>f.startsWith(path.basename(tempBase)) && f.endsWith('.mp3'));
        if(found) finalFile = path.join(os.tmpdir(), found);
      }
      if(!fs.existsSync(finalFile)) throw new Error('فشل MP3');
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

app.get('/health',(req,res)=>{ res.json({status:'ok', version:'V33-tiktok-fix', platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'], isolated:true, ytdlp:!!ytdlp, fix:'tt.site resolved + isolated errors', ts:new Date().toISOString()}); });
app.get('/',(req,res)=>{ res.json({name:'LAQTA V33 TikTok Fix', message:'تيك توك مصلح - يدعم tt.site + معزول', ytdlp:!!ytdlp}); });

app.listen(PORT,()=>{ console.log(`🚀 LAQTA V33 TikTok Fix on ${PORT} | yt-dlp: ${!!ytdlp}`); });
