
// LAQTA V50 Professional - Guaranteed Multi-Quality Downloader
// Architecture: yt-dlp (primary) + Cobalt (fallback) + Direct APIs (TikTok, etc.)
// Fixes: YouTube IP block, TikTok HEVC, Multi-quality, H264 compatibility, Fast response

const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { execSync, exec } = require('child_process');

let ffprobePath = null;
try {
  ffprobePath = require('@ffprobe-installer/ffprobe').path;
  console.log('✅ ffprobe loaded:', ffprobePath);
} catch(e) {
  console.log('⚠️ ffprobe not installed, using ffmpeg probe fallback');
}

ffmpeg.setFfmpegPath(ffmpegPath);
if(ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 10000;

// yt-dlp loader with fallback
let ytdlp = null;
let ytDlpVersion = 'unknown';
try {
  ytdlp = require('yt-dlp-exec');
  console.log('✅ yt-dlp-exec loaded');
  ytdlp('--version').then(v => {
    ytDlpVersion = v.trim();
    console.log('yt-dlp version:', ytDlpVersion);
  }).catch(()=>{});
  try {
    const v = execSync('yt-dlp --version', {timeout: 5000, encoding: 'utf8'}).trim();
    ytDlpVersion = v;
    console.log('yt-dlp binary:', v);
  } catch(e){}
} catch (e) {
  console.log('⚠️ yt-dlp-exec not found, will use binary directly:', e.message);
}

// Cobalt instances - multi failover (from mp4yt project)
const COBALT_INSTANCES = [
  'https://api.cobalt.tools/api/json',
  'https://co.wuk.sh/api/json',
  'https://api.co.wuk.sh/api/json',
  'https://cobalt-api.kwiatekmiki.com/api/json',
  'https://api.cobalt.ahmadk9539.workers.dev/api/json'
];

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com') || u.includes('vm.tiktok') || u.includes('vt.tiktok') || u.includes('tt.site')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  if (u.includes('snapchat.com') || u.includes('snap')) return 'snapchat';
  return 'generic';
}

function sanitizeTitle(t) {
  if (!t) return 'laqta_video';
  return t.replace(/[<>:"/\\|?*\x00-\x1F]/g,'').replace(/\s+/g,'_').substring(0,80).replace(/_+/g,'_') || 'video';
}

function parseQuality(q){
  if(!q) return 1080;
  const m = String(q).match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : 1080;
}

// Resolve short URLs (vm.tiktok etc)
async function resolveUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 10, timeout: 15000,
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

// YouTube oEmbed fallback - 100% keyless, no IP block
async function getYoutubeOembed(url){
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await axios.get(oembedUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return {
      title: res.data.title,
      author: res.data.author_name,
      thumbnail: res.data.thumbnail_url,
      provider: 'oembed'
    };
  } catch(e){
    return null;
  }
}

// Cobalt API fallback - best for YouTube IP block
async function getViaCobalt(url, quality='1080'){
  const qMap = { '144':'144', '240':'240', '360':'360', '480':'480', '720':'720', '1080':'1080', '1440':'1440', '2160':'2160' };
  const vQuality = qMap[String(quality)] || '1080';
  
  for(const instance of COBALT_INSTANCES){
    try {
      console.log(`[Cobalt] Trying ${instance} quality=${vQuality}`);
      const res = await axios.post(instance, {
        url: url,
        vQuality: vQuality,
        vCodec: 'h264',
        vCodec: 'h264',
        aFormat: 'mp3',
        isAudioOnly: false,
        isNoTTWatermark: true,
        isTTFullAudio: false
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125 Safari/537.36'
        },
        timeout: 15000
      });
      
      if(res.data && (res.data.url || res.data.status === 'stream')){
        console.log(`[Cobalt] ${instance} OK -> ${res.data.url?.slice(0,80)}`);
        return {
          url: res.data.url,
          title: res.data.filename || 'video',
          method: `cobalt-${instance.split('/')[2]}`,
          quality: vQuality,
          isH264: true
        };
      }
    } catch(e){
      console.log(`[Cobalt] ${instance} failed: ${e.response?.data?.text || e.message.slice(0,120)}`);
    }
  }
  throw new Error('Cobalt all instances failed');
}

// TikTok via tikwm.com - reliable, no watermark, H264 preferred
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
          // Prefer H264 (play) for compatibility, hdplay is often HEVC 1080p
          const h264 = d.play || d.wmplay;
          const hevc = d.hdplay || d.play_hd;
          const bestUrl = h264 || hevc;
          if(bestUrl){
            // Build qualities from what tikwm gives
            const qualities = [];
            if(h264) qualities.push({ height: 720, quality: '720p', label: '720p HD - H264 متوافق (بدون علامة)', hasAudio: true, url: h264, codec: 'h264' });
            if(hevc && hevc !== h264) qualities.push({ height: 1080, quality: '1080p', label: '1080p Full HD - HEVC (سيتم تحويله لـ H264)', hasAudio: true, url: hevc, codec: 'hevc' });
            if(d.wmplay && d.wmplay !== h264) qualities.push({ height: 720, quality: '720p_wm', label: '720p بعلامة مائية', hasAudio: true, url: d.wmplay, codec: 'h264' });
            
            return { 
              title: d.title || 'TikTok Video', 
              cover: d.cover || d.ai_dynamic_cover || d.origin_cover || '', 
              author: d.author?.nickname || d.author?.unique_id || '', 
              duration: d.duration || 0,
              videoUrl: bestUrl,
              videoUrlH264: h264,
              videoUrlHevc: hevc,
              qualities,
              isHevc: !h264 && !!hevc,
              musicUrl: d.music || ''
            };
          }
        }
        throw new Error('tikwm empty');
      }
    }
  ];
  
  for(const api of apis){
    try{
      console.log(`[TikTok API] Trying ${api.name}`);
      const r = await api.fn(url);
      if(r.videoUrl){ console.log(`[TikTok API] ${api.name} OK qualities=${r.qualities.length}`); return r; }
    }catch(e){ console.log(`[TikTok API] ${api.name} failed: ${e.message.slice(0,150)}`); }
  }
  throw new Error('TikTok APIs failed');
}

// yt-dlp with anti-bot bypass (from omi-kalix project)
async function getInfoViaYtDlp(url, platform){
  if(!ytdlp){
    // Fallback to binary directly
    try {
      const tmpJson = path.join(os.tmpdir(), `info_${Date.now()}.json`);
      const cmd = `yt-dlp --dump-single-json --no-playlist --no-warnings --extractor-args "youtube:player_client=android,web" "${url}" > ${tmpJson} 2>&1`;
      execSync(cmd, { timeout: 20000 });
      const data = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
      fs.unlinkSync(tmpJson);
      return data;
    } catch(e){
      throw new Error('yt-dlp binary failed: ' + e.message);
    }
  }
  
  const isYoutube = platform === 'youtube';
  const isSnap = platform === 'snapchat';
  const isInsta = platform === 'instagram';
  const isFb = platform === 'facebook';
  
  // Advanced options to bypass IP block and bot detection
  const opts = {
    dumpSingleJson: true,
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: false,
    retries: 3,
    fragmentRetries: 3,
    socketTimeout: 30,
    concurrentFragments: 3,
    httpChunkSize: 10485760, // 10MB
    addHeader: [
      'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language:en-US,en;q=0.9,ar;q=0.8',
      'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Mode:navigate'
    ],
    extractorArgs: isYoutube 
      ? 'youtube:player_client=android,web,ios,web_embedded;player_skip=webpage,configs;po_token=android+*'
      : isInsta ? 'instagram:api_version=2'
      : 'youtube:player_client=android',
    // Try to use cookies if exists (for YouTube age-restricted)
    // cookies: '/tmp/cookies.txt' // optional
  };
  
  if(isYoutube){
    opts.addHeader.push('Referer:https://www.youtube.com/');
    opts.addHeader.push('Origin:https://www.youtube.com');
  }
  if(isSnap){
    opts.addHeader.push('Referer:https://www.snapchat.com/');
  }
  if(isInsta){
    opts.addHeader.push('Referer:https://www.instagram.com/');
  }
  if(isFb){
    opts.addHeader.push('Referer:https://www.facebook.com/');
  }

  const info = await ytdlp(url, opts);
  return info;
}

function extractQualitiesFromYtDlp(info){
  let qualities = [];
  const seenHeights = new Set();
  
  if(info.formats && info.formats.length > 0){
    // Filter for MP4 with video, prefer H264
    const videoFormats = info.formats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.ext === 'mp4')
      .sort((a,b) => (b.height||0) - (a.height||0));
    
    for(const f of videoFormats){
      const h = f.height || 0;
      if(h < 144 || h > 2160) continue;
      if(seenHeights.has(h)) continue;
      
      const isH264 = f.vcodec && f.vcodec.includes('avc');
      const codecLabel = isH264 ? 'H264 متوافق' : (f.vcodec.includes('vp9') ? 'VP9' : f.vcodec);
      const hasAudio = !!f.acodec && f.acodec !== 'none';
      const fps = f.fps ? ` ${f.fps}fps` : '';
      const size = f.filesize ? ` ${(f.filesize/1024/1024).toFixed(1)}MB` : '';
      
      qualities.push({
        height: h,
        quality: `${h}p${f.fps && f.fps>30 ? '60' : ''}`,
        label: `${h}p${fps} - ${codecLabel}${hasAudio ? ' + صوت' : ' (بدون صوت)'}${size}`,
        hasAudio,
        formatId: f.format_id,
        ext: f.ext,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize,
        isH264
      });
      seenHeights.add(h);
    }
    
    // If no MP4, try any video format and we will convert to MP4
    if(qualities.length === 0){
      const anyVideo = info.formats.filter(f => f.vcodec && f.vcodec !== 'none').sort((a,b)=>(b.height||0)-(a.height||0));
      for(const f of anyVideo){
        const h = f.height || 0;
        if(h < 144 || seenHeights.has(h)) continue;
        qualities.push({
          height: h,
          quality: `${h}p`,
          label: `${h}p - ${f.ext.toUpperCase()} ${f.vcodec} (سيتم تحويله لـ MP4)`,
          hasAudio: !!f.acodec && f.acodec !== 'none',
          formatId: f.format_id,
          ext: f.ext,
          vcodec: f.vcodec,
          isH264: false
        });
        seenHeights.add(h);
        if(qualities.length >= 6) break;
      }
    }
  }
  
  // Fallback if still empty
  if(qualities.length === 0){
    qualities = [
      { height: 1080, quality: '1080p', label: '1080p Full HD - أعلى جودة', hasAudio: true, formatId: 'best' },
      { height: 720, quality: '720p', label: '720p HD - جودة عالية', hasAudio: true, formatId: 'best' },
      { height: 480, quality: '480p', label: '480p - جودة متوسطة', hasAudio: true, formatId: 'best' },
      { height: 360, quality: '360p', label: '360p - جودة منخفضة', hasAudio: true, formatId: 'best' }
    ];
  }
  
  // Sort by height descending, H264 first
  qualities.sort((a,b)=>{
    if(a.isH264 && !b.isH264) return -1;
    if(!a.isH264 && b.isH264) return 1;
    return b.height - a.height;
  });
  
  return qualities;
}

function transcodeToH264(inputPath, outputPath){
  return new Promise((resolve, reject)=>{
    console.log(`[FFMPEG] Converting ${path.basename(inputPath)} -> H264`);
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-pix_fmt yuv420p',
        '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2' // ensure even dimensions
      ])
      .on('start', (cmd)=> console.log('[FFMPEG] ' + cmd))
      .on('progress', (p)=> console.log(`[FFMPEG] ${p.percent?.toFixed(1)}%`))
      .on('end', ()=> { console.log('[FFMPEG] Convert done'); resolve(outputPath); })
      .on('error', (err)=> { console.error('[FFMPEG] Error:', err.message); reject(err); })
      .save(outputPath);
  });
}

function checkIsHevc(filePath){
  return new Promise((resolve)=>{
    if(!ffprobePath){
      // If no ffprobe, assume HEVC if file is from TikTok HD
      return resolve(false);
    }
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
      if(f.includes('video') || f.includes('laqta') || f.endsWith('.mp4') || f.endsWith('.mp3') || f.includes('tiktok') || f.includes('youtube')){
        const fp = path.join(os.tmpdir(), f);
        try{ const st = fs.statSync(fp); if(now - st.mtimeMs > 1000*60*20) { fs.unlinkSync(fp); console.log(`[Clean] ${f}`); } }catch(e){}
      }
    }
  }catch(e){}
}
setInterval(cleanTmp, 1000*60*10);

// ==================== API ROUTES ====================

app.get('/api/info', async (req,res)=>{
  const {url} = req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب', code: 'NO_URL'});
  const platform = detectPlatform(url);
  console.log(`\n[INFO] ${platform} | ${url.slice(0,100)}`);
  let finalUrl = url;
  if(platform==='tiktok' && (url.includes('vm.tiktok') || url.includes('vt.tiktok') || url.includes('tt.site'))){
    finalUrl = await resolveUrl(url);
    console.log(`[INFO] Resolved short URL -> ${finalUrl.slice(0,100)}`);
  }

  // Try yt-dlp first (best for quality list)
  try{
    const info = await getInfoViaYtDlp(finalUrl, platform);
    const qualities = extractQualitiesFromYtDlp(info);
    
    return res.json({
      platform,
      title: info.title || `${platform} Video`,
      safeTitle: sanitizeTitle(info.title),
      author: info.uploader || info.channel || info.uploader_id || '',
      duration: info.duration || 0,
      cover: info.thumbnail || info.thumbnails?.[0]?.url || '',
      qualities,
      originalUrl: url,
      finalUrl,
      method: 'yt-dlp',
      ytdlpVersion: ytDlpVersion,
      totalFormats: info.formats?.length || 0
    });
  }catch(e){
    console.log(`[INFO] yt-dlp failed for ${platform}: ${e.message.slice(0,250)}`);
    
    // YouTube oEmbed fallback for metadata + Cobalt for download
    if(platform==='youtube'){
      const oembed = await getYoutubeOembed(finalUrl);
      if(oembed){
        // Still try to get qualities via Cobalt or return generic qualities
        const qualities = [
          { height: 1080, quality: '1080p', label: '1080p Full HD - H264', hasAudio: true, formatId: '1080' },
          { height: 720, quality: '720p', label: '720p HD - H264', hasAudio: true, formatId: '720' },
          { height: 480, quality: '480p', label: '480p - متوسط', hasAudio: true, formatId: '480' },
          { height: 360, quality: '360p', label: '360p - منخفض', hasAudio: true, formatId: '360' }
        ];
        return res.json({
          platform: 'youtube',
          title: oembed.title,
          safeTitle: sanitizeTitle(oembed.title),
          author: oembed.author,
          duration: 0,
          cover: oembed.thumbnail,
          qualities,
          originalUrl: url,
          finalUrl,
          method: 'oembed+cobalt-fallback',
          warning: 'yt-dlp blocked, using oEmbed + Cobalt',
          ytdlpVersion
        });
      }
    }
    
    if(platform==='tiktok'){
      try{
        const api = await getTikTokViaApi(finalUrl);
        return res.json({
          platform:'tiktok',
          title: api.title,
          safeTitle: sanitizeTitle(api.title),
          author: api.author,
          duration: api.duration || 0,
          cover: api.cover,
          qualities: api.qualities,
          originalUrl: url,
          finalUrl,
          method: 'tikwm-api',
          ytdlpVersion
        });
      }catch(e2){
        return res.status(200).json({
          platform:'tiktok', title:'TikTok Video', safeTitle:'tiktok_video', author:'', duration:0, cover:'',
          qualities: [
            { height: 720, quality: '720p', label: '720p HD - محاولة أخيرة', hasAudio: true, formatId: 'best' }
          ],
          originalUrl:url, finalUrl, method:'failed',
          error: e2.message, errorIsolated:true
        });
      }
    }
    
    // Other platforms fallback
    return res.status(200).json({
      platform, title:`${platform} Video`, safeTitle:`${platform}_video`, author:'', duration:0, cover:'',
      qualities: [
        { height: 720, quality: '720p', label: '720p - تلقائي', hasAudio: true, formatId: 'best' }
      ],
      originalUrl:url, finalUrl,
      warning: e.message.slice(0,300),
      errorIsolated:true, ytdlpVersion,
      method: 'fallback'
    });
  }
});

app.get('/api/download', async (req,res)=>{
  const {url, quality, title, formatId} = req.query;
  if(!url) return res.status(400).json({error:'رابط مطلوب'});
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title||'video');
  const filename = `${safeTitle}.mp4`;
  const qNum = parseQuality(quality);
  console.log(`\n[DOWNLOAD] ${platform} q=${qNum} formatId=${formatId||'auto'} title=${safeTitle}`);
  
  let finalUrl = url;
  if(platform==='tiktok' && (url.includes('vm.tiktok') || url.includes('vt.tiktok') || url.includes('tt.site'))){
    finalUrl = await resolveUrl(url);
  }

  const tempFile = path.join(os.tmpdir(), `laqta_${Date.now()}_${safeTitle}.mp4`);
  const tempConverted = path.join(os.tmpdir(), `laqta_${Date.now()}_${safeTitle}_h264.mp4`);

  // Strategy 1: yt-dlp with quality selection (best for multi-quality)
  if(ytdlp){
    try{
      let formatStr = '';
      if(formatId && formatId !== 'best'){
        // Use specific format ID if provided (from quality list)
        formatStr = `${formatId}+bestaudio/bestvideo[height<=${qNum}]+bestaudio/best[height<=${qNum}]`;
      } else {
        // Smart format selection: prefer H264 MP4, then any MP4, then best
        if(platform==='youtube'){
          formatStr = `bestvideo[ext=mp4][vcodec^=avc][height=${qNum}]+bestaudio[ext=m4a]/bestvideo[ext=mp4][vcodec^=avc][height<=${qNum}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${qNum}]/best[height<=${qNum}]`;
        } else {
          formatStr = `bestvideo[ext=mp4][height=${qNum}]+bestaudio/bestvideo[height=${qNum}]+bestaudio/best[ext=mp4][height<=${qNum}]/best[height<=${qNum}]`;
        }
      }
      
      console.log(`[yt-dlp] format=${formatStr}`);
      
      await ytdlp(finalUrl, {
        output: tempFile,
        format: formatStr,
        mergeOutputFormat: 'mp4',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        concurrentFragments: 3,
        retries: 3,
        fragmentRetries: 3,
        addHeader: [
          'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125 Safari/537.36',
          'Referer:' + (platform==='youtube' ? 'https://www.youtube.com/' : 'https://www.tiktok.com/')
        ]
      });
      
      let finalFile = tempFile;
      if(!fs.existsSync(tempFile)){
        // yt-dlp sometimes adds extension
        const possible = [tempFile+'.mp4', tempFile+'.mkv', tempFile+'.webm'];
        for(const p of possible) if(fs.existsSync(p)) { finalFile = p; break; }
        if(!fs.existsSync(finalFile)){
          const dirFiles = fs.readdirSync(os.tmpdir());
          const found = dirFiles.find(f=>f.includes(safeTitle.slice(0,15)) && (f.endsWith('.mp4') || f.endsWith('.mkv')));
          if(found) finalFile = path.join(os.tmpdir(), found);
        }
      }
      
      if(fs.existsSync(finalFile)){
        const isHevc = await checkIsHevc(finalFile);
        if(isHevc){
          console.log('[CONVERT] HEVC detected, converting to H264 for compatibility...');
          try{
            await transcodeToH264(finalFile, tempConverted);
            if(fs.existsSync(tempConverted)){
              fs.unlinkSync(finalFile);
              finalFile = tempConverted;
            }
          }catch(convErr){
            console.log('[CONVERT] Failed, sending original:', convErr.message);
          }
        }
        
        console.log(`[DOWNLOAD] Success ${fs.statSync(finalFile).size} bytes -> ${filename}`);
        res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type','video/mp4');
        res.setHeader('Content-Length', fs.statSync(finalFile).size);
        res.setHeader('X-Platform', platform);
        res.setHeader('X-Quality', `${qNum}p`);
        fs.createReadStream(finalFile).pipe(res).on('finish',()=>{
          try{ fs.unlinkSync(finalFile); }catch(e){}
          try{ if(fs.existsSync(tempConverted) && finalFile!==tempConverted) fs.unlinkSync(tempConverted); }catch(e){}
        });
        return;
      }
    }catch(e){
      console.log(`[yt-dlp] Download failed: ${e.message.slice(0,400)}`);
    }
  }

  // Strategy 2: TikTok API (reliable for TikTok)
  if(platform==='tiktok'){
    try{
      const api = await getTikTokViaApi(finalUrl);
      // Choose quality based on requested qNum
      let videoUrlToUse = api.videoUrlH264 || api.videoUrl;
      if(qNum >= 1080 && api.videoUrlHevc) videoUrlToUse = api.videoUrlHevc; // Use HEVC for 1080p then convert
      
      if(videoUrlToUse){
        console.log(`[TikTok] Downloading via API ${videoUrlToUse.slice(0,80)} q=${qNum}`);
        const writer = fs.createWriteStream(tempFile);
        const videoRes = await axios.get(videoUrlToUse, { 
          responseType:'stream', 
          timeout: 60000, 
          headers:{ 
            'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125 Safari/537.36', 
            'Referer':'https://www.tikwm.com/',
            'Accept': 'video/mp4,video/*,*/*'
          } 
        });
        await new Promise((resolve, reject)=>{
          videoRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        let finalFile = tempFile;
        if((qNum >= 1080 && api.videoUrlHevc) || await checkIsHevc(tempFile)){
          console.log('[TikTok] Converting to H264 for Windows compatibility...');
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
          fs.createReadStream(finalFile).pipe(res).on('finish',()=>{ try{ fs.unlinkSync(finalFile); }catch(e){} });
          return;
        }
      }
    }catch(e){
      console.error(`[TikTok API DL ERROR]`, e.message);
    }
  }

  // Strategy 3: Cobalt fallback (best for YouTube when yt-dlp blocked)
  if(platform==='youtube' || platform==='tiktok' || platform==='instagram'){
    try{
      const cobalt = await getViaCobalt(finalUrl, qNum);
      if(cobalt.url){
        console.log(`[Cobalt] Streaming ${cobalt.url.slice(0,80)}`);
        const videoRes = await axios.get(cobalt.url, { responseType:'stream', timeout: 60000, headers:{ 'User-Agent':'Mozilla/5.0', 'Referer':'https://www.youtube.com/' } });
        res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type','video/mp4');
        res.setHeader('X-Method', cobalt.method);
        videoRes.data.pipe(res);
        return;
      }
    }catch(e){
      console.log(`[Cobalt] Failed: ${e.message.slice(0,200)}`);
    }
  }

  return res.status(500).json({
    error:`${platform} فشل التحميل بعد كل المحاولات`, 
    platform, 
    q: qNum,
    tried: ['yt-dlp','tiktok-api','cobalt'],
    suggestion: platform==='youtube' 
      ? 'يوتيوب يحظر IP سيرفرات مجانية. الحلول: 1) استخدم فيديو قصير غير مشهور 2) ارفع ملف cookies.txt من متصفحك 3) استخدم بروكسي سكني'
      : 'جرب رابط آخر أو انتظر دقيقة'
  });
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
    const tempBase = path.join(os.tmpdir(), `laqta_${Date.now()}_${safeTitle}`);
    await ytdlp(finalUrl, {
      output: tempBase+'.%(ext)s',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noPlaylist: true,
      noWarnings: true,
      concurrentFragments: 3
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
    fs.createReadStream(mp3File).pipe(res).on('finish',()=>{ try{ fs.unlinkSync(mp3File); }catch(e){} });
  }catch(e){
    console.error(`[MP3 ERROR]`, e.message);
    res.status(500).json({error:e.message, platform});
  }
});

app.get('/health',(req,res)=>{
  res.json({ 
    status:'ok', 
    version:'V50-PRO-MULTI-QUALITY', 
    ytdlpVersion, 
    ytdlpLoaded: !!ytdlp, 
    platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'],
    features: ['multi-quality','h264-compat','cobalt-failover','oembed-fallback','hevc-to-h264','concurrent-download'],
    ts: new Date().toISOString() 
  });
});
app.get('/api/health',(req,res)=>{
  res.json({ 
    status:'ok', 
    version:'V50-PRO-MULTI-QUALITY', 
    ytdlpVersion, 
    ytdlpLoaded: !!ytdlp, 
    platforms:['youtube','tiktok','instagram','facebook','twitter','snapchat'],
    features: ['multi-quality','h264-compat','cobalt-failover','oembed-fallback','hevc-to-h264','concurrent-download'],
    ts: new Date().toISOString(), 
    via:'netlify-proxy' 
  });
});

app.get('/',(req,res)=>{ 
  res.json({
    name:'LAQTA V50 PRO',
    message:'نسخة احترافية - جودات متعددة + H264 + Cobalt failover + YouTube bypass',
    version: 'V50-PRO-MULTI-QUALITY',
    ytdlpVersion,
    ytdlpLoaded: !!ytdlp,
    endpoints: ['/api/info?url=', '/api/download?url=&quality=&title=', '/api/download-mp3?url=&title=', '/health', '/api/health']
  }); 
});

app.listen(PORT,()=>{ 
  console.log(`\n🚀 LAQTA V50 PRO on ${PORT}`);
  console.log(`📦 yt-dlp: ${!!ytdlp} v${ytDlpVersion}`);
  console.log(`🎥 Features: multi-quality, H264 compat, Cobalt failover, HEVC->H264`);
  console.log(`🔗 Health: /health and /api/health\n`);
});
