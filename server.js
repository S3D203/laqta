
const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { execSync } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const PORT = process.env.PORT || 10000;

let ytdlp = null;
let ytDlpVersion = 'unknown';
try {
  ytdlp = require('yt-dlp-exec');
  console.log('✅ yt-dlp-exec loaded');
  ytdlp('--version').then(v => {
    ytDlpVersion = v.trim();
    console.log('yt-dlp binary version:', ytDlpVersion);
  }).catch(()=>{});
  try { execSync('yt-dlp --version', {timeout:5000}); } catch(e){}
} catch (e) {
  console.log('⚠️ yt-dlp-exec not found:', e.message);
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com') || u.includes('tt.site') || u.includes('vm.tiktok') || u.includes('vt.tiktok')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  if (u.includes('snapchat.com')) return 'snapchat';
  return 'generic';
}

function sanitizeTitle(t) {
  if (!t) return 'video';
  return t.replace(/[<>:"/\\|?*\x00-\x1F]/g,'').replace(/\s+/g,'_').substring(0,80)||'video';
}

function parseQuality(q){
  if(!q) return 1080;
  const num = parseInt(String(q).replace(/[^0-9]/g,''));
  return isNaN(num) ? 1080 : num;
}

async function resolveUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 10,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml'
      },
      validateStatus: s => s < 400
    });
    return res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || shortUrl;
  } catch (e) {
    return e.response?.request?.res?.responseUrl || shortUrl;
  }
}

// === TikTok APIs - يحل مشكلة الحظر ويختار جودة عالية H264 ===
async function getTikTokViaApi(url){
  const apis = [
    {
      name: 'tikwm.com',
      fn: async (u) => {
        const res = await axios.post('https://www.tikwm.com/api/', { url: u }, {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125 Safari/537.36', 'Referer': 'https://www.tikwm.com/' },
          timeout: 20000
        });
        if(res.data?.data){
          const d = res.data.data;
          // نفضل H264 على HEVC عشان يشتغل بدون كودك
          // play = عادة H264 720p بدون علامة
          // hdplay = عادة HEVC 1080p - جودة اعلى لكن يحتاج تحويل
          const h264Url = d.play || d.wmplay;
          const hevcUrl = d.hdplay || d.play_hd;
          // نرجع الاثنين ونختار لاحقا
          if(h264Url || hevcUrl){
            return { 
              title: d.title || 'TikTok Video', 
              cover: d.cover || d.ai_dynamic_cover || '', 
              author: d.author?.nickname || '', 
              videoUrl: h264Url || hevcUrl, // نفضل H264
              videoUrlHd: hevcUrl || h264Url,
              videoUrlH264: h264Url,
              videoUrlHevc: hevcUrl,
              musicUrl: d.music || '',
              isHevc: !h264Url && !!hevcUrl
            };
          }
        }
        throw new Error('tikwm empty');
      }
    },
    {
      name: 'tikmate',
      fn: async (u) => {
        const res = await axios.post('https://api.tikmate.app/api/lookup', { url: u }, {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          timeout: 15000
        });
        if(res.data?.token){
          const token = res.data.token;
          const id = res.data.id;
          const videoUrl = `https://tikmate.app/download/${token}/${id}.mp4`;
          return { title: 'TikTok Video', cover: '', author: '', videoUrl, videoUrlH264: videoUrl, isHevc: false };
        }
        throw new Error('tikmate no token');
      }
    }
  ];
  for(const api of apis){
    try{
      console.log(`[TikTok API] Trying ${api.name}`);
      const r = await api.fn(url);
      if(r.videoUrl){ console.log(`[TikTok API] ${api.name} OK - H264:${!!r.videoUrlH264} HEVC:${!!r.videoUrlHevc}`); return r; }
    }catch(e){ console.log(`[TikTok API] ${api.name} failed: ${e.message.slice(0,150)}`); }
  }
  throw new Error('كل APIs الخارجية فشلت');
}

async function getInfoViaYtDlp(url, platform){
  if(!ytdlp) throw new Error('yt-dlp غير محمل');
  
  const isYoutube = platform === 'youtube';
  const isSnap = platform === 'snapchat';
  
  // خيارات اقوى لليوتيوب
  const opts = {
    dumpSingleJson: true,
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: false, // نبي اعلى جودة مو free formats فقط
    addHeader: [
      'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language:en-US,en;q=0.9,ar;q=0.8',
      'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    ],
    extractorArgs: isYoutube 
      ? 'youtube:player_client=android,web,ios;player_skip=webpage,configs;po_token=android+*'
      : 'youtube:player_client=android',
    retries: 3,
    fragmentRetries: 3,
    socketTimeout: 30,
  };
  
  // اضافة referer حسب المنصة
  if(isYoutube){
    opts.addHeader.push('Referer:https://www.youtube.com/');
    opts.addHeader.push('Origin:https://www.youtube.com');
  }
  if(isSnap){
    opts.addHeader.push('Referer:https://www.snapchat.com/');
  }

  const info = await ytdlp(url, opts);
  return info;
}

function transcodeToH264(inputPath, outputPath){
  return new Promise((resolve, reject)=>{
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-pix_fmt yuv420p'
      ])
      .on('end', ()=> resolve(outputPath))
      .on('error', (err)=> reject(err))
      .save(outputPath);
  });
}

function checkIsHevc(filePath){
  return new Promise((resolve)=>{
    ffmpeg.ffprobe(filePath, (err, metadata)=>{
      if(err) return resolve(false);
      const videoStream = metadata.streams.find(s=>s.codec_type==='video');
      if(!videoStream) return resolve(false);
      const codec = (videoStream.codec_name || '').toLowerCase();
      console.log(`[Probe] codec=${codec} ${videoStream.width}x${videoStream.height}`);
      resolve(codec === 'hevc' || codec === 'h265');
    });
  });
}

function cleanTmp(){
  try{
    const files = fs.readdirSync(os.tmpdir());
    const now = Date.now();
    for(const f of files){
      if(f.includes('video') || f.endsWith('.mp4') || f.endsWith('.mp3') || f.includes('tiktok')){
        const fp = path.join(os.tmpdir(), f);
        try{ const st = fs.statSync(fp); if(now - st.mtimeMs > 1000*60*30) fs.unlinkSync(fp); }catch(e){}
      }
    }
  }catch(e){}
}
setInterval(cleanTmp, 1000*60*10);

app.get('/api/info', async (req,res)=>{
  const {url} = req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  console.log(`[INFO] ${platform} | ${url.slice(0,80)}`);
  let finalUrl = url;
  if(platform==='tiktok' && (url.includes('vm.tiktok') || url.includes('vt.tiktok') || url.includes('tt.site'))){
    finalUrl = await resolveUrl(url);
  }

  try{
    const info = await getInfoViaYtDlp(finalUrl, platform);
    
    // حدد الجودات المتاحة
    let qualities = [];
    if(info.formats && info.formats.length>0){
      const seen = new Set();
      const mp4Formats = info.formats.filter(f=> f.ext==='mp4' && f.vcodec!=='none');
      for(const f of mp4Formats){
        const h = f.height || 0;
        if(h>=144 && !seen.has(h)){
          seen.add(h);
          qualities.push({height:h, quality:`${h}p`, label:`${h}p - ${f.ext} ${f.vcodec?.includes('avc')?'H264':'HEVC'}`, hasAudio: !!f.acodec, formatId: f.format_id});
        }
      }
      qualities.sort((a,b)=> b.height - a.height);
    }
    if(qualities.length===0){
      qualities = [{height:1080, quality:'1080p', label:'أعلى جودة - تلقائي', hasAudio:true}];
    }
    
    return res.json({
      platform,
      title: info.title || `${platform} Video`,
      safeTitle: sanitizeTitle(info.title),
      author: info.uploader || info.channel || '',
      duration: info.duration || 0,
      cover: info.thumbnail || info.thumbnails?.[0]?.url || '',
      qualities,
      originalUrl: url,
      finalUrl,
      method: 'yt-dlp',
      ytdlpVersion: ytDlpVersion
    });
  }catch(e){
    console.log(`[INFO] yt-dlp failed for ${platform}: ${e.message.slice(0,200)}`);
    if(platform==='tiktok'){
      try{
        const api = await getTikTokViaApi(finalUrl);
        return res.json({
          platform:'tiktok',
          title: api.title,
          safeTitle: sanitizeTitle(api.title),
          author: api.author,
          duration: 0,
          cover: api.cover,
          qualities: [
            {height:1080, quality:'1080p', label:'1080p HD - H264 (يشتغل على كل الأجهزة)', hasAudio:true, url: api.videoUrlH264 || api.videoUrl},
            {height:720, quality:'720p', label:'720p - متوافق', hasAudio:true, url: api.videoUrl}
          ],
          originalUrl: url,
          finalUrl,
          method: 'api-fallback',
          isHevc: api.isHevc,
          ytdlpVersion: ytDlpVersion
        });
      }catch(e2){
        return res.status(200).json({
          platform:'tiktok', title:'TikTok Video', safeTitle:'tiktok_video', author:'', duration:0, cover:'',
          qualities: [], originalUrl:url, finalUrl, method:'failed',
          error: e2.message, errorIsolated:true,
          suggestion: 'جرب رابط آخر'
        });
      }
    }
    // يوتيوب وسناب - رسالة واضحة
    if(platform==='youtube'){
      return res.status(200).json({
        platform, title:`${platform} Video`, safeTitle:`${platform}_video`, author:'', duration:0, cover:'',
        qualities: [], originalUrl:url, finalUrl,
        warning: e.message.slice(0,400),
        errorIsolated:true, ytdlpVersion: ytDlpVersion,
        error: `youtube يحتاج تحديث. yt-dlp: ${ytDlpVersion}. جرب مرة ثانية بعد دقيقة. اذا استمر، Render IP محظور من يوتيوب - الحل: استخدم كوكيز يوتيوب او بروكسي`,
        suggestion: 'يوتيوب يحظر IP مجانية. الحل المؤقت: جرب فيديو قصير او استخدم VPN على السيرفر'
      });
    }
    return res.status(200).json({
      platform, title:`${platform} Video`, safeTitle:`${platform}_video`, author:'', duration:0, cover:'',
      qualities: [], originalUrl:url, finalUrl,
      warning: e.message.slice(0,300),
      errorIsolated:true, ytdlpVersion: ytDlpVersion,
      error: e.message.slice(0,300)
    });
  }
});

app.get('/api/download', async (req,res)=>{
  const {url, quality, title} = req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'video');
  const filename = `${safeTitle}.mp4`;
  const qNum = parseQuality(quality);
  console.log(`[DOWNLOAD MP4] ${platform} q=${qNum} title=${safeTitle}`);
  
  let finalUrl = url;
  if(platform==='tiktok' && (url.includes('vm.tiktok') || url.includes('vt.tiktok') || url.includes('tt.site'))){
    finalUrl = await resolveUrl(url);
  }

  const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp4`);
  const tempConverted = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}_h264.mp4`);

  // أولا: yt-dlp - مع تفضيل H264
  if(ytdlp){
    try{
      // لليوتيوب: نفضل H264 وليس VP9/AV1 عشان يشتغل في كل مكان
      let formatStr = `bestvideo[ext=mp4][vcodec^=avc][height<=${qNum}]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=${qNum}]+bestaudio/best[ext=mp4][height<=${qNum}]/best`;
      if(platform==='youtube'){
        formatStr = `bestvideo[ext=mp4][vcodec^=avc][height<=${qNum}]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc][height<=${qNum}]/best[ext=mp4]/best`;
      }
      
      await ytdlp(finalUrl, {
        output: tempFile,
        format: formatStr,
        mergeOutputFormat: 'mp4',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125 Safari/537.36'],
        retries: 2
      });
      let finalFile = tempFile;
      if(!fs.existsSync(tempFile)) finalFile = tempFile+'.mp4';
      if(!fs.existsSync(finalFile)){
        const dirFiles = fs.readdirSync(os.tmpdir());
        const found = dirFiles.find(f=>f.includes(safeTitle.slice(0,15)) && f.endsWith('.mp4'));
        if(found) finalFile = path.join(os.tmpdir(), found);
      }
      if(fs.existsSync(finalFile)){
        // افحص هل هو HEVC وحوله لـ H264 اذا لزم
        const isHevc = await checkIsHevc(finalFile);
        if(isHevc){
          console.log('[CONVERT] HEVC detected, converting to H264...');
          await transcodeToH264(finalFile, tempConverted);
          if(fs.existsSync(tempConverted)){
            fs.unlinkSync(finalFile);
            finalFile = tempConverted;
          }
        }
        res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type','video/mp4');
        res.setHeader('Content-Length', fs.statSync(finalFile).size);
        fs.createReadStream(finalFile).pipe(res).on('finish',()=>{ fs.unlink(finalFile,()=>{}); if(fs.existsSync(tempConverted) && finalFile!==tempConverted) fs.unlink(tempConverted,()=>{}); });
        return;
      }
    }catch(e){
      console.log(`[MP4] yt-dlp failed: ${e.message.slice(0,300)} -> trying API if TikTok`);
    }
  }

  // ثانيا: TikTok API fallback مع تحويل HEVC -> H264
  if(platform==='tiktok'){
    try{
      const api = await getTikTokViaApi(finalUrl);
      const videoUrlToUse = api.videoUrlH264 || api.videoUrl; // نفضل H264
      if(videoUrlToUse){
        console.log(`[TikTok] API downloading ${videoUrlToUse.slice(0,80)} | HEVC? ${api.isHevc}`);
        
        // حمل الملف
        const writer = fs.createWriteStream(tempFile);
        const videoRes = await axios.get(videoUrlToUse, { responseType:'stream', timeout:60000, headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125 Safari/537.36', 'Referer':'https://www.tikwm.com/' } });
        await new Promise((resolve, reject)=>{
          videoRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        let finalFile = tempFile;
        // اذا كان HEVC، حوله
        if(api.isHevc || await checkIsHevc(tempFile)){
          console.log('[TikTok] Converting HEVC to H264 for compatibility...');
          try{
            await transcodeToH264(tempFile, tempConverted);
            if(fs.existsSync(tempConverted)){
              fs.unlinkSync(tempFile);
              finalFile = tempConverted;
            }
          }catch(convErr){
            console.log('[TikTok] Convert failed, sending original:', convErr.message);
          }
        }
        
        if(fs.existsSync(finalFile)){
          res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
          res.setHeader('Content-Type','video/mp4');
          res.setHeader('Content-Length', fs.statSync(finalFile).size);
          fs.createReadStream(finalFile).pipe(res).on('finish',()=>{ fs.unlink(finalFile,()=>{}); });
          return;
        }
      }
    }catch(e){
      console.error(`[TikTok API DL ERROR]`, e.message);
    }
  }

  return res.status(500).json({error:`${platform} فشل التحميل - ${platform==='youtube'?'يوتيوب يحظر سيرفرات مجانية، جرب فيديو آخر او انتظر تحديث': 'IP محظور أو يحتاج تحديث'}`, platform, suggestion:'حدث yt-dlp و استخدم بروكسي'});
});

app.get('/api/download-mp3', async (req,res)=>{
  const {url, title} = req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'audio');
  const filename = `${safeTitle}.mp3`;
  console.log(`[MP3] ${platform} | ${filename}`);
  let finalUrl = url;
  if(platform==='tiktok' && (url.includes('vm.tiktok') || url.includes('vt.tiktok') || url.includes('tt.site'))){
    finalUrl = await resolveUrl(url);
  }
  if(!ytdlp) return res.status(500).json({error:'yt-dlp غير محمل'});
  try{
    const tempBase = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}`);
    await ytdlp(finalUrl, {
      output: tempBase+'.%(ext)s',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noPlaylist: true,
      noWarnings: true
    });
    let mp3File = tempBase+'.mp3';
    if(!fs.existsSync(mp3File)){
      const files = fs.readdirSync(os.tmpdir());
      const found = files.find(f=>f.startsWith(path.basename(tempBase)) && f.endsWith('.mp3'));
      if(found) mp3File = path.join(os.tmpdir(), found);
    }
    if(!fs.existsSync(mp3File)) throw new Error('فشل انشاء MP3');
    res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(mp3File).size);
    fs.createReadStream(mp3File).pipe(res).on('finish',()=>{ fs.unlink(mp3File,()=>{}); });
  }catch(e){
    console.error(`[MP3 ERROR]`, e.message);
    res.status(500).json({error:e.message, platform});
  }
});

app.get('/health',(req,res)=>{
  res.json({ status:'ok', version:'V43-H264-fix', ytdlpVersion: ytDlpVersion, ytdlpLoaded: !!ytdlp, platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'], ts: new Date().toISOString() });
});
app.get('/api/health',(req,res)=>{
  res.json({ status:'ok', version:'V43-H264-fix', ytdlpVersion: ytDlpVersion, ytdlpLoaded: !!ytdlp, platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'], ts: new Date().toISOString(), via:'netlify-proxy', fixes:['h264-compat','youtube-android-client'] });
});

app.get('/',(req,res)=>{ res.json({name:'LAQTA V43 H264 Fix', message:'V43 - يحول HEVC الى H264 ويصلح يوتيوب', ytdlpVersion: ytDlpVersion, ytdlpLoaded: !!ytdlp}); });

app.listen(PORT,()=>{ console.log(`🚀 LAQTA V43 H264 Fix on ${PORT} | yt-dlp: ${!!ytdlp} v${ytDlpVersion}`); });
