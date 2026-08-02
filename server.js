
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* Reported by /health and shown in the admin dashboard, so it is possible to tell at a glance
   whether Render is actually running the current build or still serving an older deploy. Bump
   this alongside APP_VERSION in index.html. */
const SERVER_BUILD = '11.6';
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join('/tmp', 'smarter-iptv-hls');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
/* How long the copy-mode codec probe may take before we give up and use the old TS path. */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 12000);
/* Media26 watermark burned into transcoded video. PiP (and Chromecast/AirPlay) show only the
   decoded picture, so the only way to make the logo appear there is to bake it into the stream.
   Any re-encoding profile picks it up automatically when this file is present. */
const WATERMARK = process.env.WATERMARK_PATH || path.join(__dirname, 'image_482ee8.png');
const HAS_WATERMARK = (() => { try { return fs.existsSync(WATERMARK); } catch { return false; } })();
const WM_OPACITY = process.env.WATERMARK_OPACITY || '0.5';
function reencodesVideo(profile) { return profile !== 'audio' && profile !== 'copy' && profile !== 'remux' && profile !== 'fastvod'; }
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
 
// Admin dashboard key (set ADMIN_KEY in the environment to something only you know).
const ADMIN_API_KEY = process.env.ADMIN_KEY || 'super_secret_admin_key';
// How many devices a single activation code may run on before the code is blocked.
const DEVICE_LIMIT = Number(process.env.DEVICE_LIMIT || 2);
// WhatsApp alerts (CallMeBot). Set CALLMEBOT_KEY (from the one-time opt-in) and CALLMEBOT_PHONE
// to be messaged when a code is used on a 3rd device. Optional — quietly skipped if unset.
const CALLMEBOT_KEY = process.env.CALLMEBOT_KEY || '';
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE || '14164744994';

/* ── Upstash Redis (REST) — the persistent store for activation codes. Uses plain HTTPS with a
   bearer token, so it needs no npm package (keeps the transcoder's zero-dependency Dockerfile).
   Licensing is only enabled when both env vars are present; otherwise the routes report that the
   store is not configured and playback/transcoding is completely unaffected. */
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const LICENSING_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

function redis(cmd) {
  // cmd is an array like ['SET','key','value'] — sent as a JSON body to the Upstash REST endpoint.
  return new Promise((resolve, reject) => {
    if (!LICENSING_ENABLED) return reject(new Error('Licensing store not configured'));
    let target;
    try { target = new URL(UPSTASH_URL); } catch (e) { return reject(new Error('Bad UPSTASH_REDIS_REST_URL')); }
    const payload = Buffer.from(JSON.stringify(cmd));
    const options = {
      method: 'POST',
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname || '/',
      headers: {
        authorization: 'Bearer ' + UPSTASH_TOKEN,
        'content-type': 'application/json',
        'content-length': payload.length
      }
    };
    const rq = https.request(options, up => {
      let data = '';
      up.on('data', c => { data += c.toString(); });
      up.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (parsed && parsed.error) return reject(new Error(parsed.error));
          resolve(parsed ? parsed.result : null);
        } catch (e) { reject(new Error('Bad response from store')); }
      });
    });
    rq.setTimeout(8000, () => rq.destroy(new Error('Store request timed out')));
    rq.on('error', reject);
    rq.end(payload);
  });
}

async function licGet(code) {
  const raw = await redis(['GET', 'lic:' + code]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function licSet(code, obj) {
  await redis(['SET', 'lic:' + code, JSON.stringify(obj)]);
}

/* Fire-and-forget WhatsApp alert to the admin via CallMeBot. Never throws into the request path. */
function whatsappAlert(text) {
  if (!CALLMEBOT_KEY) return;
  try {
    const url = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(CALLMEBOT_PHONE) +
      '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(CALLMEBOT_KEY);
    https.get(url, r => { r.resume(); }).on('error', () => {});
  } catch (e) {}
}

fs.mkdirSync(MEDIA_ROOT, { recursive: true });

const sessions = new Map();
const mime = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4'
};
const staticMime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};
const STATIC_ALLOW = new Set(['index.html', 'admin.html', 'hls.min.js', 'mpegts.min.js', 'mkv.js', 'portal.js', 'Logo.png', 'favicon.ico', 'manifest.json', 'image_482ee8.png', 'sw.js']);
 
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
    'access-control-allow-headers': 'accept,content-type,range,authorization,x-admin-key',
    'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type',
    'cross-origin-resource-policy': 'cross-origin',
    'timing-allow-origin': '*',
    'vary': 'Origin, Access-Control-Request-Headers',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}
 
function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json' });
}
 
function authorized(u) {
  if (!ACCESS_TOKEN) return true;
  const token = u.searchParams.get('token') || '';
  const a = Buffer.from(token);
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}
 
function sessionId(url, profile) {
  return crypto.createHash('sha1').update(`${profile}\n${url}`).digest('hex').slice(0, 24);
}
 
function safePath(id, file = '') {
  const dir = path.resolve(MEDIA_ROOT, id);
  const target = path.resolve(dir, file);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('Bad path');
  return { dir, target };
}
 
function profileArgs(profile, wm, vtag) {
  if (profile === 'audio') return ['-vn', '-c:a', 'aac', '-b:a', '96k'];
  if (profile === 'copy') return ['-c', 'copy'];
  if (profile === 'remux') return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
  /* fastvod: the "second player" for movies/series. COPY the video (no slow re-encode — near
     instant, low CPU) and only re-wrap the container + transcode the audio to AAC, so a title the
     browser can't open (MKV/AVI, AC3/DTS audio, HEVC on Apple) plays in the built-in <video>.
     Unlike 'remux' this is treated as VOD below (full, seekable HLS playlist).
     vtag ('hvc1') is set when the copied video is HEVC: ffmpeg would otherwise tag it 'hev1',
     which Apple players refuse even inside a correct fMP4 segment. */
  if (profile === 'fastvod') return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy',
    ...(vtag ? ['-tag:v', vtag] : []), '-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
  /* Quality ladder. A 4K source is 20-80 Mbit/s — no phone connection streams that comfortably, so
     these profiles decode it and re-encode smaller. The width is a CEILING (min(w,iw)), so a source
     already below it is never upscaled and never inflated in bitrate. */
  const LADDER = {
    hd1080: { w: 1920, v: '4500k', max: '5400k', buf: '9000k', preset: 'veryfast' },
    hd720:  { w: 1280, v: '2500k', max: '3000k', buf: '5000k', preset: 'veryfast' },
    vod:    { w: 854,  v: '1200k', max: '1500k', buf: '3000k', preset: 'superfast' },
    mobile: { w: 854,  v: '750k',  max: '900k',  buf: '1800k', preset: 'superfast' }
  };
  const q = LADDER[profile] || LADDER.mobile;
  const videoBitrate = q.v, maxrate = q.max, bufsize = q.buf;
  const scale = `scale=w=min(${q.w}\\,iw):h=-2`;
  /* With a watermark input present (added in start()), build a filter graph that scales the
     video, then overlays the logo bottom-left at ~14% width and low alpha, and map that output.
     Without it, keep the simple -vf scale path unchanged. */
  const videoIO = wm
    ? ['-filter_complex',
        `[0:v]${scale}[base];[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=${WM_OPACITY}[wm];[base][wm]overlay=x=14:y=H-h-14[vout]`,
        '-map', '[vout]', '-map', '0:a:0?']
    : ['-map', '0:v:0?', '-map', '0:a:0?', '-vf', scale];
  return [
    ...videoIO,
    '-c:v', 'libx264',
    '-preset', q.preset,
    /* zerolatency is a LIVE tuning — it disables lookahead and B-frames, which costs real quality
       at a given bitrate. A movie is not latency-sensitive, so the HD profiles leave it off and
       spend that headroom on the picture instead. */
    ...(profile === 'hd1080' || profile === 'hd720' ? [] : ['-tune', 'zerolatency']),
    /* 1080p needs High profile at level 4.0; the small profiles stay Main/3.1 for old devices. */
    '-profile:v', (profile === 'hd1080' || profile === 'hd720') ? 'high' : 'main',
    '-level', profile === 'hd1080' ? '4.0' : profile === 'hd720' ? '3.2' : '3.1',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-keyint_min', '50',
    '-sc_threshold', '0',
    '-b:v', videoBitrate,
    '-maxrate', maxrate,
    '-bufsize', bufsize,
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2'
  ];
}
 
function inputArgs(profile, url) {
  const isLive = (profile === 'live' || profile === 'remux');
  /* fastvod is the "quick play" repackage path — copy the video, don't re-encode. Keep the input
     probe SMALL so FFmpeg emits the first segment almost immediately instead of analysing seconds of
     the file first. +ignidx makes it ignore the Matroska/MP4 index so it never seeks to the END of
     the file to read it (a huge, slow range request over the proxy — the "loads forever" cause). */
  const liveTuning = (profile === 'fastvod') ? [
    '-fflags', '+genpts+discardcorrupt+nobuffer+ignidx',
    '-analyzeduration', '3000000',
    '-probesize', '6000000'
  ] : isLive ? [
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '2500000',
    '-probesize', '5000000'
  ] : ['-fflags', '+genpts+discardcorrupt+ignidx'];
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-err_detect', 'ignore_err',
    /* VOD (movies/series): force the HTTP input to be treated as NON-seekable so FFmpeg reads it
       start-to-end and never issues the expensive "seek to end of a 2GB file" range request to find
       the container index before playback can begin. This is what makes a big MKV start quickly
       through the proxy. Live is already a linear stream, so leave it untouched. */
    ...(isLive ? [] : ['-seekable', '0']),
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '4',
    '-rw_timeout', '30000000',
    ...liveTuning,
    '-i', url
  ];
}
 
function hlsArgs(profile, dir, playlist, segType) {
  const live = profile === 'live' || profile === 'remux';
  /* fastvod keeps a full seekable playlist (not live) but uses SHORT 2s segments so the very first
     one is ready — and playback can begin — in ~2s of copied content instead of a 6s segment. */
  const seg = (live || profile === 'fastvod') ? '2' : '6';
  /* Apple only decodes HEVC inside FRAGMENTED MP4 segments — HEVC in MPEG-TS is rejected outright
     by iPhone/iPad, which is why copying an x265 MKV into .ts segments played on desktop but died
     on iOS. When the probe finds HEVC we emit fMP4 (init.mp4 + .m4s) instead, which both Safari's
     native HLS and hls.js accept. H.264 keeps the proven TS path. */
  const fmp4 = segType === 'fmp4';
  return [
    '-f', 'hls',
    '-hls_time', seg,
    ...(fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4'] : []),
    '-hls_list_size', live ? '15' : '0',
    /* VOD (movies/series): mark the playlist as a seekable VOD so the player enables full-timeline
       seeking and NEVER restarts from 0 on a forward/back jump. Live keeps the rolling window. */
    ...(live ? [] : ['-hls_playlist_type', 'vod']),
    '-hls_delete_threshold', live ? '4' : '1',
    '-hls_flags', live
      ? 'delete_segments+append_list+omit_endlist+independent_segments+temp_file'
      : 'independent_segments+temp_file',
    '-hls_allow_cache', live ? '0' : '1',
    '-hls_segment_filename', path.join(dir, fmp4 ? 'seg_%05d.m4s' : 'seg_%05d.ts'),
    playlist
  ];
}

/* Ask ffprobe what the source's video codec is, so copy-mode can pick a container the target
   device will actually decode. Strictly best-effort and time-boxed: any failure resolves to ''
   and the caller keeps the previous MPEG-TS behaviour, so a probe problem can never block
   playback that used to work. */
function probeVideoCodec(url) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(FFPROBE, [
        '-v', 'error',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-rw_timeout', '8000000',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=nw=1:nk=1',
        url
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return finish(''); }
    let out = '';
    child.stdout.on('data', c => { out += c.toString(); });
    child.on('error', () => finish(''));
    child.on('exit', () => finish(String(out || '').trim().split(/\r?\n/)[0].trim().toLowerCase()));
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(''); }, PROBE_TIMEOUT_MS);
    if (killer.unref) killer.unref();
  });
}
 
function spawnFfmpeg(session, args) {
  session.exited = false;
  session.exitCode = null;
  console.log(`[ffmpeg] spawn profile=${session.profile} id=${session.id} src=${String(session.url || '').slice(0, 140)}`);
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.child = child;
  child.on('error', error => {
    session.exited = true;
    session.exitCode = -1;
    session.log = (`FFmpeg failed to start: ${error.message}\n` + session.log).slice(-4000);
    console.log(`[ffmpeg] FAILED TO START id=${session.id}: ${error.message}`);
  });
  child.stderr.on('data', chunk => {
    const s = chunk.toString();
    session.log = (session.log + s).slice(-4000);
    /* surface only the meaningful lines (errors / HTTP status / connection issues) to the Render
       log, so the live tail shows WHY a transcode fails without drowning in ffmpeg progress spam. */
    if (/error|denied|forbidden|403|404|401|5\d\d|timed out|refused|not found|invalid|no such|unable|failed|moov/i.test(s)) {
      console.log(`[ffmpeg ${session.id}] ${s.trim().split(/\r?\n/).slice(-1)[0].slice(0, 200)}`);
    }
  });
  child.on('exit', code => {
    session.exited = true;
    session.exitCode = code;
    console.log(`[ffmpeg] exit code=${code} id=${session.id}` + (code ? ` — last: ${String(session.log || '').trim().split(/\r?\n/).slice(-1)[0].slice(0, 200)}` : ''));
  });
}
 
function isLiveProfile(profile) {
  return profile === 'live' || profile === 'remux';
}
 
function reviveSession(session) {
  if (!session || !session.exited || !session.spawnArgs) return;
  if (!isLiveProfile(session.profile)) return;
  const now = Date.now();
  if (now - (session.lastRevive || 0) < 5000) return;
  session.lastRevive = now;
  session.revives = (session.revives || 0) + 1;
  session.log = (session.log + `\n[watchdog] restarting ffmpeg (revive #${session.revives})\n`).slice(-4000);
  spawnFfmpeg(session, session.spawnArgs);
}
 
/* Sessions being built right now. start() awaits a codec probe for copy-mode, and without this
   two near-simultaneous requests for the same title would both get past the "already running?"
   check and spawn a second ffmpeg over the first one's output directory. */
const starting = new Map();

function start(url, profile = 'mobile') {
  const id = sessionId(url, profile);
  const existing = sessions.get(id);
  if (existing && !existing.exited) {
    existing.lastAccess = Date.now();
    return Promise.resolve(existing);
  }
  if (existing && existing.exited && isLiveProfile(existing.profile) && existing.spawnArgs) {
    existing.lastAccess = Date.now();
    reviveSession(existing);
    return Promise.resolve(existing);
  }
  const inFlight = starting.get(id);
  if (inFlight) return inFlight;
  const pending = buildSession(id, url, profile).finally(() => starting.delete(id));
  starting.set(id, pending);
  return pending;
}

async function buildSession(id, url, profile) {
  /* Copy-mode can only produce a playable stream if the container we wrap into suits the codec.
     Probe once, up front: HEVC must go into fMP4 (and be tagged hvc1) or Apple devices refuse it;
     H.264 keeps the proven MPEG-TS path. An unknown/failed probe also keeps the old path. */
  let segType = '', vtag = '';
  if (profile === 'fastvod') {
    const vcodec = await probeVideoCodec(url);
    if (vcodec === 'hevc' || vcodec === 'h265') { segType = 'fmp4'; vtag = 'hvc1'; }
    console.log(`[probe] id=${id} video=${vcodec || 'unknown'} -> ${segType === 'fmp4' ? 'fMP4/hvc1 (iOS-safe)' : 'mpegts'}`);
  }

  const { dir } = safePath(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const playlist = path.join(dir, 'index.m3u8');
  /* Burn the Media26 logo in only for profiles that actually re-encode video (copy/remux/audio
     can't be overlaid). The logo is added as a second ffmpeg input, consumed by profileArgs. */
  const wm = HAS_WATERMARK && reencodesVideo(profile);
  const args = [
    ...inputArgs(profile, url),
    ...(wm ? ['-i', WATERMARK] : []),
    ...profileArgs(profile, wm, vtag),
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-max_muxing_queue_size', '4096',
    ...hlsArgs(profile, dir, playlist, segType)
  ];

  const session = { id, url, profile, child: null, playlist, dir, created: Date.now(), lastAccess: Date.now(), exited: false, log: '', spawnArgs: args };
  spawnFfmpeg(session, args);
  sessions.set(id, session);
  return session;
}
 
async function waitForPlaylist(session, ms = 30000) {
  const file = session.playlist;
  const startAt = Date.now();
  /* fastvod: return as soon as the FIRST segment exists — native HLS starts on one segment while
     the rest are still being written, shaving a couple seconds off the perceived load time. */
  const need = session.profile === 'fastvod' ? 1 : 2;
  while (Date.now() - startAt < ms) {
    if (session.exited && !fs.existsSync(file)) return false;
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const segments = (content.match(/#EXTINF:/g) || []).length;
        if (segments >= need || content.includes('#EXT-X-ENDLIST')) return true;
      } catch (e) {}
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}
 
async function waitForFile(file, ms = 8000) {
  const startAt = Date.now();
  while (Date.now() - startAt < ms) {
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > 0) return true;
      } catch (e) {}
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}
 
function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess < SESSION_TTL_MS) continue;
    if (session.child && !session.exited) session.child.kill('SIGTERM');
    fs.rmSync(session.dir, { recursive: true, force: true });
    sessions.delete(id);
  }
}
setInterval(cleanup, 60 * 1000).unref();
 
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 1e6) { req.connection.destroy(); reject(new Error('Payload too large')); }});
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error('Invalid JSON')); }});
    req.on('error', reject);
  });
}
 
const PRIVATE_HOST = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1?\]|\[f[cd])/i;

function relayFetch(target, req, res, hops) {
  let t;
  try { t = new URL(target); } catch (e) { return json(res, 400, { error: 'Bad redirect target' }); }
  if (!/^https?:$/.test(t.protocol) || PRIVATE_HOST.test(t.hostname)) {
    return json(res, 403, { error: 'Target host not allowed' });
  }
  const mod = t.protocol === 'https:' ? https : http;
  const headers = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
    accept: req.headers.accept || '*/*'
  };
  if (req.headers.range) headers.range = req.headers.range;
  const upstream = mod.request(t, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, up => {
    const loc = up.headers.location;
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && loc && hops < 5) {
      up.resume();
      let next = '';
      try { next = new URL(loc, t).href; } catch (e) {}
      if (next) return relayFetch(next, req, res, hops + 1);
      return json(res, 502, { error: 'Bad redirect from upstream' });
    }
    const outHeaders = {
      'access-control-allow-origin': CORS_ORIGIN,
      'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
      'access-control-allow-headers': 'accept,content-type,range,authorization,x-admin-key',
      'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type',
      'cross-origin-resource-policy': 'cross-origin',
      'timing-allow-origin': '*',
      'vary': 'Origin, Access-Control-Request-Headers',
      'cache-control': 'no-store',
      'content-type': up.headers['content-type'] || 'application/octet-stream'
    };
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      if (up.headers[h]) outHeaders[h] = up.headers[h];
    }
    /* v3.9: derive a correct media Content-Type from the file extension so the browser's native
       <video> recognises a proxied movie as playable (panels often send octet-stream). */
    const EXT_MIME = { mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', ts:'video/mp2t',
      mkv:'video/mp4', mk4:'video/mp4', webm:'video/webm', avi:'video/mp4', flv:'video/mp4', wmv:'video/mp4',
      vob:'video/mp4', divx:'video/mp4', m2ts:'video/mp4', mpg:'video/mp4', mpeg:'video/mp4',
      mp3:'audio/mpeg', aac:'audio/aac', m4a:'audio/mp4' };
    const em = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec((t.pathname || '') + (t.search || ''));
    const ex = em ? em[1].toLowerCase() : '';
    if (EXT_MIME[ex]) outHeaders['content-type'] = EXT_MIME[ex];
    /* v4.7: dl=1 → download as an attachment (native download manager: background + resume). */
    try {
      const rq = new URL(req.url, `http://${req.headers.host}`).searchParams;
      if (rq.get('dl')) {
        const raw = rq.get('name') || ('video.' + (ex || 'mp4'));
        const safe = raw.replace(/[\r\n"\\]/g, '').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'video';
        outHeaders['content-disposition'] = 'attachment; filename="' + safe + '"';
        if (!outHeaders['accept-ranges']) outHeaders['accept-ranges'] = 'bytes';
      }
    } catch (e) {}
    res.writeHead(up.statusCode, outHeaders);
    up.pipe(res);
  });
  upstream.setTimeout(20000, () => upstream.destroy(new Error('Upstream timed out')));
  upstream.on('error', err => {
    if (!res.headersSent) return json(res, 502, { error: 'Upstream fetch failed: ' + err.message });
    res.destroy();
  });
  req.on('close', () => upstream.destroy());
  upstream.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, 'Method not allowed');
    const u = new URL(req.url, `http://${req.headers.host}`);
 
    // --- LICENSING & ADMIN API ROUTES (Upstash-backed activation codes) ---
    if (u.pathname.startsWith('/api/')) {
      if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      if (!LICENSING_ENABLED) return json(res, 503, { error: 'Activation is not set up on this server yet.' });

      /* CUSTOMER: ask the server for a brand-new, GUARANTEED-UNIQUE 8-digit code. The server keeps
         generating until it finds one no other customer holds, registers it as pending bound to this
         device, and returns it. This removes any chance of two customers getting the same code. */
      if (u.pathname === '/api/newcode') {
        const body = await parseJsonBody(req);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (!deviceId) return json(res, 400, { error: 'Device is required.' });
        let code = '', tries = 0;
        do {
          const n = crypto.randomInt(10000000, 100000000); // 8 digits, no leading zero
          code = String(n);
          tries++;
          const existing = await licGet(code);
          if (!existing) break;
          if (tries >= 12) { code = ''; break; }
        } while (true);
        if (!code) return json(res, 500, { error: 'Could not allocate a code, try again.' });
        await licSet(code, { code, status: 'pending', devices: [deviceId], createdAt: Date.now() });
        return json(res, 200, { ok: true, code });
      }

      /* CUSTOMER: request a new activation code. The app generates an 8-digit code on the device
         and registers it here as "pending", binding this first device. The admin then activates it. */
      if (u.pathname === '/api/request') {
        const body = await parseJsonBody(req);
        const code = String(body.code || '').replace(/\D/g, '').slice(0, 8);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (code.length !== 8 || !deviceId) return json(res, 400, { error: 'A valid 8-digit code and device are required.' });
        let lic = await licGet(code);
        if (!lic) {
          lic = { code, status: 'pending', devices: [deviceId], createdAt: Date.now() };
          await licSet(code, lic);
        } else if (lic.status === 'pending' && lic.devices.indexOf(deviceId) < 0 && lic.devices.length < DEVICE_LIMIT) {
          lic.devices.push(deviceId); await licSet(code, lic);
        }
        return json(res, 200, { ok: true, status: lic.status });
      }

      /* CUSTOMER: poll for activation / log in. Returns credentials only once the admin has
         activated the code AND this device is within the allowed device count. The app uses the
         returned credentials silently — it never shows them to the user. */
      if (u.pathname === '/api/activate') {
        const body = await parseJsonBody(req);
        const code = String(body.code || '').replace(/\D/g, '').slice(0, 8);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (code.length !== 8 || !deviceId) return json(res, 400, { error: 'A valid 8-digit code and device are required.' });
        const lic = await licGet(code);
        if (!lic) return json(res, 200, { status: 'invalid' });
        if (lic.status === 'pending') return json(res, 200, { status: 'pending' });
        if (lic.status === 'blocked') return json(res, 200, { status: 'blocked' });
        if (lic.status === 'disabled') return json(res, 200, { status: 'disabled' });
        if (lic.expiresAt && Date.now() > lic.expiresAt) { lic.status = 'expired'; await licSet(code, lic); return json(res, 200, { status: 'expired' }); }
        if (lic.status === 'active') {
          const devices = lic.devices || [];
          const known = devices.indexOf(deviceId) >= 0;
          if (!known) {
            if (devices.length >= DEVICE_LIMIT) {
              // A device beyond the allowed count → block the whole code and alert the admin.
              lic.status = 'blocked'; lic.blockedAt = Date.now(); await licSet(code, lic);
              whatsappAlert('⚠️ Media26: code ' + code + ' was used on a ' + (devices.length + 1) +
                'rd/th device (limit ' + DEVICE_LIMIT + '). The code is now BLOCKED for all devices.');
              return json(res, 200, { status: 'blocked' });
            }
            devices.push(deviceId); lic.devices = devices;
          }
          lic.lastLogin = Date.now(); await licSet(code, lic);
          return json(res, 200, { status: 'active', portalUrl: lic.url, username: lic.user, password: lic.pass, devices: (lic.devices || []).length, deviceLimit: DEVICE_LIMIT });
        }
        return json(res, 200, { status: lic.status || 'pending' });
      }

      // Everything below requires the admin key.
      const adminKey = req.headers['x-admin-key'] || u.searchParams.get('key') || '';
      if (adminKey !== ADMIN_API_KEY) return json(res, 401, { error: 'Unauthorized' });

      // ADMIN: activate a code — bind the IPTV credentials you created to the customer's 8-digit code.
      if (u.pathname === '/api/admin/activate') {
        const body = await parseJsonBody(req);
        const code = String(body.code || '').replace(/\D/g, '').slice(0, 8);
        if (code.length !== 8) return json(res, 400, { error: 'Enter the customer’s 8-digit code.' });
        const url = String(body.url || '').trim();
        const user = String(body.user || '').trim();
        const pass = String(body.pass != null ? body.pass : '').trim();
        if (!url || !user) return json(res, 400, { error: 'Portal URL and username are required.' });
        const days = Number(body.days || 0); // 0 = never expires
        const existing = await licGet(code);
        const lic = existing || { code, devices: [], createdAt: Date.now() };
        lic.status = 'active'; lic.url = url; lic.user = user; lic.pass = pass;
        lic.expiresAt = days > 0 ? Date.now() + days * 86400000 : 0;
        lic.activatedAt = Date.now();
        await licSet(code, lic);
        /* `created` tells the dashboard that NO customer had ever registered this code, so what just
           happened was "a brand-new code was invented", not "the customer waiting on their screen was
           let in". A single mistyped digit produces exactly that: a phantom active code with 0 devices
           while the customer's real code sits pending forever. The UI warns loudly on this flag. */
        return json(res, 200, { ok: true, code, status: 'active', created: !existing, devices: lic.devices.length, deviceLimit: DEVICE_LIMIT });
      }

      /* ADMIN: mint a BRAND-NEW code that is already active. This is the "sell a subscription"
         path: the customer has not opened the app yet, so there is no code to ask them for. The
         server allocates a guaranteed-unique 8-digit code, binds the IPTV login to it and marks it
         active immediately, so the customer types that one code and the channels load. */
      if (u.pathname === '/api/admin/create') {
        const body = await parseJsonBody(req);
        const url = String(body.url || '').trim();
        const user = String(body.user || '').trim();
        const pass = String(body.pass != null ? body.pass : '').trim();
        if (!url || !user) return json(res, 400, { error: 'Portal URL and username are required.' });
        const days = Number(body.days || 0); // 0 = never expires
        let code = '';
        for (let tries = 0; tries < 20 && !code; tries++) {
          const candidate = String(crypto.randomInt(10000000, 100000000)); // 8 digits, no leading zero
          const clash = await licGet(candidate);
          if (!clash) code = candidate;
        }
        if (!code) return json(res, 500, { error: 'Could not allocate a free code. Try again.' });
        const lic = {
          code, status: 'active', url, user, pass,
          devices: [], createdAt: Date.now(), activatedAt: Date.now(),
          expiresAt: days > 0 ? Date.now() + days * 86400000 : 0
        };
        await licSet(code, lic);
        return json(res, 200, { ok: true, code, status: 'active', devices: 0, deviceLimit: DEVICE_LIMIT });
      }

      // ADMIN: block / unblock / reset devices / delete a code.
      if (u.pathname === '/api/admin/update') {
        const body = await parseJsonBody(req);
        const code = String(body.code || '').replace(/\D/g, '').slice(0, 8);
        const op = String(body.op || '').trim();
        if (code.length !== 8) return json(res, 400, { error: 'Enter an 8-digit code.' });
        if (op === 'delete') { await redis(['DEL', 'lic:' + code]); return json(res, 200, { ok: true, deleted: true }); }
        const lic = await licGet(code);
        if (!lic) return json(res, 404, { error: 'Code not found.' });
        if (op === 'block') lic.status = 'blocked';
        else if (op === 'unblock') lic.status = lic.url ? 'active' : 'pending';
        else if (op === 'reset-devices') lic.devices = [];
        else return json(res, 400, { error: 'Unknown operation.' });
        await licSet(code, lic);
        return json(res, 200, { ok: true, status: lic.status, devices: (lic.devices || []).length });
      }

      // ADMIN: list all codes (for the dashboard).
      if (u.pathname === '/api/admin/list') {
        let cursor = '0'; const keys = [];
        do {
          const r = await redis(['SCAN', cursor, 'MATCH', 'lic:*', 'COUNT', '500']);
          cursor = (r && r[0]) || '0';
          const batch = (r && r[1]) || [];
          for (const k of batch) keys.push(k);
        } while (cursor !== '0' && keys.length < 2000);
        const items = [];
        for (const k of keys) {
          try { const v = await redis(['GET', k]); if (v) { const o = JSON.parse(v); o.devices = (o.devices || []).length; delete o.pass; items.push(o); } } catch (e) {}
        }
        items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json(res, 200, { total: items.length, deviceLimit: DEVICE_LIMIT, codes: items });
      }

      return json(res, 404, { error: 'API endpoint not found' });
    }
    // --- END API ROUTES ---
 
    if (u.pathname === '/health') {
      /* Report capabilities so the app can tell a CURRENT server (fast copy-mode MKV) from an old
         one. 'fastvod' is the quick copy-video profile; its presence here means MKV plays fast. */
      return json(res, 200, { ok: true, sessions: sessions.size, version: 2, build: SERVER_BUILD, profiles: ['fastvod', 'hd1080', 'hd720', 'vod', 'remux', 'copy', 'audio'], activation: LICENSING_ENABLED });
    }

    // Same-origin CORS relay: /proxy?url=<encoded target>. index.html tries this
    // path first when talking to an Xtream portal, so login works even when every
    // third-party CORS relay is down. Only public http(s) targets are allowed.
    if (u.pathname === '/proxy') {
      const raw = u.searchParams.get('url') || '';
      let target = null;
      try { target = new URL(raw); } catch (e) {}
      if (!target || !/^https?:$/.test(target.protocol)) return json(res, 400, { error: 'Missing or invalid ?url= parameter' });
      if (PRIVATE_HOST.test(target.hostname)) return json(res, 403, { error: 'Target host not allowed' });
      return relayFetch(target.href, req, res, 0);
    }
 
    if (u.pathname === '/hls') {
      if (!authorized(u)) return json(res, 401, { error: 'Unauthorized' });
      const source = u.searchParams.get('url');
      const profile = u.searchParams.get('profile') || 'mobile';
      console.log(`[hls] request profile=${profile} url=${String(source || '').slice(0, 160)}`);
      if (!source || !/^https?:\/\//i.test(source)) return json(res, 400, { error: 'Missing url' });
      const session = await start(source, profile);
      /* Give a cold/slow free server more room to emit the first segment before declaring failure
         (copy-mode VOD is quick once ffmpeg can read the source; a re-encode needs longer). If the
         source can't be read, waitForPlaylist returns early with the ffmpeg error in session.log. */
      /* Hold this request only briefly. Blocking here for the WHOLE startup — up to a minute for a
         re-encode, on top of a free instance's cold start — routinely outlived the CDN's ~100s edge
         timeout, which then answered the browser with its own HTML 504. That is what "server
         returned 504" with no ffmpeg log was: the transcoder was often still working correctly and
         nobody was listening. Redirect as soon as there is something, or promptly regardless, and
         let the client poll the manifest on short requests that can never hit that ceiling. */
      const FIRST_WAIT_MS = Number(process.env.FIRST_WAIT_MS || 12000);
      const ok = await waitForPlaylist(session, FIRST_WAIT_MS);
      if (!ok && session.exited) {
        console.log(`[hls] 504 profile=${profile} id=${session.id} — ffmpeg exited before any playlist`);
        return json(res, 504, { error: 'Transcoder could not produce video', log: (session.log || '').slice(-600) });
      }
      console.log(`[hls] 302 ${ok ? 'READY' : 'STARTING'} profile=${profile} id=${session.id}`);
      const location = `${requestBaseUrl(req)}/sessions/${session.id}/index.m3u8`;
      res.writeHead(302, {
        location,
        'access-control-allow-origin': CORS_ORIGIN,
        'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
        'access-control-allow-headers': 'accept,content-type,range,authorization,x-admin-key',
        'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type',
        'cross-origin-resource-policy': 'cross-origin',
        'timing-allow-origin': '*',
        'vary': 'Origin, Access-Control-Request-Headers',
        'cache-control': 'no-store'
      });
      return res.end();
    }
 
    if (u.pathname.startsWith('/sessions/')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const id = parts[1];
      const file = parts.slice(2).join('/');
      const session = sessions.get(id);
      if (!session) return json(res, 404, { error: 'Session expired' });
      session.lastAccess = Date.now();
      if (session.exited && isLiveProfile(session.profile)) reviveSession(session);
      const { target } = safePath(id, file);
      const ext = path.extname(target);
      const ready = await waitForFile(target, ext === '.m3u8' ? 8000 : 10000);
      if (!ready) {
        /* A manifest that is not there YET is not a missing manifest. 404 reads as fatal and made
           the app abandon a transcode that was still starting; 503 + Retry-After says "keep asking",
           which is what lets the client wait out a cold start over short requests. ffmpeg having
           exited is the one genuinely fatal case, and reports its log. */
        if (ext === '.m3u8' && !session.exited) {
          return json(res, 503, { status: 'starting', retryAfter: 2 });
        }
        if (ext === '.m3u8') return json(res, 502, { error: 'Transcoder stopped', log: (session.log || '').slice(-600) });
        return json(res, 404, { error: 'Not ready' });
      }
      const stat = fs.statSync(target);
      const baseHeaders = {
        'access-control-allow-origin': CORS_ORIGIN,
        'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
        'access-control-allow-headers': 'accept,content-type,range,authorization,x-admin-key',
        'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type',
        'cross-origin-resource-policy': 'cross-origin',
        'timing-allow-origin': '*',
        'vary': 'Origin, Access-Control-Request-Headers',
        'cache-control': ext === '.m3u8' ? 'no-store' : 'public, max-age=120',
        'content-type': mime[ext] || 'application/octet-stream',
        'accept-ranges': 'bytes'
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...baseHeaders, 'content-length': stat.size });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          let start = match[1] ? Number(match[1]) : 0;
          let end = match[2] ? Number(match[2]) : stat.size - 1;
          if (!match[1] && match[2]) start = Math.max(0, stat.size - end);
          end = Math.min(end, stat.size - 1);
          if (start <= end && start < stat.size) {
            res.writeHead(206, {
              ...baseHeaders,
              'content-range': `bytes ${start}-${end}/${stat.size}`,
              'content-length': end - start + 1
            });
            return fs.createReadStream(target, { start, end }).pipe(res);
          }
        }
        res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(200, {
        ...baseHeaders,
        'content-length': stat.size
      });
      return fs.createReadStream(target).pipe(res);
    }
 
    if ((req.method === 'GET' || req.method === 'HEAD') && !u.pathname.includes('..')) {
      const name = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
      if (STATIC_ALLOW.has(name)) {
        const target = path.join(__dirname, name);
        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
          const ext = path.extname(target).toLowerCase();
          const body = req.method === 'HEAD' ? '' : fs.readFileSync(target);
          return send(res, 200, body, {
            'content-type': staticMime[ext] || 'application/octet-stream',
            'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
          });
        }
      }
    }
 
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 500, { error: error.message || 'Server error' });
  }
});
 
server.listen(PORT, () => {
  console.log(`Smarter IPTV transcoder listening on ${PORT}`);
});
 
