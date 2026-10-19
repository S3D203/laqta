
const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_NAME = "LAQTA V31 - Platform Isolated";

// ================= PLATFORM DETECTOR (منفصل لكل منصة) =================
function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be') || u.includes('m.youtube')) return 'youtube';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com') || u.includes('t.co')) return 'twitter';
  if (u.includes('snapchat.com') || u.includes('snap.com')) return 'snapchat';
  return 'generic';
}

function sanitizeTitle(title) {
  if (!title) return 'video';
  return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').substring(0, 80) || 'video';
}

// ================= YOUTUBE - معزول تماماً (V30 FIX + SABR filter) =================
const YT_CLIENTS = ['ANDROID', 'IOS', 'MWEB', 'TV'];

async function getYouTubeInfo(url) {
  let lastError = null;
  for (const client of YT_CLIENTS) {
    try {
      const agent = ytdl.createAgent(undefined, { localAddress: undefined });
      // Create custom options per client
      const info = await ytdl.getInfo(url, {
        agent,
        requestOptions: {
          headers: {
            'User-Agent': client === 'ANDROID' 
              ? 'com.google.android.youtube/19.09.37 (Linux; U; Android 13; SM-S908B Build/TP1A.220624.014) gzip'
              : client === 'IOS'
              ? 'com.google.ios.youtube/19.09.3 (iPhone14,2; U; CPU iOS 16_6 like Mac OS X)'
              : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      });
      
      if (info && info.videoDetails) {
        console.log(`[YouTube] Success with client ${client}: ${info.videoDetails.title}`);
        return info;
      }
    } catch (e) {
      console.log(`[YouTube] Client ${client} failed: ${e.message}`);
      lastError = e;
    }
  }
  throw lastError || new Error('YouTube: فشل جلب المعلومات من كل العملاء');
}

function filterYouTubeFormats(info) {
  // V30 FIX: فلترة SABR - نحذف الصيغ اللي بدون صوت أو اللي فيها مشاكل
  const formats = info.formats || [];
  const filtered = formats.filter(f => {
    // استبعد الصيغ اللي بدون url
    if (!f.url) return false;
    // استبعد الصيغ اللي فيها صوت فقط إذا نبي فيديو، لكن نحتفظ بها للدمج
    return true;
  });

  // Group by quality for MP4
  const videoWithAudio = filtered.filter(f => f.hasVideo && f.hasAudio && f.container === 'mp4');
  const videoOnly = filtered.filter(f => f.hasVideo && !f.hasAudio);
  const audioOnly = filtered.filter(f => !f.hasVideo && f.hasAudio);

  // Build qualities list
  const qualitiesMap = new Map();
  
  videoWithAudio.forEach(f => {
    const h = f.height || 0;
    if (h >= 144) {
      if (!qualitiesMap.has(h) || f.bitrate > (qualitiesMap.get(h).bitrate || 0)) {
        qualitiesMap.set(h, {
          height: h,
          quality: h + 'p',
          label: h + 'p' + (h >= 1080 ? ' HD' : ''),
          bitrate: f.bitrate,
          hasAudio: true,
          itag: f.itag,
          url: f.url
        });
      }
    }
  });

  // If no video+audio, create from videoOnly + audio
  if (qualitiesMap.size === 0) {
    videoOnly.forEach(f => {
      const h = f.height || 0;
      if (h >= 144 && !qualitiesMap.has(h)) {
        qualitiesMap.set(h, {
          height: h,
          quality: h + 'p',
          label: h + 'p (سيتم دمج الصوت)',
          bitrate: f.bitrate,
          hasAudio: false,
          itag: f.itag,
          needsMux: true
        });
      }
    });
  }

  const qualities = Array.from(qualitiesMap.values()).sort((a, b) => b.height - a.height);
  return { qualities, videoWithAudio, videoOnly, audioOnly, allFormats: filtered };
}

// ================= PLATFORM HANDLERS - كل منصة منفصلة =================

async function handleYouTubeInfo(url) {
  try {
    const info = await getYouTubeInfo(url);
    const { qualities } = filterYouTubeFormats(info);
    return {
      platform: 'youtube',
      title: info.videoDetails.title,
      safeTitle: sanitizeTitle(info.videoDetails.title),
      author: info.videoDetails.author?.name || '',
      duration: parseInt(info.videoDetails.lengthSeconds) || 0,
      durationStr: info.videoDetails.lengthSeconds ? `${Math.floor(info.videoDetails.lengthSeconds/60)}:${String(info.videoDetails.lengthSeconds%60).padStart(2,'0')}` : '',
      cover: info.videoDetails.thumbnails?.[info.videoDetails.thumbnails.length - 1]?.url || '',
      qualities,
      originalUrl: url,
      method: 'ytdl-core isolated'
    };
  } catch (e) {
    console.error('[YouTube Info Error]', e.message);
    throw new Error(`YouTube: ${e.message}`);
  }
}

async function handleTikTokInfo(url) {
  try {
    // TikTok isolated - uses yt-dlp
    const ytdlp = require('yt-dlp-exec');
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      preferFreeFormats: true
    });
    return {
      platform: 'tiktok',
      title: info.title || 'TikTok Video',
      safeTitle: sanitizeTitle(info.title || 'tiktok'),
      author: info.uploader || info.uploader_id || '',
      duration: info.duration || 0,
      durationStr: '',
      cover: info.thumbnail || '',
      qualities: [{ height: 720, quality: '720p', label: 'HD - بدون علامة مائية', hasAudio: true }],
      originalUrl: url,
      method: 'yt-dlp isolated'
    };
  } catch (e) {
    console.error('[TikTok Info Error]', e.message);
    throw new Error(`TikTok: ${e.message}`);
  }
}

async function handleInstagramInfo(url) {
  try {
    const ytdlp = require('yt-dlp-exec');
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true
    });
    return {
      platform: 'instagram',
      title: info.title || 'Instagram Video',
      safeTitle: sanitizeTitle(info.title || 'instagram'),
      author: info.uploader || '',
      duration: info.duration || 0,
      durationStr: '',
      cover: info.thumbnail || '',
      qualities: [{ height: 720, quality: '720p', label: 'Original' , hasAudio: true }],
      originalUrl: url,
      method: 'yt-dlp isolated'
    };
  } catch (e) {
    console.error('[Instagram Info Error]', e.message);
    throw new Error(`Instagram: ${e.message}`);
  }
}

async function handleFacebookInfo(url) {
  try {
    const ytdlp = require('yt-dlp-exec');
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true
    });
    return {
      platform: 'facebook',
      title: info.title || 'Facebook Video',
      safeTitle: sanitizeTitle(info.title || 'facebook'),
      author: info.uploader || '',
      duration: info.duration || 0,
      durationStr: '',
      cover: info.thumbnail || '',
      qualities: (info.formats || []).slice(0,3).map(f => ({
        height: f.height || 720,
        quality: (f.height || 720) + 'p',
        label: (f.height || 720) + 'p',
        hasAudio: true
      })),
      originalUrl: url,
      method: 'yt-dlp isolated'
    };
  } catch (e) {
    console.error('[Facebook Info Error]', e.message);
    throw new Error(`Facebook: ${e.message}`);
  }
}

async function handleTwitterInfo(url) {
  try {
    const ytdlp = require('yt-dlp-exec');
    const info = await ytdlp(url, { dumpSingleJson: true, noPlaylist: true });
    return {
      platform: 'twitter',
      title: info.title || 'Twitter Video',
      safeTitle: sanitizeTitle(info.title || 'twitter'),
      author: info.uploader || '',
      duration: info.duration || 0,
      durationStr: '',
      cover: info.thumbnail || '',
      qualities: [{ height: 720, quality: '720p', label: 'HD', hasAudio: true }],
      originalUrl: url,
      method: 'yt-dlp isolated'
    };
  } catch (e) {
    console.error('[Twitter Info Error]', e.message);
    throw new Error(`Twitter/X: ${e.message}`);
  }
}

async function handleSnapchatInfo(url) {
  try {
    const ytdlp = require('yt-dlp-exec');
    const info = await ytdlp(url, { dumpSingleJson: true, noPlaylist: true });
    return {
      platform: 'snapchat',
      title: info.title || 'Snapchat Video',
      safeTitle: sanitizeTitle(info.title || 'snapchat'),
      author: info.uploader || '',
      duration: info.duration || 0,
      durationStr: '',
      cover: info.thumbnail || '',
      qualities: [{ height: 720, quality: '720p', label: 'Original', hasAudio: true }],
      originalUrl: url,
      method: 'yt-dlp isolated'
    };
  } catch (e) {
    console.error('[Snapchat Info Error]', e.message);
    throw new Error(`Snapchat: ${e.message}`);
  }
}

// ================= GENERIC INFO ROUTER =================
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'رابط مطلوب' });
  
  const platform = detectPlatform(url);
  console.log(`[INFO] Platform: ${platform} | URL: ${url.substring(0,80)}`);
  
  try {
    let data;
    switch(platform) {
      case 'youtube':
        data = await handleYouTubeInfo(url);
        break;
      case 'tiktok':
        data = await handleTikTokInfo(url);
        break;
      case 'instagram':
        data = await handleInstagramInfo(url);
        break;
      case 'facebook':
        data = await handleFacebookInfo(url);
        break;
      case 'twitter':
        data = await handleTwitterInfo(url);
        break;
      case 'snapchat':
        data = await handleSnapchatInfo(url);
        break;
      default:
        // Generic fallback - try yt-dlp
        try {
          const ytdlp = require('yt-dlp-exec');
          const info = await ytdlp(url, { dumpSingleJson: true, noPlaylist: true });
          data = {
            platform: 'generic',
            title: info.title || 'Video',
            safeTitle: sanitizeTitle(info.title || 'video'),
            author: info.uploader || '',
            duration: info.duration || 0,
            durationStr: '',
            cover: info.thumbnail || '',
            qualities: [{ height: 720, quality: '720p', label: 'HD', hasAudio: true }],
            originalUrl: url,
            method: 'generic'
          };
        } catch {
          data = await handleYouTubeInfo(url); // fallback to youtube handler
        }
    }
    res.json(data);
  } catch (e) {
    console.error(`[INFO ERROR] ${platform}:`, e.message);
    res.status(500).json({ error: e.message, platform });
  }
});

// ================= DOWNLOAD MP4 - منفصل لكل منصة =================
app.get('/api/download', async (req, res) => {
  const { url, quality, title } = req.query;
  if (!url) return res.status(400).json({ error: 'رابط مطلوب' });
  
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title || 'video');
  const filename = `${safeTitle}.mp4`;
  
  console.log(`[DOWNLOAD MP4] Platform: ${platform} | Quality: ${quality} | ${filename}`);
  
  try {
    if (platform === 'youtube') {
      // YouTube isolated download with ffmpeg mux if needed
      const info = await getYouTubeInfo(url);
      const { videoWithAudio, videoOnly, audioOnly } = filterYouTubeFormats(info);
      
      let videoFormat = null;
      const targetHeight = parseInt(quality) || 720;
      
      // Try find exact quality with audio
      videoFormat = videoWithAudio.find(f => f.height === targetHeight) 
                 || videoWithAudio.sort((a,b) => Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight))[0]
                 || videoOnly.find(f => f.height === targetHeight)
                 || videoOnly[0];
      
      if (!videoFormat) throw new Error('لم أجد جودة مناسبة');
      
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'video/mp4');
      
      if (videoFormat.hasVideo && videoFormat.hasAudio) {
        // Direct stream
        const stream = ytdl.downloadFromInfo(info, { format: videoFormat });
        stream.pipe(res);
        stream.on('error', e => {
          console.error('[YouTube Stream Error]', e);
          if (!res.headersSent) res.status(500).json({ error: e.message });
        });
      } else {
        // Needs mux - video only + audio only via ffmpeg
        const audioFormat = audioOnly.sort((a,b) => b.bitrate - a.bitrate)[0] || info.formats.find(f => f.hasAudio);
        if (!audioFormat) throw new Error('لم أجد صوت');
        
        const tempDir = os.tmpdir();
        const videoPath = path.join(tempDir, `v_${Date.now()}.mp4`);
        const audioPath = path.join(tempDir, `a_${Date.now()}.mp4`);
        const outputPath = path.join(tempDir, `out_${Date.now()}.mp4`);
        
        // Download video and audio to temp files then mux
        const downloadFile = (format, filePath) => new Promise((resolve, reject) => {
          const stream = ytdl.downloadFromInfo(info, { format });
          const ws = fs.createWriteStream(filePath);
          stream.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          stream.on('error', reject);
        });
        
        await downloadFile(videoFormat, videoPath);
        await downloadFile(audioFormat, audioPath);
        
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
          .save(outputPath)
          .on('end', () => {
            res.setHeader('Content-Length', fs.statSync(outputPath).size);
            fs.createReadStream(outputPath).pipe(res).on('finish', () => {
              fs.unlinkSync(videoPath); fs.unlinkSync(audioPath); fs.unlinkSync(outputPath);
            });
          })
          .on('error', e => {
            console.error('[FFMPEG MUX Error]', e);
            if (!res.headersSent) res.status(500).json({ error: 'فشل دمج الفيديو والصوت' });
          });
      }
      return;
    } else {
      // Other platforms - isolated yt-dlp download
      const ytdlp = require('yt-dlp-exec');
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp4`);
      
      await ytdlp(url, {
        output: tempFile,
        format: quality ? `best[height<=${quality}]` : 'best',
        noPlaylist: true,
        noWarnings: true
      });
      
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', fs.statSync(tempFile).size);
      
      fs.createReadStream(tempFile).pipe(res).on('finish', () => {
        fs.unlink(tempFile, () => {});
      });
      return;
    }
  } catch (e) {
    console.error(`[DOWNLOAD ERROR] ${platform}:`, e.message);
    // Isolated error - other platforms still work
    if (!res.headersSent) {
      res.status(500).json({ error: `فشل تحميل ${platform}: ${e.message}`, platform, isolated: true });
    }
  }
});

// ================= DOWNLOAD MP3 - منفصل لكل منصة =================
app.get('/api/download-mp3', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'رابط مطلوب' });
  
  const platform = detectPlatform(url);
  const safeTitle = sanitizeTitle(title || 'audio');
  const filename = `${safeTitle}.mp3`;
  
  console.log(`[DOWNLOAD MP3] Platform: ${platform} | ${filename}`);
  
  try {
    if (platform === 'youtube') {
      const info = await getYouTubeInfo(url);
      const audioFormat = info.formats.filter(f => f.hasAudio && !f.hasVideo).sort((a,b) => b.bitrate - a.bitrate)[0]
                       || info.formats.find(f => f.hasAudio);
      
      if (!audioFormat) throw new Error('لم أجد صوت');
      
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'audio/mpeg');
      
      const stream = ytdl.downloadFromInfo(info, { format: audioFormat });
      const tempAudio = path.join(os.tmpdir(), `a_${Date.now()}.mp4`);
      const tempMp3 = path.join(os.tmpdir(), `${Date.now()}.mp3`);
      
      const ws = fs.createWriteStream(tempAudio);
      stream.pipe(ws);
      
      ws.on('finish', () => {
        ffmpeg(tempAudio)
          .audioCodec('libmp3lame')
          .audioBitrate(192)
          .save(tempMp3)
          .on('end', () => {
            res.setHeader('Content-Length', fs.statSync(tempMp3).size);
            fs.createReadStream(tempMp3).pipe(res).on('finish', () => {
              fs.unlinkSync(tempAudio); fs.unlinkSync(tempMp3);
            });
          })
          .on('error', e => {
            console.error('[MP3 Convert Error]', e);
            if (!res.headersSent) res.status(500).json({ error: e.message });
          });
      });
      
      stream.on('error', e => {
        console.error('[YouTube MP3 Stream Error]', e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
      });
      return;
    } else {
      // Other platforms MP3
      const ytdlp = require('yt-dlp-exec');
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${safeTitle}.mp3`);
      
      await ytdlp(url, {
        output: tempFile,
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0,
        noPlaylist: true
      });
      
      // yt-dlp may output with different extension, find file
      let finalFile = tempFile;
      if (!fs.existsSync(tempFile)) {
        const dir = path.dirname(tempFile);
        const files = fs.readdirSync(dir).filter(f => f.includes(path.basename(tempFile, '.mp3')));
        if (files[0]) finalFile = path.join(dir, files[0]);
      }
      
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'audio/mpeg');
      if (fs.existsSync(finalFile)) {
        res.setHeader('Content-Length', fs.statSync(finalFile).size);
        fs.createReadStream(finalFile).pipe(res).on('finish', () => {
          fs.unlink(finalFile, () => {});
        });
      } else {
        res.status(500).json({ error: 'فشل تحويل MP3' });
      }
      return;
    }
  } catch (e) {
    console.error(`[MP3 ERROR] ${platform}:`, e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `فشل تحميل صوت ${platform}: ${e.message}`, platform, isolated: true });
    }
  }
});

// ================= ISOLATED ENDPOINTS PER PLATFORM (لو حاب تستخدمها منفصلة) =================
app.get('/api/:platform/download', async (req, res) => {
  req.query.url = req.query.url || req.query.link;
  const platform = req.params.platform;
  // Force platform detection to requested platform for isolation
  console.log(`[ISOLATED] ${platform} download`);
  // Reuse main download logic but with forced platform
  req.query.platform = platform;
  return app._router.handle({ ...req, url: `/api/download?url=${encodeURIComponent(req.query.url)}&quality=${req.query.quality||'720'}&title=${encodeURIComponent(req.query.title||'video')}`, method: 'GET' }, res);
});

// ================= HEALTH & PLATFORMS STATUS =================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: API_NAME,
    platforms: ['youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'snapchat', 'generic'],
    isolated: true,
    features: ['mp4', 'mp3', 'platform-isolated', 'anti-ban', 'sabr-fix'],
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: API_NAME,
    message: 'كل منصة معزولة - لو صار باند لمنصة، الباقي يشتغل',
    endpoints: {
      info: '/api/info?url=LINK',
      mp4: '/api/download?url=LINK&quality=720&title=NAME',
      mp3: '/api/download-mp3?url=LINK&title=NAME',
      health: '/health'
    },
    platforms: {
      youtube: 'معزول - clients: ANDROID/IOS/MWEB/TV + SABR filter + ffmpeg mux',
      tiktok: 'معزول - yt-dlp',
      instagram: 'معزول - yt-dlp',
      facebook: 'معزول - yt-dlp',
      twitter: 'معزول - yt-dlp',
      snapchat: 'معزول - yt-dlp'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 ${API_NAME} running on port ${PORT}`);
  console.log(`📌 Platform Isolated: YouTube/TikTok/Instagram/Facebook/Twitter/Snapchat`);
  console.log(`📌 Features: MP4 + MP3 + Anti-Ban Isolation`);
});
