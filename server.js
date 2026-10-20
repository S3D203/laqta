
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
  console.log('✅ yt-dlp-exec 1.0.2 loaded');
  // Try get yt-dlp version
  ytdlp('--version').then(v=>console.log('yt-dlp binary version:', v)).catch(()=>{});
} catch (e) {
  console.log('⚠️ yt-dlp-exec not found:', e.message);
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

async function resolveUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html'
      },
      validateStatus: (s) => s < 400
    });
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

// ============ TIKTOK FALLBACK API (يحل مشكلة حظر Render) ============
async function getTikTokViaApi(url) {
  // جرب أكثر من API بديل
  const apis = [
    {
      name: 'tikwm',
      fn: async (u) => {
        const res = await axios.post('https://www.tikwm.com/api/', { url: u }, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.tikwm.com/'
          },
          timeout: 15000
        });
        if (res.data && res.data.data) {
          const d = res.data.data;
          return {
            title: d.title || 'TikTok Video',
            cover: d.cover || d.origin_cover || '',
            author: d.author?.nickname || d.author?.unique_id || '',
            videoUrl: d.play || d.hdplay || d.wmplay || '',
            musicUrl: d.music || ''
          };
        }
        throw new Error('tikwm no data');
      }
    },
    {
      name: 'tiklydown',
      fn: async (u) => {
        const res = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(u)}`, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.data && res.data.video) {
          return {
            title: res.data.title || 'TikTok Video',
            cover: res.data.cover || '',
            author: '',
            videoUrl: res.data.video.noWatermark || res.data.video.watermark || ''
          };
        }
        throw new Error('tiklydown no data');
      }
    }
  ];

  for (const api of apis) {
    try {
      console.log(`[TikTok API] Trying ${api.name} for ${url.substring(0,60)}`);
      const result = await api.fn(url);
      if (result.videoUrl) {
        console.log(`[TikTok API] ${api.name} success`);
        return result;
      }
    } catch (e) {
      console.log(`[TikTok API] ${api.name} failed: ${e.message.substring(0,100)}`);
    }
  }
  throw new Error('كل APIs فشلت - تيك توك محظور من IP السيرفر');
}

async function getTikTokInfoWithFallback(url) {
  let finalUrl = url;
  if (url.includes('tt.site') || url.includes('vm.tiktok') || url.includes('vt.tiktok')) {
    try {
      finalUrl = await resolveUrl(url);
      console.log(`[TikTok] Resolved ${url} -> ${finalUrl.substring(0,100)}`);
    } catch (e) {}
  }

  // أولاً جرب yt-dlp (لو اشتغل يكون أفضل جودة)
  if (ytdlp) {
    try {
      const info = await ytdlp(finalUrl, {
        dumpSingleJson: true,
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        addHeader: ['User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15', 'Referer:https://www.tiktok.com/']
      });
      console.log(`[TikTok] yt-dlp success: ${info.title?.substring(0,50)}`);
      return {
        title: info.title || 'TikTok Video',
        cover: info.thumbnail || '',
        author: info.uploader || '',
        duration: info.duration || 0,
        videoUrl: null, // yt-dlp will download directly
        method: 'yt-dlp',
        rawInfo: info,
        finalUrl
      };
    } catch (e1) {
      console.log(`[TikTok] yt-dlp failed: ${e1.message.substring(0,150)} - trying API fallback`);
    }
  }

  // Fallback: استخدم API بديل (يحل مشكلة حظر IP)
  try {
    const apiResult = await getTikTokViaApi(finalUrl);
    return {
      title: apiResult.title,
      cover: apiResult.cover,
      author: apiResult.author,
      duration: 0,
      videoUrl: apiResult.videoUrl,
      method: 'api-fallback',
      finalUrl
    };
  } catch (e) {
    throw new Error(`TikTok فشل: ${e.message}`);
  }
}

app.get('/api/info', async (req,res)=>{
  const {url}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  console.log(`[INFO] ${platform} | ${url.substring(0,100)} | yt-dlp:${!!ytdlp}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const {qualities}=filterYouTubeFormats(info);
      return res.json({platform:'youtube', title:info.videoDetails.title, safeTitle:sanitizeTitle(info.videoDetails.title), author:info.videoDetails.author?.name||'', duration:parseInt(info.videoDetails.lengthSeconds)||0, cover:info.videoDetails.thumbnails?.slice(-1)[0]?.url||'', qualities, originalUrl:url, method:'ytdl-isolated', ytdlpVersion: '1.0.2'});
    } else if(platform==='tiktok'){
      try{
        const info = await getTikTokInfoWithFallback(url);
        return res.json({
          platform:'tiktok',
          title:info.title||'TikTok Video',
          safeTitle:sanitizeTitle(info.title||'tiktok'),
          author:info.author||'',
          duration:info.duration||0,
          cover:info.cover||'',
          qualities:[{height:720, quality:'720p', label:'HD - بدون علامة مائية', hasAudio:true}],
          originalUrl:url,
          finalUrl: info.finalUrl,
          method: info.method,
          videoUrl: info.videoUrl ? 'ready' : 'yt-dlp',
          ytdlpVersion: '1.0.2 with API fallback'
        });
      }catch(e){
        console.error(`[TikTok INFO ERROR]:`, e.message);
        return res.status(200).json({
          platform:'tiktok',
          title:'TikTok Video',
          safeTitle:'tiktok_video',
          author:'',
          duration:0,
          cover:'',
          qualities:[],
          originalUrl:url,
          method:'failed',
          warning: e.message,
          errorIsolated: true,
          ytdlpVersion: '1.0.2',
          suggestion: 'تيك توك يحظر IP السيرفر - جرب API fallback أو استخدم سيرفر ب IP مختلف'
        });
      }
    } else {
      if(!ytdlp){
        return res.json({platform, title:`${platform} Video`, safeTitle:`${platform}_video`, author:'', duration:0, cover:'', qualities:[{height:720, quality:'720p', label:'HD', hasAudio:true}], originalUrl:url, method:'isolated-fallback', ytdlpVersion:'none'});
      }
      try{
        const info = await ytdlp(url,{dumpSingleJson:true, noPlaylist:true, noWarnings:true});
        return res.json({platform, title:info.title||`${platform} Video`, safeTitle:sanitizeTitle(info.title||platform), author:info.uploader||'', duration:info.duration||0, cover:info.thumbnail||'', qualities:[{height:720, quality:'720p', label:'HD', hasAudio:true}], originalUrl:url, method:'yt-dlp-isolated', ytdlpVersion:'1.0.2'});
      }catch(e){
        console.error(`[${platform} INFO ERROR]:`, e.message);
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
          errorIsolated: true,
          ytdlpVersion:'1.0.2'
        });
      }
    }
  }catch(e){
    console.error(`[INFO ERROR] ${platform}:`,e.message);
    res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true, ytdlpVersion:'1.0.2'});
  }
});

app.get('/api/download', async (req,res)=>{
  const {url, quality, title}=req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'video');
  const filename = `${safeTitle}.mp4`;
  const qNum = parseQuality(quality);
  console.log(`[MP4] ${platform} | ${qNum} | ${filename} | yt-dlp:${!!ytdlp}`);
  try{
    if(platform==='youtube'){
      const info = await getYouTubeInfo(url);
      const {videoWithAudio, videoOnly, audioOnly}=filterYouTubeFormats(info);
      let vf = videoWithAudio.find(f=>f.height===qNum) || videoWithAudio.sort((a,b)=>Math.abs(a.height-qNum)-Math.abs(b.height-qNum))[0] || videoOnly.find(f=>f.format?.height===qNum) || videoOnly[0];
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
    }else if(platform==='tiktok'){
      // TikTok download with API fallback
      let finalUrl = url;
      if(url.includes('tt.site') || url.includes('vm.tiktok') || url.includes('vt.tiktok')){
        try{ finalUrl = await resolveUrl(url); }catch(e){}
      }
      
      // أولاً جرب yt-dlp
      if(ytdlp){
        const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp4`);
        try{
          const formatStr = `best[height<=${qNum}]`;
          console.log(`[TikTok] Trying yt-dlp: ${finalUrl.substring(0,60)} format:${formatStr}`);
          await ytdlp(finalUrl,{
            output: tempFile,
            format: formatStr,
            noPlaylist: true,
            noWarnings: true
          });
          let finalFile = tempFile;
          if(!fs.existsSync(tempFile)) finalFile = tempFile+'.mp4';
          if(fs.existsSync(finalFile)){
            console.log(`[TikTok] yt-dlp download success`);
            res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
            res.setHeader('Content-Type','video/mp4');
            res.setHeader('Content-Length',fs.statSync(finalFile).size);
            fs.createReadStream(finalFile).pipe(res).on('finish',()=>{ fs.unlink(finalFile,()=>{}); });
            return;
          }
        }catch(e){
          console.log(`[TikTok] yt-dlp download failed: ${e.message.substring(0,150)} - trying API`);
        }
      }
      
      // Fallback: استخدم API مباشر
      try{
        const apiResult = await getTikTokViaApi(finalUrl);
        if(apiResult.videoUrl){
          console.log(`[TikTok] API download: ${apiResult.videoUrl.substring(0,80)}`);
          res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
          res.setHeader('Content-Type','video/mp4');
          // Stream directly from API URL
          const videoRes = await axios.get(apiResult.videoUrl, { responseType: 'stream', timeout: 30000, headers: { 'User-Agent':'Mozilla/5.0', 'Referer':'https://www.tikwm.com/' } });
          videoRes.data.pipe(res);
          return;
        }
      }catch(e){
        console.error(`[TikTok API DL ERROR]:`, e.message);
      }
      
      return res.status(500).json({error:`TikTok فشل التحميل - IP محظور. جرب تحديث yt-dlp: pip install -U yt-dlp`, platform:'tiktok', isolated:true, ytdlpVersion:'1.0.2', finalUrl});
    }else{
      if(!ytdlp) return res.status(500).json({error:`${platform} يحتاج yt-dlp`, platform, isolated:true, ytdlpVersion:'none'});
      let finalUrl = url;
      if(platform==='tiktok' && (url.includes('tt.site') || url.includes('vm.tiktok') || url.includes('vt.tiktok'))){
        try{ finalUrl = await resolveUrl(url); }catch(e){}
      }
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp4`);
      try{
        const formatStr = `best[height<=${qNum}]`;
        await ytdlp(finalUrl,{
          output: tempFile,
          format: formatStr,
          noPlaylist: true,
          noWarnings: true
        });
      }catch(e){
        console.error(`[${platform} DL ERROR]:`, e.message);
        return res.status(500).json({error:`${platform}: ${e.message.substring(0,200)}`, platform, isolated:true, ytdlpVersion:'1.0.2'});
      }
      let finalFile = tempFile;
      if(!fs.existsSync(tempFile)) finalFile = tempFile+'.mp4';
      if(!fs.existsSync(finalFile)){
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
    if(!res.headersSent) res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true, ytdlpVersion:'1.0.2'});
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
    if(!res.headersSent) res.status(500).json({error:`${platform}: ${e.message}`, platform, isolated:true, ytdlpVersion:'1.0.2'});
  }
});

app.get('/health',(req,res)=>{ 
  res.json({
    status:'ok', 
    version:'V35-tiktok-api-fallback',
    ytdlpVersion:'1.0.2',
    ytdlpLoaded: !!ytdlp,
    platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'],
    isolated:true,
    features:['mp4','mp3','anti-ban','tiktok-api-fallback','tt.site-resolver'],
    ts:new Date().toISOString()
  }); 
});

app.get('/',(req,res)=>{ res.json({name:'LAQTA V35 TikTok API Fallback', message:'تيك توك مصلح ب API بديل يحل مشكلة حظر IP', ytdlpVersion:'1.0.2', ytdlpLoaded:!!ytdlp}); });

app.listen(PORT,()=>{ console.log(`🚀 LAQTA V35 TikTok API Fallback on ${PORT} | yt-dlp: ${!!ytdlp} v1.0.2 | 6 platforms isolated`); });
