
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
let sqlite3 = null;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (error) {
  console.warn('sqlite3 is not installed; licensing API routes are disabled:', error.message);
}
 
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join('/tmp', 'smarter-iptv-hls');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
 
// Secure master IPTV credentials and admin key.
const MASTER_IPTV_URL = process.env.IPTV_URL || 'http://portal.example.com:8080';
const MASTER_IPTV_USER = process.env.IPTV_USER || 'media26';
const MASTER_IPTV_PASS = process.env.IPTV_PASS || 'media26';
const ADMIN_API_KEY = process.env.ADMIN_KEY || 'super_secret_admin_key';
 
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

let db = {
  get(_sql, _params, cb) { cb(new Error('Licensing database is disabled')); },
  run(_sql, _params, cb) { if (typeof cb === 'function') cb.call({ changes: 0 }, new Error('Licensing database is disabled')); },
  all(_sql, _params, cb) { cb(new Error('Licensing database is disabled')); }
};

// Initialize Licensing Database when the optional sqlite3 package is available.
if (sqlite3) {
  db = new sqlite3.Database(path.join(__dirname, 'licenses.db'), (err) => {
    if (err) console.error("DB Error:", err.message);
    db.run(`CREATE TABLE IF NOT EXISTS customers (
        code TEXT PRIMARY KEY,
        status TEXT DEFAULT 'active',
        device_id TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        last_login INTEGER
    )`);
  });
}
 
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
const STATIC_ALLOW = new Set(['index.html', 'admin.html', 'hls.min.js', 'mpegts.min.js', 'Logo.png', 'favicon.ico']);
 
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
 
function profileArgs(profile) {
  if (profile === 'audio') return ['-vn', '-c:a', 'aac', '-b:a', '96k'];
  if (profile === 'copy') return ['-c', 'copy'];
  if (profile === 'remux') return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
  const videoBitrate = profile === 'vod' ? '1200k' : '750k';
  const maxrate = profile === 'vod' ? '1500k' : '900k';
  const bufsize = profile === 'vod' ? '3000k' : '1800k';
  return [
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'superfast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=w=min(854\\,iw):h=-2',
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
  const liveTuning = (profile === 'live' || profile === 'remux') ? [
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '2500000',
    '-probesize', '5000000'
  ] : ['-fflags', '+genpts+discardcorrupt'];
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-err_detect', 'ignore_err',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '4',
    '-rw_timeout', '15000000',
    ...liveTuning,
    '-i', url
  ];
}
 
function hlsArgs(profile, dir, playlist) {
  const live = profile === 'live' || profile === 'remux';
  return [
    '-f', 'hls',
    '-hls_time', live ? '2' : '6',
    '-hls_list_size', live ? '15' : '0',
    '-hls_delete_threshold', live ? '4' : '1',
    '-hls_flags', live
      ? 'delete_segments+append_list+omit_endlist+independent_segments+temp_file'
      : 'independent_segments+temp_file',
    '-hls_allow_cache', live ? '0' : '1',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    playlist
  ];
}
 
function spawnFfmpeg(session, args) {
  session.exited = false;
  session.exitCode = null;
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.child = child;
  child.on('error', error => {
    session.exited = true;
    session.exitCode = -1;
    session.log = (`FFmpeg failed to start: ${error.message}\n` + session.log).slice(-4000);
  });
  child.stderr.on('data', chunk => {
    session.log = (session.log + chunk.toString()).slice(-4000);
  });
  child.on('exit', code => {
    session.exited = true;
    session.exitCode = code;
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
 
function start(url, profile = 'mobile') {
  const id = sessionId(url, profile);
  const existing = sessions.get(id);
  if (existing && !existing.exited) {
    existing.lastAccess = Date.now();
    return existing;
  }
  if (existing && existing.exited && isLiveProfile(existing.profile) && existing.spawnArgs) {
    existing.lastAccess = Date.now();
    reviveSession(existing);
    return existing;
  }
 
  const { dir } = safePath(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
 
  const playlist = path.join(dir, 'index.m3u8');
  const args = [
    ...inputArgs(profile, url),
    ...profileArgs(profile),
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-max_muxing_queue_size', '4096',
    ...hlsArgs(profile, dir, playlist)
  ];
 
  const session = { id, url, profile, child: null, playlist, dir, created: Date.now(), lastAccess: Date.now(), exited: false, log: '', spawnArgs: args };
  spawnFfmpeg(session, args);
  sessions.set(id, session);
  return session;
}
 
async function waitForPlaylist(session, ms = 30000) {
  const file = session.playlist;
  const startAt = Date.now();
  while (Date.now() - startAt < ms) {
    if (session.exited && !fs.existsSync(file)) return false;
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const segments = (content.match(/#EXTINF:/g) || []).length;
        if (segments >= 2 || content.includes('#EXT-X-ENDLIST')) return true;
      } catch (e) {}
    }
    await new Promise(resolve => setTimeout(resolve, 250));
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
 
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, 'Method not allowed');
    const u = new URL(req.url, `http://${req.headers.host}`);
 
    // --- LICENSING & ADMIN API ROUTES ---
    if (u.pathname.startsWith('/api/')) {
      if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      
      // CLIENT ACTIVATION (Called by index.html)
      if (u.pathname === '/api/activate') {
        const body = await parseJsonBody(req);
        const code = String(body.code || '').trim().toUpperCase();
        const deviceId = String(body.deviceId || '').trim();
        if (!code || !deviceId) return json(res, 400, { error: 'Code and Device ID required' });
 
        return await new Promise((resolve) => {
          db.get(`SELECT * FROM customers WHERE code = ?`, [code], (err, row) => {
            if (err || !row) return resolve(json(res, 401, { error: 'Invalid activation code' }));
            if (row.status !== 'active') return resolve(json(res, 403, { error: 'Subscription ' + row.status }));
            if (row.expires_at > 0 && Date.now() > row.expires_at) {
              db.run(`UPDATE customers SET status = 'expired' WHERE code = ?`, [code]);
              return resolve(json(res, 403, { error: 'Subscription expired' }));
            }
            if (row.device_id && row.device_id !== deviceId) {
              return resolve(json(res, 403, { error: 'Code is bound to another device. Contact support to reset.' }));
            }
            db.run(`UPDATE customers SET device_id = ?, last_login = ? WHERE code = ?`, [deviceId, Date.now(), code]);
            resolve(json(res, 200, {
              token: crypto.randomBytes(16).toString('hex'),
              portalUrl: MASTER_IPTV_URL,
              username: MASTER_IPTV_USER,
              password: MASTER_IPTV_PASS
            }));
          });
        });
      }
 
      // ADMIN DASHBOARD PROTECTION
      const adminKey = req.headers['x-admin-key'];
      if (adminKey !== ADMIN_API_KEY) return json(res, 401, { error: 'Unauthorized' });
 
      // ADMIN: GENERATE SUBSCRIPTION CODE
      if (u.pathname === '/api/admin/generate') {
        const body = await parseJsonBody(req);
        const days = Number(body.days || 0); // 0 = lifetime
        const newCode = 'M26-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        const expiresAt = days > 0 ? Date.now() + (days * 24 * 60 * 60 * 1000) : 0;
        return await new Promise((resolve) => {
          db.run(`INSERT INTO customers (code, created_at, expires_at) VALUES (?, ?, ?)`, [newCode, Date.now(), expiresAt], (err) => {
            if (err) return resolve(json(res, 500, { error: 'Database error' }));
            resolve(json(res, 200, { success: true, code: newCode, expires_at: expiresAt }));
          });
        });
      }
 
      // ADMIN: RESET DEVICE (Allow user to switch TVs)
      if (u.pathname === '/api/admin/reset-device') {
        const body = await parseJsonBody(req);
        const targetCode = String(body.code || '').trim().toUpperCase();
        return await new Promise((resolve) => {
          db.run(`UPDATE customers SET device_id = NULL WHERE code = ?`, [targetCode], function(err) {
            if (this.changes === 0) return resolve(json(res, 404, { error: 'Code not found' }));
            resolve(json(res, 200, { success: true, message: 'Device reset successfully' }));
          });
        });
      }
 
      // ADMIN: LIST CUSTOMERS
      if (u.pathname === '/api/admin/customers') {
        return await new Promise((resolve) => {
          db.all(`SELECT * FROM customers ORDER BY created_at DESC`, (err, rows) => {
            if (err) return resolve(json(res, 500, { error: 'Database error' }));
            resolve(json(res, 200, { total: rows.length, customers: rows }));
          });
        });
      }
 
      return json(res, 404, { error: 'API endpoint not found' });
    }
    // --- END API ROUTES ---
 
    if (u.pathname === '/health') {
      return json(res, 200, { ok: true, sessions: sessions.size });
    }
 
    if (u.pathname === '/hls') {
      if (!authorized(u)) return json(res, 401, { error: 'Unauthorized' });
      const source = u.searchParams.get('url');
      const profile = u.searchParams.get('profile') || 'mobile';
      if (!source || !/^https?:\/\//i.test(source)) return json(res, 400, { error: 'Missing url' });
      const session = start(source, profile);
      const ok = await waitForPlaylist(session);
      if (!ok) return json(res, 504, { error: 'Transcoder did not produce HLS yet', log: session.log });
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
      const ready = await waitForFile(target, ext === '.m3u8' ? 5000 : 10000);
      if (!ready) return json(res, 404, { error: 'Not ready' });
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
 
