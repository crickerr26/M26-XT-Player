
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* Reported by /health and shown in the admin dashboard, so it is possible to tell at a glance
   whether Render is actually running the current build or still serving an older deploy. Bump
   this alongside APP_VERSION in index.html. */
const SERVER_BUILD = '14.4';
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
/* v19.63: the session idle window moved down to IDLE_TTL_MS, next to cleanup() where it is used —
   two constants for one thing is how a 30-minute leak survived being read. The SESSION_TTL_MS env
   var still works and still overrides it. */
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

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

/* ── v14.0: SELF-SERVE RENEWAL VIA STRIPE. ────────────────────────────────────────────────────
   The existing activation-code store above already carries everything a subscription needs —
   `expiresAt`, `status`, the portal credentials a customer's code unlocks — the owner just had to
   push every renewal by hand (re-type `days` into admin.html and tell the customer). This adds a
   customer-facing "pay to extend MY code" path. It can only ever act on a code that already
   exists and already has a portal bound to it (see /api/checkout below) — it can never create a
   new code or a new portal login. Manual admin activation/extension in admin.html is untouched
   and keeps working exactly as before, for codes the owner wants to hand out for free, on a
   schedule Stripe doesn't know about, or via any other arrangement.
   v23.9 update: this payment used to extend the SAME `expiresAt` the admin's `days` field also
   wrote — one shared expiry, two ways to push it out. The owner has since split that into two
   independent subscriptions that both have to be current: `iptvExpiresAt` (the admin's own
   product, unchanged) and `appExpiresAt` (written ONLY here, by an actual Stripe payment — see
   iptvExpiryOf()/appExpiryOf() below for the full reasoning). A Stripe payment now only ever
   touches appExpiresAt; it can no longer resurrect a line the admin expired, blocked or disabled
   on the IPTV side, which sharing one field used to allow by accident.
   Talks to Stripe's plain REST API over https with Basic Auth (the secret key as the username,
   per Stripe's docs) rather than the `stripe` npm package, for the same zero-dependency reason
   Upstash above is plain HTTPS — one less thing to `npm install` into this Dockerfile.
   Both env vars are required: the secret key to call the API, the webhook secret to verify that a
   "payment succeeded" callback actually came from Stripe and not from anyone who can guess this
   server's URL and POST it a fake success. Missing either disables the routes below (503) without
   touching licensing, playback or transcoding. */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SUBSCRIPTION_ENABLED = !!(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && LICENSING_ENABLED);
/* v14.0/app-v23.4 owner decision: $2.00 CAD buys 30 days, extended onto whatever the code's current
   expiry already is (never reset to "now + 30" — paying a few days early never costs the customer
   those days). One-time payment, not a Stripe recurring subscription: the customer taps Renew and
   pays again next time they want another month, exactly as described when this was asked for
   ("he will pay with the payment link and the app will work for that much of time") — no card is
   ever charged automatically, no cancellation flow is needed, and there is no subscription object
   for a failed renewal to leave dangling. */
const SUBSCRIPTION_PRICE_CAD_CENTS = Number(process.env.SUBSCRIPTION_PRICE_CAD_CENTS || 200);
const SUBSCRIPTION_DAYS = Number(process.env.SUBSCRIPTION_DAYS || 30);
const SUBSCRIPTION_CURRENCY = (process.env.SUBSCRIPTION_CURRENCY || 'cad').toLowerCase();

/* One HTTPS call to Stripe's API. Stripe's request bodies are form-encoded (not JSON) for every
   endpoint used here, including nested objects — `line_items[0][price_data][unit_amount]` is the
   real, documented way to express that shape as form fields, so flattenForm() below does that
   conversion rather than JSON.stringify-ing the body. */
function flattenForm(obj, prefix, out) {
  out = out || [];
  if (obj == null) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenForm(v, prefix + '[' + i + ']', out));
  } else if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) flattenForm(obj[k], prefix ? prefix + '[' + k + ']' : k, out);
  } else {
    out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(obj)));
  }
  return out;
}
function stripeApi(method, path, fields) {
  return new Promise((resolve, reject) => {
    if (!STRIPE_SECRET_KEY) return reject(new Error('Stripe is not configured'));
    const payload = Buffer.from(flattenForm(fields || {}, '', []).join('&'));
    const options = {
      method,
      hostname: 'api.stripe.com',
      path,
      headers: {
        authorization: 'Basic ' + Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': payload.length
      }
    };
    const rq = https.request(options, up => {
      let data = '';
      up.on('data', c => { data += c.toString(); });
      up.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data || '{}'); } catch (e) { return reject(new Error('Bad response from Stripe')); }
        if (up.statusCode >= 400) return reject(new Error((parsed && parsed.error && parsed.error.message) || ('Stripe error ' + up.statusCode)));
        resolve(parsed);
      });
    });
    rq.setTimeout(15000, () => rq.destroy(new Error('Stripe request timed out')));
    rq.on('error', reject);
    rq.end(payload);
  });
}
/* Read the RAW body — parseJsonBody (below) parses straight to an object, but Stripe's webhook
   signature is computed over the exact bytes it sent, so JSON.parse-and-restringify would very
   possibly not reproduce them byte-for-byte (key order, whitespace) and every signature would
   fail. Capped at the same 1MB parseJsonBody already enforces; a real Stripe event is a few KB. */
function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 1e6) { req.connection.destroy(); reject(new Error('Payload too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
/* Stripe's documented webhook verification: the signed payload is "{timestamp}.{raw body}", HMAC-
   SHA256'd with the endpoint's signing secret; the header carries one or more (t=…, v1=…) pairs so
   a secret can be rotated without a gap. Constant-time compare against each v1, and a 5-minute
   tolerance on the timestamp, both straight from Stripe's own reference implementation — this is
   the one thing standing between "a payment happened" and "anyone who finds this URL can POST a
   fake success and extend any code they know for free", so it is not optional and not loosened. */
function verifyStripeSignature(rawBody, header, secret) {
  const parts = String(header || '').split(',').reduce((m, p) => { const i = p.indexOf('='); if (i > 0) m[p.slice(0, i)] = p.slice(i + 1); return m; }, {});
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute replay window
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

/* ── v23.9 (owner decision): TWO INDEPENDENT SUBSCRIPTIONS ON ONE CODE. ──────────────────────
   Until now a code carried exactly one `expiresAt`, extended either by the admin (a duration
   they picked) or by Stripe (a $2 self-serve payment) — the two features shared one field. The
   owner has since drawn a hard line between them, on purpose:
     - the IPTV PLAYLIST subscription: the admin's own product — they set how long a customer's
       portal access lasts (admin.html's dropdown, days -> iptvExpiresAt below), same as always.
     - the APP subscription: Media26's own product on top of that — $2, paid directly by the
       customer via Stripe (see /api/checkout / /api/stripe-webhook), tracked entirely separately.
   BOTH must be unexpired for a code to sign in (see /api/activate below) — a customer can have a
   perfectly valid IPTV line and still be asked to pay the app fee, or vice versa, and the two
   have to be reported as two different reasons because the fix for each is different (contact
   your seller vs. pay $2 in-app).
   iptvExpiryOf() migrates every record written before this: they only ever had `expiresAt`, and
   that value WAS the (admin-set) IPTV expiry in every one of them — there is nothing to migrate
   for appExpiresAt, since paying for app access is a brand-new thing no old record could have
   done. A record with no appExpiresAt at all (every pre-v23.9 code, and every new code until its
   customer's first Stripe payment) is NOT gated on the app subscription at all — 0 there means
   "not required yet", exactly like 0 already means "never expires" on the IPTV side. Nobody who
   was working yesterday is locked out by this deploy; the app-subscription gate only starts
   counting down for a code the moment ITS OWN customer actually pays once. */
function iptvExpiryOf(lic) { return (lic && lic.iptvExpiresAt != null) ? lic.iptvExpiresAt : ((lic && lic.expiresAt) || 0); }
function appExpiryOf(lic) { return (lic && lic.appExpiresAt) || 0; }

/* Activation identifiers come in two shapes that share ONE licence store (same 'lic:' key
   namespace, same admin dashboard, same device-limit/expiry/WhatsApp-alert logic):
     - an 8-digit numeric code (the original "get an activation code" flow), or
     - a MAC-address-formatted device ID (AA:BB:CC:DD:EE:FF), for admins who prefer to identify
       a device the way IPTV/STB portals conventionally do.
   normalizeCode() accepts either shape from any endpoint and returns the canonical storage key
   (unpadded 8 digits, or uppercase colon-separated MAC), or null if it matches neither. */
function normalizeCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const hex = s.replace(/[:\-\s]/g, '');
  if (/^[0-9a-fA-F]{12}$/.test(hex) && (/[:\-]/.test(s) || /[a-fA-F]/.test(hex))) {
    return hex.toUpperCase().match(/.{2}/g).join(':');
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 8) return digits;
  return null;
}
/* ── v13.0: TWO KINDS OF LINE ────────────────────────────────────────────────────────────────
   A 'xtream'-kind line is portal URL + username + password (the app turns this into an M3U/
   get.php URL — the name is kept internally for compatibility with codes already stored, the app
   never calls Xtream's player_api.php). An 'm3u'-kind (MAC / Stalker) line has no username at all
   — the customer's device MAC is the credential, bound on the provider's own panel — so the
   portal address is the only thing to store.
   Until now activate/create both hard-required a username, which made a MAC-only line impossible
   to provision: the admin had nothing to type in the field and the request was rejected. Records
   written before this have no `kind`, so it is inferred from whether a username was stored, and an
   old dashboard that sends no `kind` keeps behaving exactly as it did. */
/* v19.63: a THIRD kind, 'm3uurl' — "the URL field already IS a complete M3U playlist link", so the
   app fetches it directly and never attempts a MAG handshake for it. It is deliberately a NEW name
   rather than a reuse of 'm3u': 'm3u' has meant MAC-only/Stalker in this store since v13.0 and
   there are live records written that way, so redefining it would silently turn every MAC-bound
   customer into a playlist customer overnight. Every value that normalized to something before
   still normalizes to exactly the same thing. */
function normalizeKind(raw, user) {
  /* Punctuation is stripped so 'm3u_url' / 'm3u-url' / 'M3U URL' all land on one value — the two
     dashboards and the app each spell it slightly differently. */
  const k = String(raw || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (k === 'm3uurl' || k === 'm3ulink' || k === 'playlist') return 'm3uurl';
  if (k === 'm3u' || k === 'mac' || k === 'stalker' || k === 'mag') return 'm3u';
  if (k === 'xtream' || k === 'xtreme') return 'xtream';
  return String(user || '').trim() ? 'xtream' : 'm3u';
}
/* One validator for both write paths, so activate and create can never disagree about what a
   usable line looks like. Returns an error string, or '' when the line is fine. */
function validateLine(url, user, kind) {
  const u = String(url || '').trim();
  if (!u) return 'Portal URL is required.';
  /* Only the username/password kind carries a username. Neither a MAC-bound line nor a ready-made
     playlist link has one, and demanding it made both impossible to provision. */
  if (kind !== 'm3u' && kind !== 'm3uurl' && !String(user || '').trim()) {
    return 'Username is required for a username/password line. For a MAC-only line choose that type — it signs in by MAC and has no username.';
  }
  /* A playlist line is only useful if the stored value is fetchable as-is. A bare host typed into
     this kind by mistake fails much later, on the customer's device, as an unexplained empty
     playlist — so it is rejected here, where the seller can still see and fix it. */
  if (kind === 'm3uurl' && !/^https?:\/\//i.test(u)) {
    return 'An M3U playlist line needs the full playlist link, starting with http:// or https://.';
  }
  return '';
}
/* Generate a guaranteed-unique, LOCALLY-ADMINISTERED MAC address (IEEE 802: first-octet bit 1 set,
   bit 0 clear) so it can never collide with a real vendor's hardware OUI — this is a virtual device
   identifier, not a claim to be genuine STB hardware. */
function randomLocalMac() {
  const b = crypto.randomBytes(6);
  b[0] = (b[0] & 0xfe) | 0x02;
  return Array.from(b).map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
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
function redactDebugText(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s'"<>]+/gi, '[url]')
    .replace(/\b[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}\b/g, '[mac]')
    .replace(/\bBearer\s+[\w.\-]+/gi, 'Bearer [token]')
    .replace(/(token=)[^&\s]+/gi, '$1[token]')
    .replace(/(password=)[^&\s]+/gi, '$1[password]')
    .replace(/(username=)[^&\s]+/gi, '$1[username]');
}
function sessionDebug(session) {
  let playlistExists = false, playlistBytes = 0, segments = 0, files = 0;
  try {
    const st = fs.statSync(session.playlist);
    playlistExists = st.isFile();
    playlistBytes = st.size;
    if (playlistExists) {
      const text = fs.readFileSync(session.playlist, 'utf8');
      segments = (text.match(/#EXTINF:/g) || []).length;
    }
  } catch (e) {}
  try { files = fs.readdirSync(session.dir).length; } catch (e) {}
  return {
    id: session.id,
    profile: session.profile,
    ageMs: Date.now() - session.created,
    idleMs: Date.now() - session.lastAccess,
    exited: !!session.exited,
    exitCode: session.exitCode,
    playlistExists,
    playlistBytes,
    segments,
    files,
    logTail: redactDebugText(session.log).slice(-1200)
  };
}
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
    'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type,retry-after',
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

/* v12.9: the base for URLs written INTO a rewritten HLS playlist. This must point straight back at
   THIS transcoder on its own IP — never at x-forwarded-host. When the app reaches /proxy through
   its Cloudflare /transcoder passthrough, x-forwarded-host is the Cloudflare host, so requestBaseUrl
   would rewrite every segment to `<cloudflare>/proxy` — which drops the /transcoder prefix, hits
   Cloudflare's own relay, and the stream nodes BLOCK Cloudflare (error 1003), so hls.js receives an
   HTML error page instead of video and dies with bufferAppendError. Using the REAL Host header
   (the onrender.com service host that this process actually answers on) makes hls.js fetch the
   variants and segments directly from this server, on the IP the stream node accepts. */
function relayBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = String(req.headers.host || '').split(',')[0].trim();
  if (!host) return requestBaseUrl(req);
  /* onrender.com and every non-local PaaS host serves https only; an http URL here would be
     blocked as mixed content on the https app. Only a bare localhost test host stays http. */
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host);
  return (isLocal ? 'http' : 'https') + '://' + host;
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
 
/* ── v19.63 (server 13.5): AN ABANDONED TRANSCODE IS A STOLEN CONNECTION SLOT ────────────────
   Every session here is a live ffmpeg process pulling from the CUSTOMER'S OWN IPTV line, and an
   IPTV line permits a small number of simultaneous connections — often one or two. Nothing ended
   a session when the viewer stopped watching or changed channel: the only exit was the idle
   sweep, and SESSION_TTL_MS defaulted to THIRTY MINUTES. So a couple of taps could leave several
   ffmpeg processes each holding a slot on the line for half an hour, and the provider's streamer
   then correctly refused the next request:
     403 — "Streamer protection system doesn't allow you to watch this content."
   Measured on the live service: 7 sessions held, flat across a 3-minute poll, while every fresh
   create_link came back with a valid URL that could not be opened. Nothing upstream was blocking
   the account — the account's own allowance was being consumed by our leftovers, and every retry
   made it worse by starting one more.
   Three changes, all pulling the same way:
     1. IDLE_TTL — an HLS player re-reads the playlist every few seconds, so silence for 45s means
        the viewer has gone. 30 minutes was never a viewer, it was a leak.
     2. MAX_SESSIONS — a hard ceiling. Over it, the least-recently-used session is ended first, so
        the newest viewer is served instead of everyone being starved by stale ones.
     3. endSession() — one path for stopping a session, so a slot is always released the same way.
   SESSION_TTL_MS still overrides the default for anyone who deliberately wants longer. */
const IDLE_TTL_MS = Number(process.env.SESSION_TTL_MS || 45 * 1000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 4);
function endSession(id, why) {
  const session = sessions.get(id);
  if (!session) return false;
  try { if (session.child && !session.exited) session.child.kill('SIGTERM'); } catch (e) {}
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch (e) {}
  sessions.delete(id);
  if (why) console.log('[session] ended ' + id + ' (' + why + ')');
  return true;
}
function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess >= IDLE_TTL_MS) endSession(id, 'idle');
  }
  /* Still over the ceiling after the idle sweep: end the stalest first. */
  if (sessions.size > MAX_SESSIONS) {
    const byAge = Array.from(sessions.entries()).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [id] of byAge.slice(0, sessions.size - MAX_SESSIONS)) endSession(id, 'over capacity');
  }
}
/* Ten seconds, not sixty: with a 45s idle window a minute-long sweep interval means a slot can sit
   held for nearly two minutes after the viewer left — long enough to refuse their next channel. */
setInterval(cleanup, 10 * 1000).unref();
/* Release every slot on shutdown. Render restarts the service on each deploy, and without this the
   ffmpeg children could outlive the parent and keep the line saturated with no way to reach them. */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const [id] of sessions) endSession(id, 'shutdown');
    process.exit(0);
  });
}
 
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 1e6) { req.connection.destroy(); reject(new Error('Payload too large')); }});
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error('Invalid JSON')); }});
    req.on('error', reject);
  });
}
 
const PRIVATE_HOST = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1?\]|\[f[cd])/i;

/* v13.1: /proxy has always refused a private-network target; /hls did not, and /hls is the route
   that hands a URL to ffmpeg. On the hosted service ACCESS_TOKEN is deliberately unset (see
   render.yaml and the README, so the app works the moment its URL is pasted in), and authorized()
   returns true whenever it is unset — so /hls?url=http://169.254.169.254/… was an unauthenticated
   request that made the server fetch its own cloud metadata endpoint. It is not a blind hole
   either: when ffmpeg cannot demux what came back, the 504 returns the tail of its log, which can
   carry fragments of the response.
   Self-hosting is the one legitimate reason to point the transcoder at a private address — a VPS
   or docker install streaming from a LAN source, which the README documents — so this refuses by
   default and takes ALLOW_PRIVATE_TARGETS=1 to opt back in, rather than removing the ability. */
const ALLOW_PRIVATE_TARGETS = /^(1|true|yes)$/i.test(String(process.env.ALLOW_PRIVATE_TARGETS || ''));
function targetAllowed(raw) {
  let t; try { t = new URL(String(raw || '')); } catch (e) { return false; }
  if (!/^https?:$/.test(t.protocol)) return false;
  if (ALLOW_PRIVATE_TARGETS) return true;
  return !PRIVATE_HOST.test(t.hostname);
}

function relayFetch(target, req, res, hops) {
  let t;
  try { t = new URL(target); } catch (e) { return json(res, 400, { error: 'Bad redirect target' }); }
  if (!/^https?:$/.test(t.protocol) || PRIVATE_HOST.test(t.hostname)) {
    return json(res, 403, { error: 'Target host not allowed' });
  }
  const mod = t.protocol === 'https:' ? https : http;
  /* Match the Cloudflare relay (_worker.js): panels are built for set-top boxes and many of them
     answer a browser User-Agent with a 403 or an HTML error page on their stream endpoints, which
     the media engines can only report as a generic network failure. Ask as a player instead;
     `&ua=browser` opts back in. */
  let uaMode = '';
  try { uaMode = new URL(req.url, 'http://x').searchParams.get('ua') || ''; } catch (e) {}
  /* v13.2 (server build): `ua=browser` now means a WHOLE browser, not just a User-Agent string.
     This relay is the app's second egress, and it exists for one job: reach a panel whose edge has
     already refused the Cloudflare worker. It was doing that job with a bare two-header GET from a
     datacenter address — the easiest possible request for bot protection to score as automated, and
     the same shape that had just been refused. So the "second, independent route" was failing the
     same test as the first, every time, and the app reported a portal blocking both routes when
     what it had really done was ask the same question twice in the same voice.
     These are the headers a real browser always carries on a top-level GET. Kept in step with
     browserHeaders() in _worker.js. */
  const headers = uaMode === 'browser'
    ? {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'upgrade-insecure-requests': '1',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1'
      }
    : {
        'user-agent': 'VLC/3.0.20 LibVLC/3.0.20',
        accept: req.headers.accept || '*/*'
      };
  /* v14.5: MAG/Stalker support, mirroring _worker.js. This exists so the app has a SECOND route
     to a portal. The Cloudflare relay reaches a panel from Cloudflare's own network, and a portal
     sitting behind an edge/WAF routinely refuses that on the very first request — a 429 or 403
     that no amount of waiting clears, because it is a block on where the request came from, not a
     count of how many were made. This server runs on ordinary hosting with entirely different
     IPs, so the same handshake through here is simply a different visitor. */
  let stbMac = '';
  let stbToken = '';
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('stb') === '1') {
      const m = q.get('mac') || '';
      if (/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(m)) stbMac = m.toUpperCase();
      stbToken = (q.get('token') || '').trim();
      if (stbMac) {
        /* v13.3 (server build): kept in step with _worker.js. On the `ua=browser` pass this relay
           must look like a browser all the way down — the MAG User-Agent AND the MAG model header
           are both bot signatures, and sending the model header regardless (as this did) meant the
           fallback was scored exactly like the attempt it exists to rescue. The mac cookie stays:
           portal.php reads it to identify the line, and a cookie is not a bot signal. */
        if (uaMode !== 'browser') {
          headers['user-agent'] = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
          headers['x-user-agent'] = 'Model: MAG250; Link: WiFi';
        } else {
          delete headers['x-user-agent'];
        }
        headers.cookie = 'mac=' + stbMac + '; stb_lang=en; timezone=UTC';
        /* Ministra checks the Referer on some builds — a box always arrives from its own /c/ UI. */
        headers.referer = t.protocol + '//' + t.host + '/c/';
        if (stbToken && /^[\w.\-]{1,256}$/.test(stbToken)) headers.authorization = 'Bearer ' + stbToken;
      }
    }
  } catch (e) {}
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
    if ((up.statusCode === 401 || up.statusCode === 403) && stbMac && uaMode !== 'browser' && hops < 5) {
      up.resume();
      let retryUrl = req.url;
      try {
        const rq = new URL(req.url, 'http://x');
        rq.searchParams.set('ua', 'browser');
        retryUrl = rq.pathname + rq.search;
      } catch (e) {}
      return relayFetch(t.href, { method: req.method, headers: req.headers, url: retryUrl }, res, hops + 1);
    }
    const outHeaders = {
      'access-control-allow-origin': CORS_ORIGIN,
      'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
      'access-control-allow-headers': 'accept,content-type,range,authorization,x-admin-key',
      'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type,retry-after',
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
    /* v16.6: HLS PLAYLIST REWRITING (mirrors _worker.js). This relay's whole reason to exist for a
       Stalker/MAG stream is that the stream node BLOCKS Cloudflare's network (Cloudflare error 1003
       / 403) while serving this server's ordinary IP perfectly — so the app routes MAG playback
       here instead of through the Cloudflare /proxy. But hls.js then fetches not just the master
       playlist but every variant, segment and key; if those sub-URIs still point at the origin,
       they go straight back to the Cloudflare-blocked (and, on an https page, mixed-content) host
       and playback dies a few seconds in. Buffer an m3u8 and repoint every URI back through /proxy
       on THIS origin so the whole stream stays on the accepted IP. */
    const _ctype = String(up.headers['content-type'] || '').toLowerCase();
    const _isM3u8 = /mpegurl|m3u8/.test(_ctype) || /\.m3u8(?:$|\?)/i.test((t.pathname || '') + (t.search || ''));
    if (req.method === 'GET' && up.statusCode === 200 && _isM3u8) {
      const chunks = [];
      up.on('data', c => chunks.push(c));
      up.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        if (/#EXTM3U/.test(text)) {
          const self = relayBaseUrl(req);
          const magRelay = stbMac
            ? '&stb=1&mac=' + encodeURIComponent(stbMac) + (stbToken ? '&token=' + encodeURIComponent(stbToken) : '')
            : '';
          const uaRelay = uaMode === 'browser' ? '&ua=browser' : '';
          const prox = u => {
            try { return self + '/proxy?url=' + encodeURIComponent(new URL(u, t.href).href) + magRelay + uaRelay; }
            catch (e) { return u; }
          };
          text = text.split(/\r?\n/).map(line => {
            const s = line.trim();
            if (!s) return line;
            if (s.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + prox(u) + '"');
            return prox(s);
          }).join('\n');
          delete outHeaders['content-length'];
          outHeaders['content-type'] = 'application/vnd.apple.mpegurl';
        }
        if (!res.headersSent) res.writeHead(up.statusCode, outHeaders);
        res.end(text);
      });
      up.on('error', () => { try { if (!res.headersSent) res.writeHead(502, outHeaders); res.end(); } catch (e) {} });
      return;
    }
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

      /* CUSTOMER: same as /api/newcode but returns a GUARANTEED-UNIQUE MAC-address-formatted device
         ID instead of an 8-digit code. Used by "Connect via MAC Address" — the admin binds the IPTV
         login to this MAC on their dashboard, exactly like they would an activation code. Shares the
         same 'lic:' store, so it appears in /api/admin/list alongside numeric codes. */
      if (u.pathname === '/api/newmac') {
        const body = await parseJsonBody(req);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (!deviceId) return json(res, 400, { error: 'Device is required.' });
        let mac = '', tries = 0;
        do {
          mac = randomLocalMac();
          tries++;
          const existing = await licGet(mac);
          if (!existing) break;
          if (tries >= 12) { mac = ''; break; }
        } while (true);
        if (!mac) return json(res, 500, { error: 'Could not allocate a device ID, try again.' });
        await licSet(mac, { code: mac, status: 'pending', devices: [deviceId], createdAt: Date.now() });
        return json(res, 200, { ok: true, code: mac });
      }

      /* CUSTOMER: request a new activation code. The app generates an 8-digit code on the device
         and registers it here as "pending", binding this first device. The admin then activates it. */
      if (u.pathname === '/api/request') {
        const body = await parseJsonBody(req);
        const code = normalizeCode(body.code);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (!code || !deviceId) return json(res, 400, { error: 'A valid 8-digit code (or MAC address) and device are required.' });
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
        const code = normalizeCode(body.code);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (!code || !deviceId) return json(res, 400, { error: 'A valid 8-digit code (or MAC address) and device are required.' });
        const lic = await licGet(code);
        if (!lic) return json(res, 200, { status: 'invalid' });
        if (lic.status === 'pending') return json(res, 200, { status: 'pending' });
        if (lic.status === 'blocked') return json(res, 200, { status: 'blocked' });
        if (lic.status === 'disabled') return json(res, 200, { status: 'disabled' });
        /* v23.9: the IPTV side is checked FIRST — it is the foundational thing (no portal, nothing
           to watch regardless of the app fee), so its own status/message wins when it and the app
           subscription are both expired at once. 'expired' keeps meaning exactly what it always
           has (the admin-set/IPTV side); 'app_expired' is new and specifically means "the IPTV
           line is fine, but this customer's own $2 app payment lapsed" — different cause, different
           remedy (contact the seller vs. pay in-app), so the app is told which one to say. */
        const iptvExp = iptvExpiryOf(lic);
        if (iptvExp && Date.now() > iptvExp) { lic.status = 'expired'; await licSet(code, lic); return json(res, 200, { status: 'expired', subscriptionEnabled: SUBSCRIPTION_ENABLED, iptvExpiresAt: iptvExp }); }
        const appExp = appExpiryOf(lic);
        if (lic.status === 'active' && appExp && Date.now() > appExp) {
          return json(res, 200, { status: 'app_expired', subscriptionEnabled: SUBSCRIPTION_ENABLED, iptvExpiresAt: iptvExp, appExpiresAt: appExp });
        }
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
          /* v13.0: `kind` tells the app which sign-in it is being handed. On an M3U/MAG line
             username and password are empty by design, and the app completes the login with the
             device's own MAC instead — without this field it could not tell that apart from a
             half-filled Xtream record.
             v14.0/v23.9: iptvExpiresAt (admin-set, 0 = never expires) and appExpiresAt (Stripe-set,
             0 = no app payment made yet — not required) are reported separately now, plus whether
             Stripe renewal is even configured on this server, so the app can show two independent
             "N days left" counts and two independent Renew paths without extra round trips. */
          return json(res, 200, { status: 'active', kind: normalizeKind(lic.kind, lic.user), portalUrl: lic.url, username: lic.user, password: lic.pass, devices: (lic.devices || []).length, deviceLimit: DEVICE_LIMIT, iptvExpiresAt: iptvExp, appExpiresAt: appExp, subscriptionEnabled: SUBSCRIPTION_ENABLED });
        }
        return json(res, 200, { status: lic.status || 'pending' });
      }

      /* CUSTOMER: pay to extend THEIR OWN, already-provisioned code. Creates a Stripe Checkout
         Session for one $SUBSCRIPTION_PRICE_CAD_CENTS/SUBSCRIPTION_DAYS purchase and hands back
         its URL for the app to open; the actual extension happens in /api/stripe-webhook below,
         once Stripe confirms the payment actually went through — never here, since this route
         alone is just "someone asked for a checkout link" and proves nothing was paid.
         Deliberately narrow: refuses a code that does not exist yet, or one with no portal bound
         to it (status 'pending') — there is nothing yet to renew, and mistaking a payment for a new
         signup is exactly the mix-up this route exists to avoid (see the v14.0 note above). Also
         refuses a device that has never been registered on this code — the same "known device"
         check /api/activate already applies — so a stranger who happens to see 8 digits on someone
         else's screen cannot spend money extending a stranger's line. */
      if (u.pathname === '/api/checkout') {
        if (!SUBSCRIPTION_ENABLED) return json(res, 503, { error: 'Self-serve renewal is not set up on this server yet.' });
        const body = await parseJsonBody(req);
        const code = normalizeCode(body.code);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        const origin = /^https:\/\/[^\s"'<>]+$/i.test(String(body.origin || '')) ? String(body.origin).replace(/\/+$/, '') : '';
        if (!code || !deviceId) return json(res, 400, { error: 'A valid 8-digit code (or MAC address) and device are required.' });
        if (!origin) return json(res, 400, { error: 'Missing or invalid origin.' });
        const lic = await licGet(code);
        if (!lic || !lic.url) return json(res, 404, { error: 'This code has nothing to renew yet — it needs to be activated by your seller first.' });
        if ((lic.devices || []).indexOf(deviceId) < 0) return json(res, 403, { error: 'This device is not registered on this code.' });
        /* Paying does not fix either of these — 'blocked' means too many devices (see
           /api/devices/reset), 'disabled' was a deliberate admin call — so say that up front
           instead of taking a payment that would land on an unusable code. */
        if (lic.status === 'blocked') return json(res, 409, { error: 'This code is blocked (used on too many devices). Clear devices in the sign-in screen first, then renew.' });
        if (lic.status === 'disabled') return json(res, 409, { error: 'This code has been disabled by your seller. Contact them before renewing.' });
        let session;
        try {
          session = await stripeApi('POST', '/v1/checkout/sessions', {
            mode: 'payment',
            client_reference_id: code,
            metadata: { code, deviceId },
            success_url: origin + '/?sub=success',
            cancel_url: origin + '/?sub=cancelled',
            line_items: [{
              quantity: 1,
              price_data: {
                currency: SUBSCRIPTION_CURRENCY,
                unit_amount: SUBSCRIPTION_PRICE_CAD_CENTS,
                product_data: { name: 'Media26 — ' + SUBSCRIPTION_DAYS + ' days access (code ' + code + ')' }
              }
            }]
          });
        } catch (e) { return json(res, 502, { error: 'Could not start checkout: ' + ((e && e.message) || 'Stripe did not answer.') }); }
        return json(res, 200, { ok: true, url: session.url });
      }

      /* STRIPE: webhook callback. Configure this exact path (…/api/stripe-webhook) as the endpoint
         URL in the Stripe Dashboard, listening for at least `checkout.session.completed`. Signature
         verification (see verifyStripeSignature above) is the only thing standing between "Stripe
         confirmed this was paid" and "a POST from anywhere claiming it was" — never skip it. */
      if (u.pathname === '/api/stripe-webhook') {
        if (!SUBSCRIPTION_ENABLED) return json(res, 503, { error: 'Self-serve renewal is not set up on this server yet.' });
        const raw = await parseRawBody(req);
        const sig = req.headers['stripe-signature'] || '';
        if (!verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET)) return json(res, 400, { error: 'Invalid signature' });
        let event; try { event = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'Invalid payload' }); }
        if (event.type === 'checkout.session.completed') {
          const session = (event.data && event.data.object) || {};
          if (session.payment_status === 'paid') {
            const code = normalizeCode(session.client_reference_id || (session.metadata && session.metadata.code));
            if (code) {
              /* Idempotency: Stripe retries a webhook delivery until it gets a 200, so the SAME
                 completed session can arrive more than once. `renewedSessions` remembers which
                 Checkout Session ids have already been applied to this code, so a retry (or a
                 customer double-clicking Renew and completing both) can never double-extend it. */
              const lic = await licGet(code);
              if (lic) {
                const applied = Array.isArray(lic.renewedSessions) ? lic.renewedSessions : [];
                if (applied.indexOf(session.id) < 0) {
                  /* v23.9: writes appExpiresAt, never the IPTV side (lic.status / lic.iptvExpiresAt /
                     legacy lic.expiresAt) — a Stripe payment is the APP subscription, full stop. It
                     used to flip lic.status back to 'active' here, from the days when one expiry
                     covered both; that would now be silently reactivating a line the ADMIN expired
                     or blocked using nothing but the customer's own app payment, which is exactly
                     the cross-contamination the owner asked to eliminate. If the IPTV side is
                     separately expired/blocked/disabled, this payment still only buys app access —
                     /api/activate reports that state independently, on its own next poll. */
                  const base = (lic.appExpiresAt && lic.appExpiresAt > Date.now()) ? lic.appExpiresAt : Date.now();
                  lic.appExpiresAt = base + SUBSCRIPTION_DAYS * 86400000;
                  applied.push(session.id);
                  lic.renewedSessions = applied.slice(-20); // bounded — this is a dedupe list, not an invoice history
                  await licSet(code, lic);
                  whatsappAlert('💰 Media26: code ' + code + ' — APP subscription renewed via Stripe, now valid until ' + new Date(lic.appExpiresAt).toLocaleDateString() + '.');
                }
              }
            }
          }
        }
        // Stripe only needs a 200 to stop retrying; it does not read the body.
        return json(res, 200, { received: true });
      }

      /* CUSTOMER: "Clear registered users" on the sign-in screen. Empties the device list for the
         caller's OWN code and re-registers the calling device in the same write, so the customer
         ends up as the only device on their line rather than locked out of it entirely.
         This is deliberately its own route instead of the app calling /api/admin/update: that route
         can rewrite, block or bulk-delete ANY code in the store, and a button on the customer's
         sign-in screen must never need that much reach. Keeping them separate also means putting
         the admin routes behind a key later does not break this button. */
      if (u.pathname === '/api/devices/reset') {
        const body = await parseJsonBody(req);
        const code = normalizeCode(body.code);
        const deviceId = String(body.deviceId || '').trim().slice(0, 80);
        if (!code || !deviceId) return json(res, 400, { error: 'A valid 8-digit code (or MAC address) and device are required.' });
        const lic = await licGet(code);
        if (!lic) return json(res, 404, { error: 'This code is not registered yet.' });
        const had = (lic.devices || []).length;
        lic.devices = [deviceId];
        /* Same reasoning as op='reset-devices': a DEVICE_LIMIT block exists *because* the list was
           full, so emptying it is the remedy. A seller's manual block has no blockedAt and stays. */
        if (lic.status === 'blocked' && lic.blockedAt) {
          lic.status = lic.url ? 'active' : 'pending';
          delete lic.blockedAt;
        }
        await licSet(code, lic);
        return json(res, 200, { ok: true, cleared: had, devices: 1, deviceLimit: DEVICE_LIMIT, status: lic.status });
      }

      // ADMIN: activate a code — bind the IPTV credentials you created to the customer's 8-digit code
      // or MAC-address device ID (accepts either — see normalizeCode).
      if (u.pathname === '/api/admin/activate') {
        const body = await parseJsonBody(req);
        const code = normalizeCode(body.code);
        if (!code) return json(res, 400, { error: 'Enter the customer’s 8-digit code or MAC address.' });
        const url = String(body.url || '').trim();
        const user = String(body.user || '').trim();
        const pass = String(body.pass != null ? body.pass : '').trim();
        const kind = normalizeKind(body.kind, user);
        const bad = validateLine(url, user, kind);
        if (bad) return json(res, 400, { error: bad });
        const days = Number(body.days || 0); // 0 = never expires — this is the IPTV/playlist side only
        const existing = await licGet(code);
        const lic = existing || { code, devices: [], createdAt: Date.now() };
        lic.status = 'active'; lic.url = url; lic.user = user; lic.pass = pass; lic.kind = kind;
        lic.iptvExpiresAt = days > 0 ? Date.now() + days * 86400000 : 0;
        delete lic.expiresAt; // fully migrated off the legacy shared field — see iptvExpiryOf()
        lic.activatedAt = Date.now();
        await licSet(code, lic);
        /* `created` tells the dashboard that NO customer had ever registered this code, so what just
           happened was "a brand-new code was invented", not "the customer waiting on their screen was
           let in". A single mistyped digit produces exactly that: a phantom active code with 0 devices
           while the customer's real code sits pending forever. The UI warns loudly on this flag. */
        return json(res, 200, { ok: true, code, status: 'active', created: !existing, devices: lic.devices.length, deviceLimit: DEVICE_LIMIT, iptvExpiresAt: lic.iptvExpiresAt || 0 });
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
        const kind = normalizeKind(body.kind, user);
        const bad = validateLine(url, user, kind);
        if (bad) return json(res, 400, { error: bad });
        const days = Number(body.days || 0); // 0 = never expires — the IPTV/playlist side only
        let code = '';
        for (let tries = 0; tries < 20 && !code; tries++) {
          const candidate = String(crypto.randomInt(10000000, 100000000)); // 8 digits, no leading zero
          const clash = await licGet(candidate);
          if (!clash) code = candidate;
        }
        if (!code) return json(res, 500, { error: 'Could not allocate a free code. Try again.' });
        const lic = {
          code, status: 'active', url, user, pass, kind,
          devices: [], createdAt: Date.now(), activatedAt: Date.now(),
          iptvExpiresAt: days > 0 ? Date.now() + days * 86400000 : 0
          /* appExpiresAt deliberately absent — a brand-new code has no app-subscription payment
             yet, and 0/absent means "not required", never "already expired". See the v23.9 note
             above licGet/licSet. */
        };
        await licSet(code, lic);
        return json(res, 200, { ok: true, code, status: 'active', devices: 0, deviceLimit: DEVICE_LIMIT, iptvExpiresAt: lic.iptvExpiresAt || 0 });
      }

      // ADMIN: block / unblock / reset devices / edit / delete a code (one or many).
      if (u.pathname === '/api/admin/update') {
        const body = await parseJsonBody(req);
        const op = String(body.op || '').trim();

        /* v13.0: BULK DELETE. `codes` is an array; `code` stays supported so an older dashboard
           keeps working. Deleting many one-request-at-a-time was the slow part of clearing out a
           batch of expired trials, and each round trip is a separate chance to half-finish. */
        if (op === 'delete') {
          const raw = Array.isArray(body.codes) ? body.codes : [body.code];
          const codes = [];
          for (const c of raw) { const n = normalizeCode(c); if (n && codes.indexOf(n) < 0) codes.push(n); }
          if (!codes.length) return json(res, 400, { error: 'Enter an 8-digit code or MAC address.' });
          if (codes.length > 500) return json(res, 400, { error: 'Too many codes in one request (max 500).' });
          for (const c of codes) await redis(['DEL', 'lic:' + c]);
          return json(res, 200, { ok: true, deleted: codes.length, codes });
        }

        const code = normalizeCode(body.code);
        if (!code) return json(res, 400, { error: 'Enter an 8-digit code or MAC address.' });
        const lic = await licGet(code);
        if (!lic) return json(res, 404, { error: 'Code not found.' });

        /* v13.0: EDIT. Until now a customer whose portal address or password changed had to be
           re-activated through the activate form, which silently overwrites the whole record —
           losing the device list, so every one of their devices had to sign in again and count
           against the limit a second time. Editing changes only the fields supplied and leaves
           devices, createdAt and status where they are. */
        if (op === 'edit') {
          const url = String(body.url != null ? body.url : lic.url || '').trim();
          const user = String(body.user != null ? body.user : lic.user || '').trim();
          const kind = normalizeKind(body.kind != null ? body.kind : lic.kind, user);
          const bad = validateLine(url, user, kind);
          if (bad) return json(res, 400, { error: bad });
          lic.url = url; lic.user = user; lic.kind = kind;
          /* An empty password field means "leave it alone" — /api/admin/list never returns the
             stored password, so the dashboard cannot pre-fill it and a blank box must not wipe it. */
          if (body.pass != null && String(body.pass).trim() !== '') lic.pass = String(body.pass).trim();
          /* Neither of the passwordless kinds should keep a password left over from a line that
             used to be username/password — it would be handed back to the app on every activate. */
          if (kind === 'm3u' || kind === 'm3uurl') lic.pass = '';
          if (body.days != null && String(body.days) !== '') {
            const days = Number(body.days || 0);
            lic.iptvExpiresAt = days > 0 ? Date.now() + days * 86400000 : 0;   // IPTV/playlist side only
            delete lic.expiresAt;   // fully migrated off the legacy shared field — see iptvExpiryOf()
          }
          /* A code that was only ever pending becomes usable the moment it has a line bound. */
          if (lic.status === 'pending' && lic.url) { lic.status = 'active'; lic.activatedAt = Date.now(); }
          await licSet(code, lic);
          return json(res, 200, { ok: true, status: lic.status, kind: lic.kind, devices: (lic.devices || []).length });
        }

        if (op === 'block') { lic.status = 'blocked'; delete lic.blockedAt; }
        else if (op === 'unblock') { lic.status = lic.url ? 'active' : 'pending'; delete lic.blockedAt; }
        else if (op === 'reset-devices') {
          lic.devices = [];
          /* v19.63: clearing the devices now LIFTS a device-limit block. Emptying the list while
             leaving status='blocked' made this operation look like it had done nothing: the
             customer's app polls /api/activate seconds later, is told 'blocked' again, and the
             seller repeats the reset. Being full of devices is the entire reason the limit block
             exists, so removing them is its remedy.
             A code the seller blocked BY HAND (op='block') stays blocked — only 'unblock' undoes
             that. blockedAt is what tells the two apart: the DEVICE_LIMIT path in /api/activate
             stamps it, the manual path above deliberately clears it. */
          if (lic.status === 'blocked' && lic.blockedAt) {
            lic.status = lic.url ? 'active' : 'pending';
            delete lic.blockedAt;
          }
        }
        else return json(res, 400, { error: 'Unknown operation.' });
        await licSet(code, lic);
        return json(res, 200, { ok: true, status: lic.status, devices: (lic.devices || []).length });
      }

      // ADMIN: list all codes (for the dashboard).
      // v24.13 (owner request): the dashboard's new "Admin page" table shows each customer's
      // username/password alongside their code, so — unlike before — the password is no longer
      // stripped here. admin.html has no login of its own; it has always been "for whoever
      // operates this app, not for viewers" (same trust level as the activate form, which already
      // hands a password back in its own response), just kept to one code at a time until now.
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
          try { const v = await redis(['GET', k]); if (v) { const o = JSON.parse(v); o.devices = (o.devices || []).length; items.push(o); } } catch (e) {}
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
      /* `kinds` lets the two dashboards tell a server that understands the 'm3uurl' line type from
         one still on an older deploy — otherwise picking "M3U Playlist" would store a line that
         silently normalizes back to MAC-only and never signs anybody in. */
      /* idleTtlMs/maxSessions are reported so it is possible to tell, from outside, whether the
         running service actually has the v19.63 session reaping — a stuck `sessions` count with a
         30-minute window is the signature of the connection-slot leak. */
      return json(res, 200, { ok: true, sessions: sessions.size, idleTtlMs: IDLE_TTL_MS, maxSessions: MAX_SESSIONS, version: 2, build: SERVER_BUILD, profiles: ['fastvod', 'hd1080', 'hd720', 'vod', 'remux', 'copy', 'audio'], kinds: ['xtream', 'm3uurl', 'm3u'], activation: LICENSING_ENABLED, subscriptions: SUBSCRIPTION_ENABLED });
    }

    if (u.pathname === '/debug/sessions') {
      return json(res, 200, { ok: true, build: SERVER_BUILD, sessions: Array.from(sessions.values()).map(sessionDebug) });
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
      /* v13.1: same refusal /proxy already makes — a private-network target never reaches ffmpeg. */
      if (!targetAllowed(source)) return json(res, 403, { error: 'Target host not allowed' });
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
        'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type,retry-after',
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
        'access-control-expose-headers': 'content-length,content-range,accept-ranges,content-type,retry-after',
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
 
