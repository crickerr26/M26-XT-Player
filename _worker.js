import { LicenseStore, isLicensingPath } from './licensing.js';
/* The Durable Object class must be exported from the Worker entry point for the runtime to
   bind it. See licensing.js for what it holds and why it is here rather than upstream. */
export { LicenseStore };

/* The ONE hosted service behind /transcoder: it both transcodes and holds the Upstash
   activation store. It must be the same service the admin dashboard writes codes to, and the
   same one that auto-deploys from this repo — when those drifted apart, customer codes came
   back unknown and MKV kept hitting a server that never received the HEVC fix.
   Override without a code change by setting a TRANSCODER_ORIGIN variable on the Worker/Pages
   project, so moving to a new service is a dashboard edit, not a redeploy of this file. */
/* ── v21.2: THE ADDRESS OF A SERVICE THAT NO LONGER EXISTS 503s EVERYTHING. ────────────────────
   This constant named one Render service, and when that service is deleted or replaced — Render
   appends a fresh suffix every time a blueprint is deployed under a name already in use, so
   -mlxq / -xutt / no suffix are all the same app at different moments — every /transcoder request
   answers 503. Both halves of that service go down together: the ffmpeg transcoder AND the
   activation store, which is why "reachable but error 503" in the app and "could not reach the
   server" on the admin screen arrived on the same day, with two perfectly healthy services sitting
   in the dashboard.
   So the origin is no longer one hard-coded guess. TRANSCODER_ORIGIN on the Worker still wins
   outright when set; otherwise the candidates below are probed on /health and the first that
   answers is used and remembered. Preference goes to one reporting activation: true — that is the
   service holding the Upstash store the admin dashboard writes codes to, and picking a different
   one would hand customers codes the live server has never heard of. Nothing is cached unless it
   actually answered, so a service still cold-starting is retried rather than written off. */
const TRANSCODER_CANDIDATES = [
  'https://media26-transcoder-production-f0b9.up.railway.app',
  'https://media26-transcoder.onrender.com',        /* the name render.yaml declares */
  'https://media26-transcoder-xutt.onrender.com',
  'https://media26-transcoder-mlxq.onrender.com'
];
const DEFAULT_TRANSCODER_ORIGIN = TRANSCODER_CANDIDATES[0];
const TRANSCODER_PROBE_TTL_MS = 5 * 60 * 1000;
let _tcOrigin = '', _tcAt = 0;

/* ── v24.63: ONE STORE, HOWEVER MANY HOSTS ────────────────────────────────────────────────────
   Activation codes used to sit in a single shared Redis, so it did not matter which of this
   account's several Worker hosts a seller or a customer happened to open — they all read the same
   records. A Durable Object store is per Worker PROJECT, so moving the store into the Worker
   quietly reintroduced that as a way to lose a code: activate on one host, poll from another, and
   the code is simply not there.
   LICENSE_HOME closes it. Set it (a Worker variable, or the value baked into wrangler.jsonc) to
   the ONE host that should own the store, and every other deployment forwards its licensing
   requests there instead of using its own — one store again, exactly like the Redis was.
   Unset, or set to this very host, means "I am home": serve locally, which is the correct
   behaviour for a single-host setup and the safe default for an owner who never sets anything.
   A forward that fails is reported as a failure and NEVER falls back to the local store: two
   stores disagreeing about who is activated is far worse than one honest error. */
/* v24.64: the default is a REAL host, not "whoever I am". This account serves the same app from
   more than one workers.dev address — a customer's device was observed loading it from m26-xtp
   while the dashboard sat on media26 — and both deploy from this repo. Left to own its own store,
   each address would keep a private set of codes and "activate here, poll from there" would lose
   a customer silently. Naming one home in code (rather than in a variable someone has to know to
   set) makes every deployment built from this repo share one store with no configuration at all.
   media26 is home because it is declared in this repo (wrangler.media26.jsonc) and verified live;
   smarteriptv is not a Worker at all (it answers Cloudflare's 1042 for an unrouted hostname).
   LICENSE_HOME still overrides it, so moving home later is a dashboard edit, not a release. */
const DEFAULT_LICENSE_HOME = 'https://media26.gz-inzi84.workers.dev';
function explicitLicenseHome(env) {
  try {
    const v = String((env && env.LICENSE_HOME) || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(v)) return v;
    if (v === 'self') return 'self';      /* explicit opt-out: this host keeps its own store */
  } catch (e) {}
  return '';
}
function licenseHome(env) {
  const v = explicitLicenseHome(env);
  if (v === 'self') return '';
  return v || DEFAULT_LICENSE_HOME;
}
function isLicenseHome(env, url) {
  const home = licenseHome(env);
  if (!home) return true;                 /* opted out: this host owns its own store */
  try { if (new URL(home).host === url.host) return true; } catch (e) { return true; }
  /* Nothing was configured, so `home` is this file's built-in default — a LIVE address. A dev
     server must not read and write the real customer store just by being started, so localhost
     keeps its own. An explicitly configured home is always honoured, including in dev, which is
     what makes the forwarding path testable at all. */
  if (!explicitLicenseHome(env) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url.host)) return true;
  return false;
}

function pinnedTranscoderOrigin(env) {
  try {
    const v = String((env && env.TRANSCODER_ORIGIN) || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(v)) return v;
  } catch (e) {}
  return '';
}

/* The best origin known WITHOUT going to the network — used by the relay helpers, which run inside
   a sign-in that must not wait on a health probe. */
function transcoderOrigin(env) {
  return pinnedTranscoderOrigin(env)
    || ((_tcOrigin && Date.now() - _tcAt < TRANSCODER_PROBE_TTL_MS) ? _tcOrigin : DEFAULT_TRANSCODER_ORIGIN);
}

/* The authoritative one: probes the candidates when nothing is pinned or freshly known. */
async function resolveTranscoderOrigin(env) {
  const pinned = pinnedTranscoderOrigin(env);
  if (pinned) return pinned;
  if (_tcOrigin && Date.now() - _tcAt < TRANSCODER_PROBE_TTL_MS) return _tcOrigin;
  let answered = '';
  for (const o of TRANSCODER_CANDIDATES) {
    let j = null;
    try {
      const r = await fetch(o + '/health', { method: 'GET', cf: { cacheTtl: 0 } });
      if (!r || !r.ok) continue;
      j = await r.json().catch(() => null);
    } catch (e) { continue; }
    if (!j || !j.ok) continue;
    if (j.activation) { _tcOrigin = o; _tcAt = Date.now(); return o; }   /* holds the code store */
    if (!answered) answered = o;
  }
  if (answered) { _tcOrigin = answered; _tcAt = Date.now(); return answered; }
  return DEFAULT_TRANSCODER_ORIGIN;   /* nothing answered — do not remember a guess */
}

function withCors(headers) {
  const out = new Headers(headers);
  out.set('access-control-allow-origin', '*');
  out.set('access-control-allow-methods', 'GET,HEAD,POST,OPTIONS');
  out.set('access-control-allow-headers', 'accept,content-type,range,authorization,x-admin-key');
  /* v19.41: `retry-after` joins the list so the APP can read it. A portal behind Cloudflare answers
     an over-eager sign-in with 429 + error 1015 and states exactly how long to stay away — 1236s,
     and 3510s if you knock again during it. The client could not see that header (a cross-origin
     response only exposes what is named here), so it fell back to a hard-coded 45-second cooldown
     and re-armed the ban roughly 27 times before it would have expired on its own. */
  out.set('access-control-expose-headers', 'content-length,content-range,accept-ranges,content-type,location,retry-after,x-transcoder-origin');
  out.set('cross-origin-resource-policy', 'cross-origin');
  out.set('timing-allow-origin', '*');
  return out;
}

/* Same-origin CORS relay for the app: /proxy?url=<encoded target>.
   index.html tries this path first when logging in to an Xtream portal, so the
   app keeps working even when every third-party CORS relay is down. Only public
   http(s) targets are allowed. */
const PRIVATE_HOST = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1?\]|\[f[cd])/i;

/* The User-Agent every upstream request to a panel carries. IPTV panels are built for set-top
   boxes and media players, and a great many of them gate their playlist AND their stream
   endpoints on seeing one — a browser UA gets a 403 or an HTML error page. Used by both the
   relay (/proxy) and the server-side playlist login (/api/playlist). */
const PLAYER_UA = 'VLC/3.0.20 LibVLC/3.0.20';
/* The set-top-box identity a MAC-locked line expects. Sent only on the MAC pass of the playlist
   login, alongside the `mac=` cookie, because a panel that binds a line to a MAC generally wants
   to see the request come from something that looks like a MAG box. */
const MAG_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
/* v19.17: the fallback identity for a panel whose edge refuses PLAYER_UA. Plenty of bot rules score
   "VLC/3.0.20" as a scraper and answer 403 without the panel ever seeing the request — which reads
   from here exactly like an IP block, but is disproved by one request wearing a browser string. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
/* v19.19: a User-Agent on its own is not a browser. Bot protection scores the whole request, and a
   bare two-header GET from a datacenter address is the easiest possible call to make against it —
   which is what both of this app's egresses were sending. These are the headers a real browser
   always carries on a top-level GET; supplying them is free and turns "obviously automated" into
   "plausibly a person" for the rule sets that decide on header shape rather than on IP alone. */
function browserHeaders() {
  return {
    'user-agent': BROWSER_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1'
  };
}

function corsJson(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCors(new Headers({ 'content-type': 'application/json' }))
  });
}

/* HLS playlist rewriting: Xtream panels emit playlists whose segment/key/variant
   URIs point straight at the http:// origin. On an https page those URIs are
   mixed content, so Safari (which plays HLS natively, no MSE) loads the playlist
   through the proxy but then every segment request is blocked — the stream
   freezes a few seconds in. Rewriting every URI to route back through /proxy
   keeps the whole stream (playlist + segments + keys) on this origin, which is
   what makes native iPhone playback work without a third-party relay. */
function looksLikeM3u8(target, upstream) {
  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  if (/mpegurl|m3u8/.test(ct)) return true;
  return /\.m3u8(?:$|\?)/i.test(target.pathname + target.search);
}
function rewriteM3u8(text, baseUrl, selfOrigin, relaySuffix) {
  const prox = u => {
    try { return selfOrigin + '/proxy?url=' + encodeURIComponent(new URL(u, baseUrl).href) + (relaySuffix || ''); }
    catch { return u; }
  };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + prox(u) + '"');
    return prox(t);
  }).join('\n');
}

async function handleProxy(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors(new Headers()) });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return corsJson(405, { error: 'Method not allowed' });
  }
  let target = null;
  try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch {}
  if (!target || !/^https?:$/.test(target.protocol)) {
    return corsJson(400, { error: 'Missing or invalid ?url= parameter' });
  }
  if (PRIVATE_HOST.test(target.hostname)) {
    return corsJson(403, { error: 'Target host not allowed' });
  }
  const headers = new Headers();
  /* v13.9: ask the panel as a PLAYER, not as a browser. Xtream panels routinely refuse a generic
     browser User-Agent on their stream endpoints — they answer 403, or an HTML error page that the
     media engines report as a plain network failure — which is precisely why /api/playlist has
     always sent a player UA. The relay, however, was still forwarding the browser's own UA, so a
     playlist that downloaded perfectly produced channels that would not open in the built-in
     player. Send the same player UA here. `&ua=browser` opts back in when a target needs it. */
  const qs = new URL(request.url).searchParams;
  const uaMode = qs.get('ua') || '';
  headers.set('user-agent', uaMode === 'browser'
    ? (request.headers.get('user-agent') || 'Mozilla/5.0')
    : PLAYER_UA);
  headers.set('accept', request.headers.get('accept') || '*/*');
  const range = request.headers.get('range');
  if (range) headers.set('range', range);
  /* Stalker/Ministra (MAG portal) auth: portal.php only recognises a request as coming from the
     set-top box when it carries a MAG user-agent, an X-User-Agent model string, and a `mac=`
     cookie — none of which a browser fetch() can set cross-origin (Cookie is a forbidden header
     name, and custom headers would need a CORS preflight the panel doesn't answer). The client
     instead passes the MAC/token as query params here, which this worker validates strictly
     (never forwarded verbatim — CRLF/header injection is not possible) and turns into the real
     MAG headers server-side before contacting the panel. */
  if (qs.get('stb') === '1') {
    const mac = qs.get('mac') || '';
    if (!/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(mac)) {
      return corsJson(400, { error: 'Invalid or missing mac for stb=1' });
    }
    const token = (qs.get('token') || '').trim();
    /* v14.8: the MAG User-Agent is itself a bot signature. When a portal sits behind Cloudflare
       with bot protection on, that string is one of the things that trips it — the request is
       answered with "Attention Required!" and never reaches portal.php at all. `ua=browser` keeps
       the MAC cookie and the MAG model header (which is what the PORTAL checks) while presenting
       an ordinary browser User-Agent (which is what the EDGE checks), so the app can try both. */
    /* ── v19.26: `ua=browser` NOW MEANS A BROWSER, ALL THE WAY DOWN. ────────────────────────────
       This fallback exists for one job — get past bot protection that refuses the MAG identity —
       and it was still shipping `x-user-agent: Model: MAG250; Link: WiFi` on every request,
       unconditionally, because that line sat below the if/else. A set-top-box model header is
       about as clear a "this is not a browser" signal as exists, so the edge scored it exactly the
       same as the MAG attempt it was supposed to rescue, and both came back as Cloudflare's
       "Attention Required!" page. Confirmed live: get.php reached the origin and answered 404,
       while portal.php with these headers never got past the edge at all.
       So on the browser pass, send what a browser sends and nothing a box would. The `mac=` cookie
       stays — that is what portal.php actually reads to identify the line, and a cookie is not a
       bot signature. */
    if (uaMode !== 'browser') {
      headers.set('user-agent', MAG_UA);
      headers.set('x-user-agent', 'Model: MAG250; Link: WiFi');
    } else {
      const bh = browserHeaders();
      for (const k in bh) headers.set(k, bh[k]);
      headers.delete('x-user-agent');
    }
    headers.set('cookie', 'mac=' + mac.toUpperCase() + '; stb_lang=en; timezone=UTC');
    if (token && /^[\w.\-]{1,256}$/.test(token)) headers.set('authorization', 'Bearer ' + token);
  }
  let upstream;
  try {
    upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
  } catch (e) {
    return corsJson(502, { error: 'Upstream fetch failed: ' + ((e && e.message) || e) });
  }
  const responseHeaders = withCors(upstream.headers);
  responseHeaders.delete('set-cookie');
  if (request.method === 'GET' && upstream.ok && looksLikeM3u8(target, upstream)) {
    const text = await upstream.text();
    if (/#EXTM3U/.test(text)) {
      responseHeaders.delete('content-length');
      responseHeaders.delete('content-encoding');
      responseHeaders.set('content-type', 'application/vnd.apple.mpegurl');
      responseHeaders.set('cache-control', 'no-store');
      const origin = new URL(request.url).origin;
      const mac = qs.get('mac') || '';
      const token = (qs.get('token') || '').trim();
      const relaySuffix = (qs.get('stb') === '1' && /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(mac))
        ? '&stb=1&mac=' + encodeURIComponent(mac.toUpperCase()) + (token && /^[\w.\-]{1,256}$/.test(token) ? '&token=' + encodeURIComponent(token) : '') + (uaMode === 'browser' ? '&ua=browser' : '')
        : (uaMode === 'browser' ? '&ua=browser' : '');
      return new Response(rewriteM3u8(text, upstream.url || target.href, origin, relaySuffix), {
        status: upstream.status,
        headers: responseHeaders
      });
    }
    responseHeaders.delete('content-encoding');
    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  }
  /* FIX (v3.9): the proxied URL carries no file extension, so Safari's native <video> decides
     whether it can play a movie purely from the Content-Type header. Xtream panels routinely serve
     VOD files as application/octet-stream (or text/html), which Safari refuses — so EVERY movie
     failed in the browser while external apps (which hit the file directly) played fine. Derive the
     correct media MIME from the target file extension and set it, so the browser recognises the
     stream as playable video/audio. */
  /* v5.0: use PERMISSIVE video/mp4 for container extensions the browser's <video> would otherwise
     REFUSE (mkv/avi/wmv/…). Panels often label a perfectly playable H.264/AAC file as .mkv; telling
     the browser video/x-matroska made iOS reject it outright, even though the same bytes play fine
     when downloaded. video/mp4 makes AVFoundation actually load and sniff the file — so mislabeled
     titles now play natively in the preview. A genuinely-incompatible file still errors and falls
     through to the transcoder. */
  const EXT_MIME = { mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', m4s:'video/iso.segment',
    ts:'video/mp2t', mkv:'video/mp4', webm:'video/webm', avi:'video/mp4', flv:'video/mp4',
    wmv:'video/mp4', vob:'video/mp4', divx:'video/mp4', m2ts:'video/mp4', mpg:'video/mp4', mpeg:'video/mp4',
    ogv:'video/ogg', '3gp':'video/3gpp',
    mp3:'audio/mpeg', aac:'audio/aac', m4a:'audio/mp4', ogg:'audio/ogg', flac:'audio/flac', wav:'audio/wav' };
  const extM = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(target.pathname + target.search);
  const ext = extM ? extM[1].toLowerCase() : '';
  if (EXT_MIME[ext]) responseHeaders.set('content-type', EXT_MIME[ext]);
  /* v4.7: download mode. dl=1 tells the browser to SAVE the file (attachment) instead of playing it,
     which hands it to the native download manager — background + auto pause/resume on network drops.
     accept-ranges must be exposed so the downloader can resume with byte-range requests. */
  const q = new URL(request.url).searchParams;
  if (q.get('dl')) {
    const raw = q.get('name') || ('video.' + (ext || 'mp4'));
    const safe = raw.replace(/[\r\n"\\]/g, '').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'video';
    responseHeaders.set('content-disposition', 'attachment; filename="' + safe + '"');
    if (!responseHeaders.get('accept-ranges')) responseHeaders.set('accept-ranges', 'bytes');
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

/* ── /api/playlist ─────────────────────────────────────────────────────────────────────────
   Server-side playlist login. The browser cannot fetch an http:// panel from an https:// page
   (mixed content), and even through the generic /proxy relay the client had to try each
   candidate playlist endpoint itself — five sequential cross-origin round-trips, each bounded
   by a short browser timeout, with every failure reason swallowed. A full IPTV M3U is routinely
   tens of megabytes, so those short client-side timeouts were the practical failure: the panel
   was answering, just not within the window.

   This endpoint moves the whole handshake server-side. One request from the browser; the worker
   walks the candidate endpoints itself with a player User-Agent (many panels reject generic
   browser UAs), follows redirects, verifies the payload really is an M3U, and returns it with
   CORS headers — or a JSON error naming exactly what each candidate did, so a failure is
   diagnosable instead of a blank "could not sign in".

   Credentials arrive in a POST body, never in the query string, so they stay out of URLs,
   referrers and edge logs. */
const MAX_PLAYLIST_BYTES = 48 * 1024 * 1024;

/* Read a response body up to a byte cap WITHOUT buffering the whole thing first. A full-catalogue
   playlist from a large panel can be a hundred megabytes; calling .text() on that is what made an
   otherwise-fine endpoint fail outright. Reading incrementally means an oversized playlist comes
   back TRUNCATED but usable — an M3U is a flat list, so a prefix parses into a working (if
   shorter) channel list, which beats failing the login entirely. */
async function readCapped(response, max) {
  const reader = response.body && response.body.getReader();
  if (!reader) return { text: await response.text(), truncated: false };
  const decoder = new TextDecoder('utf-8');
  let out = '', size = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      out += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (size - max))), { stream: false });
      truncated = true;
      try { await reader.cancel(); } catch (e) {}
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  if (!truncated) out += decoder.decode();
  /* drop a partial trailing line so the parser never sees half a URL */
  if (truncated) out = out.slice(0, out.lastIndexOf('\n') + 1 || out.length);
  return { text: out, truncated };
}

/* ── v19.17: WHAT THE SELLER ACTUALLY HANDED OVER ────────────────────────────────────────────
   Kept deliberately identical to Media26Portal.parseSignIn in portal.js — both sides build
   playlist addresses out of the same "portal URL" string, so they have to agree on what that
   string means.

   "Portal URL" is whatever the provider wrote in their own notes, and in practice it is the panel
   root, the MAG portal page (…/c/, …/stalker_portal/c/), an API file (…/player_api.php,
   …/portal.php) or the finished M3U link itself (…/get.php?username=…&type=m3u_plus).

   Every playlist address is base + '/get.php?…', so the base has to be the panel ROOT. Keeping the
   decoration the seller included produced addresses like `http://host:8080/c/get.php?username=…`,
   which exist on no panel anywhere — and the 404 or portal HTML that came back was then reported
   as a security layer blocking the app, on a line where nothing was blocking anything at all. */
const PORTAL_PATH_JUNK = /^(c|client|stalker_portal|portal|play|player|api|index\.html?|index\.php|portal\.php|load\.php|get\.php|player_api\.php|panel_api\.php|xmltv\.php|enigma2\.php|m3u|playlist)$/i;

function isPlaylistUrl(u) {
  try {
    const x = new URL(u);
    if (/\.m3u8?$/i.test(x.pathname)) return true;
    if (/[?&]type=m3u/i.test(x.search)) return true;
    if (/get\.php$/i.test(x.pathname) && /[?&](username|mac)=/i.test(x.search)) return true;
    return false;
  } catch (e) { return false; }
}

/* { root, typed, playlist, username, password } — see the note above. `playlist` short-circuits
   everything: when the customer pastes the link their provider gave them, it is fetched verbatim
   and no address is guessed at all. */
function parseSignIn(raw) {
  const out = { root: '', typed: '', playlist: '', username: '', password: '' };
  let s = String(raw || '').trim();
  if (!s) return out;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let x;
  try { x = new URL(s); } catch (e) { return out; }
  if (!/^https?:$/i.test(x.protocol)) return out;
  x.hash = '';
  if (isPlaylistUrl(x.href)) {
    out.playlist = x.href;
    out.username = x.searchParams.get('username') || '';
    out.password = x.searchParams.get('password') || '';
  }
  const parts = x.pathname.split('/').filter(Boolean);
  out.typed = (x.origin + '/' + parts.join('/')).replace(/\/+$/, '');
  while (parts.length && PORTAL_PATH_JUNK.test(parts[parts.length - 1])) parts.pop();
  out.root = (x.origin + '/' + parts.join('/')).replace(/\/+$/, '');
  return out;
}

/* v15.0: PLAYLIST BY MAC ADDRESS. This is the flow the app is built around — the app shows a MAC,
   the reseller binds a line to it, and from then on the portal hands that MAC its own M3U, with no
   username or password anywhere in the picture. Panels differ in where they expose it and in
   whether they want the MAC with or without colons, so both shapes are tried, most common first.
   v19.17: over the panel root first, then the path as typed. */
function macPlaylistCandidates(bases, mac) {
  if (!mac) return [];
  const enc = encodeURIComponent(mac);         // 00%3A1A%3A79%3A45%3AFD%3AAD
  const flat = mac.replace(/:/g, '');          // 001A7945FDAD
  const out = [];
  const add = x => { if (x && out.indexOf(x) < 0) out.push(x); };
  for (const b of (bases || [])) {
    if (!b) continue;
    add(b + '/get.php?mac=' + enc + '&type=m3u_plus&output=ts');
    add(b + '/get.php?mac=' + enc + '&type=m3u_plus');
    add(b + '/get.php?username=' + enc + '&password=' + enc + '&type=m3u_plus&output=ts');
    add(b + '/get.php?mac=' + enc + '&type=m3u');
    add(b + '/playlist/' + enc + '/m3u_plus');
    add(b + '/play/get.php?mac=' + enc + '&type=m3u_plus');
    add(b + '/get.php?mac=' + flat + '&type=m3u_plus');
    add(b + '/get.php?username=' + flat + '&password=' + flat + '&type=m3u_plus');
    add(b + '/get.php?mac=' + enc);
  }
  return out;
}
function playlistCandidates(sig, user, pass, variant, mac) {
  /* The portal URL IS the playlist — a link the provider handed over ready-made, or a direct
     .m3u/.m3u8. Nothing to guess: fetch exactly what was given. */
  if (sig.playlist) return [sig.playlist];
  const bases = sig.root === sig.typed ? [sig.root] : [sig.root, sig.typed];
  if (!bases[0]) return [];
  const u = encodeURIComponent(user || ''), p = encodeURIComponent(pass || '');
  const out = [];
  const add = x => { if (x && out.indexOf(x) < 0) out.push(x); };
  /* No username at all: the MAC IS the identity.
     v19.1.0: this returned before the variant==='full' branch below ever ran, so a MAC-only line
     asking for the FULL catalogue was handed the same candidate list as the login — led by the
     compact `output=ts` document it already had. The follow-up request therefore re-fetched the
     document that was short in the first place, merged nothing, and Movies/Series stayed exactly
     as they were. v18.3 fixed the client-side guard for MAC lines (fullPlaylistCatalog) but this
     side still discarded the variant, which is why that fix did not show up for them. */
  if (!user) {
    if (!mac) return [bases[0]];
    const macList = macPlaylistCandidates(bases, mac);
    if (variant === 'full') {
      const full = macList.filter(x => !/[?&]output=ts(&|$)/i.test(x));
      return full.length ? full : macList;
    }
    return macList;
  }
  /* v13.9: the FULL-CATALOGUE variant, asked for separately and only once the user is already
     signed in and watching. Login still leads with the compact live-oriented document (below) —
     that ordering is what made logins reliable and must not change. But when that document turns
     out to hold no films or shows, Movies and Series were left permanently empty on any panel
     whose player_api is closed or throttled, even though its own get.php serves the whole
     catalogue. Asking for that document as a deliberate follow-up request costs the login
     nothing: it happens in the background, and a failure just leaves the tabs as they were. */
  if (variant === 'full') {
    for (const b of bases) {
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus');
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=m3u8');
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u');
      add(b + '/playlist/' + u + '/' + p + '/m3u_plus');
    }
    return out;
  }
  /* Order by what RELIABLY ANSWERS, not by what carries the most content. v13.3 briefly led with
     plain type=m3u_plus to pick up movies/series in one document, and that broke logins that had
     been working: on a big panel that variant is the entire catalogue — often far larger than a
     worker should buffer — so it blew the size cap, and the retries behind it fared no better
     against a panel that throttles. The &output=ts variant is the compact, live-oriented document
     these panels serve dependably, so it leads again. Movies and Series no longer depend on this
     choice at all: when the playlist has none, the app asks the panel's own VOD/series endpoints
     for those tabs (see loadTypeFromApi) and, failing that, re-requests this endpoint with
     variant:'full' in the background (see fullPlaylistCatalog) — neither of which can delay or
     break the login. */
  /* NOTE: the bare base URL is deliberately NOT a candidate once we hold credentials. A bare GET
     on / can only ever return the panel's landing page — on a Stalker/Ministra host that is the
     portal's HTML, which is exactly the confusing "the panel answered / with HTTP 200 —
     stalker_portal…" result. With a username in hand, only real playlist endpoints are worth
     asking. The bare URL stays a candidate in the no-credentials case above, where it is a
     directly-pasted playlist link. */
  for (const b of bases) {
    add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=ts');
    add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus');
    add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u');
    add(b + '/playlist/' + u + '/' + p + '/m3u_plus');
    add(b + '/get.php?username=' + u + '&password=' + p);
  }
  /* v19.21: NO MAC-KEYED ADDRESSES ON A LINE THAT HAS A LOGIN. These are a DIFFERENT line's
     playlist — whatever this device's MAC happens to be bound to on that panel, if anything — not
     a second chance at this one. This product signs in with a portal URL, a login and a password
     resolving through get.php; there is no MAC in the sign-in UI and none on the seller's record.
     Appending them doubled the request count against a rate-limiting panel and, when nothing
     answered, made the failure look like a MAC problem on an account that has no MAC. */
  return out;
}

function looksLikePlaylist(text) {
  const head = String(text || '').slice(0, 4096);
  return /^\s*#EXTM3U/i.test(head) || /#EXTINF/i.test(head);
}

/* A Stalker/Ministra (MAG) portal is a completely different product from an Xtream panel: it has
   no get.php and no player_api.php, and it authenticates by MAC ADDRESS rather than by username
   and password. Asking one for a playlist therefore cannot ever succeed, and the failure is
   indistinguishable from bad credentials unless we recognise it. Its landing page is unmistakable
   — it ships the portal bootstrap JavaScript. Spotting it lets the app say "use the MAC option"
   instead of telling someone to re-check a password that was never going to work. */
function looksLikeStalkerPortal(text) {
  const head = String(text || '').slice(0, 20000);
  return /stalker_portal|\bvar\s+gmode\b|\bresolution_prefix\b|\/c\/version\.js|ministra/i.test(head);
}

/* Statuses that mean "the edge in front of the panel refused THIS caller" rather than "the panel
   answered no". Cloudflare returns 403 (bot/WAF), 429 (its own rate-limit, error 1015) and 503
   (challenge) for a request it will not pass through, all without the origin ever seeing it. */
function edgeRefused(status) {
  return status === 403 || status === 429 || status === 503;
}

/* v22.8: a Cloudflare (or similar) BOT CHALLENGE served with a 200. A panel behind Cloudflare
   answers this worker — a datacenter address — with a "checking your browser" interstitial that
   carries HTTP 200, so edgeRefused() (which reads the STATUS) never fires, the body simply is not
   a playlist, and the relay that reaches the same panel from an ordinary-hosting IP is never
   tried. A phone on a home connection gets the real playlist, which is exactly the "works in
   another app, not here" report. Spotting the interstitial lets us treat it as the block it is
   and go out through the relay. Only ever tested on a body already known not to be a playlist. */
function looksLikeChallenge(text) {
  const head = String(text || '').slice(0, 4096);
  return /just a moment|checking your browser|cf-browser-verification|__cf_chl|cf-chl-|cf_chl_opt|attention required|ddos protection by|enable javascript and cookies|please turn javascript on|_cf_chl_|challenge-platform/i.test(head);
}

/* v19.18: WHOSE security layer is it. A refusal answered by Cloudflare carries Cloudflare's own
   fingerprint — `server: cloudflare` and a cf-ray id — and saying so turns an unactionable "a
   security layer refused us" into something the provider can fix in one setting on their own
   dashboard. It also settles the argument the customer is otherwise stuck in: the block is not
   their subscription and not their details, it is bot protection on the domain refusing traffic
   that does not come from a home connection. */
function edgeName(response) {
  try {
    const server = String(response.headers.get('server') || '').toLowerCase();
    if (response.headers.get('cf-ray') || server === 'cloudflare') return 'cloudflare';
    if (server) return server.slice(0, 40);
  } catch (e) {}
  return '';
}

/* Re-issue a request through the transcoder service, which sits on ordinary hosting with IPs
   unrelated to Cloudflare's. Its /proxy already speaks the MAG dialect (stb=1&mac=), so the MAC
   pass survives the detour intact. Best-effort: any failure returns null and the caller keeps its
   original verdict.

   v18.0: WAKE IT, THEN RETRY IT. This is the app's only second egress, and it runs on a free plan
   that puts the instance to sleep after ~15 minutes idle. A sleeping instance answers the first
   request with a 502/503 holding page (or nothing) for the 30-60s it takes to boot — so the retry
   that exists precisely to rescue a Cloudflare-fronted portal was itself arriving at a service
   that was not up, one single time, and giving up. That is why a correctly-registered line could
   fail at sign-in: BOTH egresses were refused, one by the portal's edge and one by its own host
   still starting. The wake ping now goes out the moment a login begins, and a cold answer is
   retried instead of counted as a failure. */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/* Render answers 502/503/504 while an instance boots; a network error reads the same way. None of
   these is the relay saying no — it is the relay not being there yet. */
function relayWaking(status) { return !status || status === 502 || status === 503 || status === 504; }
/* v18.5: LONG ENOUGH FOR THE THING WE ARE ACTUALLY WAITING FOR. v18.0 allowed 0+2500+6000 — about
   eight and a half seconds — to wake a free-plan container whose documented cold start is thirty to
   sixty. So the second egress was declared dead before it had finished booting, every single time
   it had been asleep, and a portal that refuses Cloudflare (which is the ONLY reason this relay is
   being used) had no route left at all. The sign-in then reported a security layer turning the
   request away, which is true of the first egress and says nothing about the second.
   Waiting here is cheap and correct: the origin has ALREADY refused, so there is nothing else to
   try and nothing to race. A booting container answers 502/503 immediately, so these retries cost
   almost nothing until the one that succeeds. ~45s total, which covers a normal cold start. */
const RELAY_WAKE_BACKOFF_MS = [0, 3000, 6000, 9000, 12000, 15000];
/* How many playlist candidates are worth pushing through the relay once the portal's own edge has
   turned this worker away. The relay reaches the same portal, so these still count against its
   limiter — enough to find the endpoint shape, not enough to look like a sweep. */
const RELAY_CANDIDATE_BUDGET = 6;

/* Fire-and-forget: start the boot while the worker is still walking the portal's own endpoints, so
   the relay has a head start measured in seconds rather than starting from cold when first needed. */
function wakeRelay(env, state) {
  try {
    const base = transcoderOrigin(env);
    if (!/^https?:\/\//i.test(base)) { state.dead = true; return; }
    fetch(base.replace(/\/+$/, '') + '/health', { method: 'GET' })
      .then(r => { if (r && r.ok) state.awake = true; })
      .catch(() => {});
  } catch (e) {}
}

/* ── v22.9: XTREAM API (player_api.php) → M3U. ────────────────────────────────────────────────
   Fetch the account, then the live + VOD categories and streams, and assemble the same m3u_plus a
   working get.php would have returned — group-titles, logos, and canonical /live/ and /movie/
   stream URLs the app already knows how to play. Server-side only (the browser cannot fetch an
   http panel from an https page). Returns {m3u, endpoint} on success, {rejected:true} when the
   panel says the login is not active, or null when the API is simply not there. */
async function xtreamGet(base, user, pass, action, env, relay) {
  const u = encodeURIComponent(user), p = encodeURIComponent(pass);
  const url = base + '/player_api.php?username=' + u + '&password=' + p + (action ? '&action=' + action : '');
  let r = null;
  try {
    r = await fetch(url, { headers: { 'user-agent': PLAYER_UA, 'accept': 'application/json,*/*' }, redirect: 'follow' });
  } catch (e) { return null; }
  let text = '';
  try { text = r ? await r.text() : ''; } catch (e) { return null; }
  /* Behind Cloudflare the API answers this worker with a 200 bot-check too — try the relay, exactly
     as the get.php path does. */
  if ((!r.ok || looksLikeChallenge(text)) && relay && !relay.dead) {
    try {
      const relayed = await viaRelay(env, new URL(url), false, '', relay);
      if (relayed && relayed.ok) text = await relayed.text();
    } catch (e) {}
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function tryXtreamApi(env, baseUrl, user, pass, relay, mac, attempts) {
  /* The bases most likely to answer the API: the host on its default port and on :8080, plus the
     exact base the seller gave. Panel ports that came back 521 are dead and not worth another try. */
  const host = baseUrl.hostname;
  const given = baseUrl.origin;
  const bases = [];
  const add = b => { if (b && bases.indexOf(b) < 0) bases.push(b); };
  add('http://' + host);
  add('http://' + host + ':8080');
  add(given);
  add('https://' + host);

  for (const base of bases) {
    const info = await xtreamGet(base, user, pass, '', env, relay);
    if (!info || !info.user_info) continue;                 /* not an Xtream API here */
    const ui = info.user_info;
    if (ui.auth === 0 || /disabled|expired|banned/i.test(String(ui.status || ''))) {
      attempts.push({ endpoint: base + '/player_api.php', error: 'account not active (' + (ui.status || 'auth 0') + ')' });
      return { rejected: true };
    }
    /* the streaming host/port the panel itself reports, when it gives one — otherwise this base */
    let streamBase = base;
    try {
      const si = info.server_info || {};
      if (si.url && si.port) streamBase = (si.https_port && base.startsWith('https') ? 'https://' : 'http://') + si.url + ':' + (base.startsWith('https') ? (si.https_port || si.port) : si.port);
    } catch (e) {}

    const [liveCats, vodCats, live, vod] = await Promise.all([
      xtreamGet(base, user, pass, 'get_live_categories', env, relay),
      xtreamGet(base, user, pass, 'get_vod_categories', env, relay),
      xtreamGet(base, user, pass, 'get_live_streams', env, relay),
      xtreamGet(base, user, pass, 'get_vod_streams', env, relay)
    ]);
    const catName = (arr) => {
      const m = {};
      if (Array.isArray(arr)) for (const c of arr) m[String(c.category_id)] = c.category_name || 'Other';
      return m;
    };
    const liveMap = catName(liveCats), vodMap = catName(vodCats);
    const u = encodeURIComponent(user), p = encodeURIComponent(pass);
    const esc = (v) => String(v == null ? '' : v).replace(/[\r\n",]/g, ' ').trim();
    const lines = ['#EXTM3U'];
    let n = 0;
    if (Array.isArray(live)) for (const s of live) {
      const id = s.stream_id; if (id == null) continue;
      const grp = liveMap[String(s.category_id)] || 'Live';
      lines.push('#EXTINF:-1 tvg-id="' + esc(s.epg_channel_id) + '" tvg-logo="' + esc(s.stream_icon) + '" group-title="' + esc(grp) + '",' + esc(s.name));
      lines.push(streamBase + '/live/' + u + '/' + p + '/' + id + '.ts');
      n++;
    }
    if (Array.isArray(vod)) for (const s of vod) {
      const id = s.stream_id; if (id == null) continue;
      const grp = vodMap[String(s.category_id)] || 'Movies';
      const ext = esc(s.container_extension) || 'mp4';
      lines.push('#EXTINF:-1 tvg-logo="' + esc(s.stream_icon || s.cover) + '" group-title="' + esc(grp) + '",' + esc(s.name));
      lines.push(streamBase + '/movie/' + u + '/' + p + '/' + id + '.' + ext);
      n++;
    }
    if (!n) { attempts.push({ endpoint: base + '/player_api.php', error: 'API answered but listed no streams' }); continue; }
    attempts.push({ endpoint: base + '/player_api.php', note: 'Xtream API: ' + n + ' streams' });
    return { m3u: lines.join('\n') + '\n', endpoint: base + '/player_api.php' };
  }
  return null;
}

async function viaRelay(env, target, useMac, mac, state) {
  const st = state || {};
  if (st.dead) return null;                       /* already established it is not coming up */
  const base = transcoderOrigin(env);
  if (!/^https?:\/\//i.test(base)) { st.dead = true; return null; }
  let relay = base.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(target.href);
  if (useMac && mac) relay += '&stb=1&mac=' + encodeURIComponent(mac);
  /* v19.19: THE RELAY GETS THE SAME SECOND CHANCE THE ORIGIN DOES. The relay exists for exactly one
     situation — a panel whose edge refuses this worker — and it was asking that panel with the same
     bare player identity that had just been refused here, from a datacenter address of its own. So
     the app's "second, independent route" was reliably failing on the same test as the first. Once
     the origin has turned us away, ask through the relay as a browser (server.js /proxy honours
     `ua=browser`, and now sends the full browser header set for it). */
  if (!useMac && st.originBlocked) relay += '&ua=browser';
  const headers = useMac
    ? { 'user-agent': MAG_UA, 'accept': '*/*' }
    : (st.originBlocked ? browserHeaders() : { 'user-agent': PLAYER_UA, 'accept': '*/*' });
  /* Only the first use pays for the cold start. Once the relay has answered as itself — or has
     been written off — every later candidate gets a single attempt, so a login never spends the
     wake budget more than once. */
  const plan = st.awake ? [0] : RELAY_WAKE_BACKOFF_MS;
  let last = null;
  for (let i = 0; i < plan.length; i++) {
    if (plan[i]) await sleep(plan[i]);
    let r = null;
    try { r = await fetch(relay, { method: 'GET', headers, redirect: 'follow' }); }
    catch (e) { r = null; }
    if (r && !relayWaking(r.status)) { st.awake = true; return r; }
    last = r;
  }
  st.dead = true;
  return last;
}

async function handlePlaylist(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors(new Headers()) });
  }
  if (request.method !== 'POST') {
    return corsJson(405, { error: 'Use POST with {url, username, password}' });
  }
  let body = {};
  try { body = await request.json(); } catch { return corsJson(400, { error: 'Invalid JSON body' }); }

  const macHex = String(body.mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const mac = macHex.length === 12 ? macHex.match(/../g).join(':') : '';

  const rawBase = String(body.url || '').trim();
  if (!rawBase) return corsJson(400, { error: 'Missing portal url' });
  /* Accept a bare host ("tv.example.com") the same way the app's own normalise() does. */
  const withScheme = /^https?:\/\//i.test(rawBase) ? rawBase : 'http://' + rawBase;
  let baseUrl;
  try { baseUrl = new URL(withScheme); } catch { return corsJson(400, { error: 'Invalid portal url' }); }
  if (!/^https?:$/.test(baseUrl.protocol)) return corsJson(400, { error: 'Portal url must be http or https' });
  if (PRIVATE_HOST.test(baseUrl.hostname)) return corsJson(403, { error: 'Target host not allowed' });
  /* v19.17: the panel root, the path as typed, and whether this URL is already the playlist. Every
     candidate below is built from these rather than from the raw string, which is what stops a
     seller's "/c/" or "/stalker_portal/c/" from being carried into an address no panel serves. */
  const sig = parseSignIn(withScheme);
  if (!sig.root) return corsJson(400, { error: 'Invalid portal url' });

  /* v14.3: THE DEVICE MAC, sent with the username and password.
     The product flow is: the app shows a MAC, the reseller creates the line in their panel BOUND
     to that MAC, and the customer then signs in with a username and password. A MAC-locked line
     refuses a request that carries no MAC, and until now the playlist login sent none at all —
     so the one flow the app is built around could not complete. Panels implement the check two
     ways, so both are sent together on the MAC pass: `&mac=` on the query string, and the MAG
     `mac=` cookie with a set-top-box User-Agent. Strictly validated, never forwarded verbatim. */
  /* Which of the two products this is being asked on behalf of: a line with a username and
     password is authorised by those, a line without one is authorised by its MAC. */
  /* v19.17: a pasted get.php link carries the line's identity in its own query string. When the
     customer pastes that as the portal URL and leaves the login boxes empty — which is exactly what
     "here is your M3U link" invites — those credentials are the ones to sign in with, rather than
     falling through to the MAC flow as if no identity had been supplied at all. */
  const user = String(body.username || '').trim() || sig.username;
  const pass = (body.password != null && String(body.password) !== '') ? String(body.password) : sig.password;
  const hasCreds = !!user;
  const variant = String(body.variant || '').trim().toLowerCase();
  let candidates = playlistCandidates(sig, user, pass, variant, mac);
  /* ── v21.6: THE ADDRESS THAT WORKED LAST TIME GOES FIRST. ────────────────────────────────────
     A panel serves its playlist on exactly ONE of these shapes, and which one never changes for a
     given line — yet every sign-in re-walked the whole list from the top, paying for each refusal
     before reaching the one address that has answered every day for months. The app now sends
     back whatever answered last (see x-m26-endpoint below) and it is tried first; everything else
     follows in the usual order, so a panel that moves its playlist still resolves, one walk later
     and never worse than before. Only accepted when it points at the same host as the portal URL
     being signed in to, so a stale hint can never redirect a login somewhere else. */
  const hint = String(body.prefer || '').trim();
  if (hint) {
    try {
      const h = new URL(hint);
      if (/^https?:$/.test(h.protocol) && h.hostname === baseUrl.hostname && !PRIVATE_HOST.test(h.hostname)) {
        candidates = [hint].concat(candidates.filter(c => c !== hint));
      }
    } catch (e) {}
  }
  const attempts = [];
  let sawStalker = false, rejected = 0, limited = 0, blocked = 0, blockedBy = '';
  /* Shared across every candidate in this login: whether the portal's edge has already turned this
     worker away, and what state the second egress is in. */
  const relay = { awake: false, dead: false, originBlocked: false, spent: 0, exhausted: false, uaTried: false, useBrowserUa: false, refused: false, sawChallenge: false };
  wakeRelay(env, relay);

  /* Stop walking candidates when there is provably nothing left to learn from another request:
     the portal's edge has refused this worker AND the relay is not coming up (so every remaining
     candidate would fetch the same challenge page), or the relay's candidate budget is spent. In
     both cases the next useful step is the diagnostic probe, not twenty-odd more knocks — and
     those knocks are what push a portal that was merely throttling into refusing outright. */
  const exhausted = () => relay.exhausted || (relay.originBlocked && relay.dead);

  /* v19.32: the label carries the ORIGIN as well as the path. Every candidate has the same
     pathname — /get.php — so a list of them said "/get.php?… 404" over and over and named none of
     the addresses actually asked. The origin is the only part that differs between them, and it is
     the whole question when a playlist is hiding on another port or scheme. */
  const label = (target, useMac) =>
    target.origin + target.pathname + (target.search ? '?…' : '') + (useMac ? ' +stb' : (mac ? ' +mac' : ''));

  /* Read and validate whatever answered — the portal directly or the relay standing in for it.
     Split out so both routes through attempt() judge the body by exactly the same rules. */
  /* ── v21.5: THE PLAYLIST IS NO LONGER READ INTO MEMORY HERE. ─────────────────────────────────
     This buffered the whole document as one string and stopped at 48 MB, which is how a full
     catalogue came back with "some titles at the end were left out": a Worker gets ~128 MB, and
     48 MB of UTF-8 is already ~96 MB once it is a JS string, so the cap was protecting the Worker
     from itself rather than protecting anyone from a big playlist.
     Nothing here needs the whole document. Only the FIRST few kilobytes decide whether this
     candidate answered with an M3U, a Stalker portal or an error page. So sniff that much, then
     hand the browser a stream that replays the sniffed head and pipes the rest straight through:
     no cap, no truncation, and the Worker's memory no longer scales with the customer's library. */
  const SNIFF_BYTES = 64 * 1024;
  const finish = async (upstream, target, useMac) => {
    let head = null, text = '', rest = null;
    try {
      rest = upstream.body && upstream.body.getReader();
      if (!rest) {
        text = await upstream.text();
      } else {
        const parts = []; let size = 0;
        while (size < SNIFF_BYTES) {
          const { done, value } = await rest.read();
          if (done) { rest = null; break; }
          parts.push(value); size += value.byteLength;
        }
        head = new Uint8Array(size);
        let at = 0; for (const part of parts) { head.set(part, at); at += part.byteLength; }
        text = new TextDecoder('utf-8').decode(head);
      }
    } catch (e) {
      attempts.push({ endpoint: label(target, useMac), error: 'read failed: ' + String((e && e.message) || e).slice(0, 80) });
      return null;
    }
    if (!looksLikePlaylist(text)) {
      /* v14.3: a Stalker-looking answer is REMEMBERED, not acted on immediately. Plenty of hosts
         run a Ministra portal on / AND serve get.php perfectly well; bailing out at the first
         sight of portal markup meant the remaining playlist endpoints — and the whole MAC pass —
         were never tried, and the user was pushed into a MAC handshake instead of simply being
         logged in. It is only the answer if nothing else produces a playlist. */
      if (looksLikeStalkerPortal(text)) { sawStalker = true; return null; }
      /* v22.8: a 200 bot-challenge is an edge block wearing an OK status — remember it so the
         caller can retry this candidate through the relay (which our edgeRefused path already does
         for a 4xx/5xx block, but never reached here). */
      if (looksLikeChallenge(text)) relay.sawChallenge = true;
      /* Report WHAT came back instead of just "not a playlist" — an HTML challenge page, a login
         form or a panel error message are all diagnosable, and all look identical without this. */
      attempts.push({
        endpoint: label(target, useMac),
        status: upstream.status,
        error: relay.sawChallenge ? 'a bot-check page, not a playlist (edge challenge)' : 'not an M3U playlist',
        got: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      });
      return null;
    }
    const headersOut = withCors(new Headers({
      'content-type': 'audio/x-mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'x-m26-source': target.origin + target.pathname,
      'x-m26-endpoint': target.href,
      'x-m26-truncated': '0'
    }));
    headersOut.set('access-control-expose-headers', 'x-m26-source,x-m26-endpoint,x-m26-truncated');
    /* Whole body already in hand (no streaming body on this response) — send it as it is. */
    if (!rest) return new Response(head || text, { status: 200, headers: headersOut });
    /* Otherwise: the sniffed head first, then the untouched remainder. */
    const body = new ReadableStream({
      start(controller) { controller.enqueue(head); },
      async pull(controller) {
        const { done, value } = await rest.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      },
      cancel(reason) { try { rest.cancel(reason); } catch (e) {} }
    });
    return new Response(body, { status: 200, headers: headersOut });
  };

  /* One candidate, one pass. Returns a Response on success, null to keep going. */
  const attempt = async (candidate, useMac) => {
    let target;
    try { target = new URL(candidate); } catch { return null; }
    if (PRIVATE_HOST.test(target.hostname)) return null;   /* a redirect target could differ from base */
    /* v14.4: the MAC rides along on the FIRST pass too. A panel that does not bind lines to a
       MAC simply ignores an unknown query parameter, so this costs nothing there — while a panel
       that checks `mac=` on the query string now authorises on request number one instead of
       request number six. That matters more than tidiness here: these portals rate-limit hard,
       and every wasted request is what pushes a legitimate sign-in into a 429 it cannot escape.
       The second pass is now only about the OTHER way panels check — the MAG cookie and set-top
       User-Agent — rather than about the MAC being present at all. */
    /* ── v18.7: THE MAC BELONGS TO THE MAC PASS, NOT TO EVERY REQUEST. ────────────────────────
       v14.4 attached the MAC to the credentials pass as well, reasoning that a MAC-locked panel
       would then authorise on request one instead of request six. The cost of that was never
       counted: it also attaches a MAC to every request made on behalf of a line that is NOT sold
       by MAC. These are two different products. An Xtream Code line is authorised by its username
       and password and has no MAC at all, and handing a panel a MAC it has never seen is at best
       noise and at worst the thing it refuses on — a refusal that then reads as "your details are
       wrong" for details that are perfectly correct.
       So: pass one is exactly the line's own identity — credentials only, nothing invented. Pass
       two is the MAC line, where the MAC goes on the query string AND in the MAG cookie. A line
       with no username keeps the MAC from the start, because there the MAC IS the identity
       (macPlaylistCandidates builds those addresses). */
    if (mac && (useMac || !hasCreds)) target.searchParams.set('mac', mac);
    const headers = useMac
      ? { 'user-agent': MAG_UA, 'accept': '*/*' }
      : (relay.useBrowserUa ? browserHeaders() : { 'user-agent': PLAYER_UA, 'accept': '*/*' });
    if (useMac) headers.cookie = 'mac=' + mac + '; stb_lang=en; timezone=UTC';
    let upstream;
    /* v18.0: once this portal's edge has turned the worker away, it will turn away every
       remaining candidate too — and each one raises the counter that keeps the door shut. Send
       the rest straight out through the other egress instead of knocking again from an address
       that has already been refused. */
    if (relay.originBlocked && !relay.dead) {
      /* The relay reaches the SAME portal from a different address — so the request count still
         lands on the portal, and walking all 14 candidates through it is the very burst that
         convinces a rate limiter it is under attack. A handful is enough to find the endpoint
         shape this panel serves; past that the probe below gives a better answer than more
         guessing would. */
      if (relay.spent >= RELAY_CANDIDATE_BUDGET) { relay.exhausted = true; return null; }
      relay.spent++;
      upstream = await viaRelay(env, target, useMac, mac, relay);
      if (!upstream || !upstream.ok) {
        attempts.push({ endpoint: label(target, useMac), status: (upstream && upstream.status) || 0, note: 'via relay' });
        if (upstream && upstream.status === 429) limited = 429;
        /* v19.18: the relay ANSWERED and was refused on its own account. That is a different fact
           from the relay still booting, and the app must be able to tell them apart — see below. */
        if (upstream && edgeRefused(upstream.status)) relay.refused = true;
        return null;
      }
      return await finish(upstream, target, useMac);
    }
    try {
      upstream = await fetch(target.href, { method: 'GET', headers, redirect: 'follow' });
    } catch (e) {
      attempts.push({ endpoint: label(target, useMac), error: String((e && e.message) || e).slice(0, 120) });
      return null;
    }
    /* v22.8: a bot-challenge answered 200. finish() will set relay.sawChallenge; catch it and go
       out through the relay for this same candidate, exactly as the 4xx/5xx edge path does. From
       then on relay.originBlocked routes every remaining candidate through the relay too. */
    if (upstream.ok && !relay.originBlocked && !relay.dead) {
      const direct = await finish(upstream, target, useMac);
      if (direct) return direct;
      if (relay.sawChallenge) {
        relay.originBlocked = true;
        const relayed = await viaRelay(env, target, useMac, mac, relay);
        if (relayed && relayed.ok) {
          attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: 'bot-check page; retried via relay' });
          return await finish(relayed, target, useMac);
        }
        attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: relayed ? 'relay also ' + relayed.status : 'relay unreachable' });
        if (relayed && edgeRefused(relayed.status)) relay.refused = true;
      }
      return null;
    }
    /* v15.3: SECOND EGRESS. A 403/429/503 here is very often not the panel refusing the account
       but the panel's EDGE refusing where the request came from — this worker runs on Cloudflare,
       and a portal behind Cloudflare routinely blocks that on the very first request, which is
       why waiting never clears it. The transcoder service runs on ordinary hosting with entirely
       different IPs and already relays these exact requests (server.js /proxy, MAG headers and
       all), so the same attempt is simply a different visitor. Retry there before giving up. */
    if (edgeRefused(upstream.status)) {
      /* v19.17: BEFORE writing the address off, try the other identity. PLAYER_UA is
         "VLC/3.0.20 LibVLC/3.0.20" — a plain-media-player string that a good number of panels
         (and the bot rules in front of them) refuse outright, while the very same request from
         something that looks like a browser is served normally. That refusal is indistinguishable
         from an IP block from here, and it is the cheaper of the two to disprove: one extra
         request, once per sign-in, before any of the relay machinery is woken up. */
      if (!relay.uaTried && !useMac) {
        relay.uaTried = true;
        let asBrowser = null;
        try {
          asBrowser = await fetch(target.href, { method: 'GET', headers: browserHeaders(), redirect: 'follow' });
        } catch (e) { asBrowser = null; }
        if (asBrowser && asBrowser.ok) {
          attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: 'player UA refused; succeeded as a browser' });
          relay.useBrowserUa = true;
          return await finish(asBrowser, target, useMac);
        }
      }
      relay.originBlocked = true;
      const relayed = await viaRelay(env, target, useMac, mac, relay);
      if (relayed && relayed.ok) {
        attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: 'edge refused; succeeded via relay' });
        upstream = relayed;
      } else {
        attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: relayed ? 'relay also ' + relayed.status : 'relay unreachable' });
        if (relayed && edgeRefused(relayed.status)) relay.refused = true;
        /* v18.0: THIS IS NOT A REJECTION OF THE ACCOUNT. A 403 or 503 from an edge means the
           portal's own code never saw the request, so it can have had no opinion about the
           username, the password or the MAC — and reporting it as `rejected` is what put "check
           the username and password" in front of customers whose details were exactly right.
           Only the portal answering for itself (below) can reject credentials. A 429 keeps its
           own reason because "wait, it is throttling" is both true and more specific. */
        if (upstream.status === 429) limited = 429;
        else { blocked = upstream.status; blockedBy = blockedBy || edgeName(upstream); }
        return null;
      }
    } else if (!upstream.ok) {
      attempts.push({ endpoint: label(target, useMac), status: upstream.status });
      /* 429 is the panel throttling: stop everything, more requests only make it worse.
         401/403 is a rejection of THIS pass — on a MAC-locked line that is exactly what the
         credentials-only pass is supposed to get, so it must not end the whole login any more. */
      if (upstream.status === 429) limited = 429;
      else if (upstream.status === 401 || upstream.status === 403) rejected = upstream.status;
      return null;
    }
    return await finish(upstream, target, useMac);
  };

  /* Pass 1: credentials only — identical to what has always worked, same endpoints, same order,
     same request count for any panel that answers. */
  /* ── v21.6: TWO AT A TIME, NOT ONE. ─────────────────────────────────────────────────────────
     Walking these strictly one after another means the wait is the SUM of every refusal ahead of
     the address that works — the single biggest part of a first sign-in. Asking two at once halves
     that, and two is the whole of the increase: these panels sit behind protection that counts a
     burst of requests as a sweep (see the rate-limit incident noted above), so this deliberately
     stays a pair rather than the whole list at once. The moment one answers with a playlist the
     rest of that pair is abandoned, and a 429 stops everything exactly as before. */
  for (let i = 0; i < candidates.length; i += 2) {
    const pair = candidates.slice(i, i + 2);
    const results = await Promise.all(pair.map(c => attempt(c, false)));
    const ok = results.find(Boolean);
    if (ok) {
      /* Anything else that answered in the same pair is a body nobody will read. */
      for (const other of results) { if (other && other !== ok) { try { other.body && other.body.cancel(); } catch (e) {} } }
      return ok;
    }
    if (limited) return corsJson(200, { ok: false, status: 429, attempts, base: sig.root, reason: 'rate-limited' });
    if (exhausted()) break;
  }
  /* Pass 2: the same endpoints again, now carrying the device MAC. Only reached when pass 1
     produced nothing, so a working login never spends these requests.
     v19.21: and only for a line whose identity IS the MAC. A login+password line has no business
     re-asking every endpoint as a set-top box — it is a second full sweep of the panel on behalf
     of a device identity the account was never sold with, and it is what turned a plain M3U
     sign-in failure into a MAC verdict. Enforced here as well as in the app, because an app kept
     in a home-screen cache can still be sending the old body. */
  if (mac && !hasCreds && !exhausted()) {
    for (const candidate of candidates) {
      const ok = await attempt(candidate, true);
      if (ok) return ok;
      if (limited) return corsJson(200, { ok: false, status: 429, attempts, base: sig.root, reason: 'rate-limited' });
      if (exhausted()) break;
    }
  }
  /* ── v19.20: THE PANEL IS OFTEN ON ANOTHER PORT. ─────────────────────────────────────────────
     A very common shape, and the one behind the account that kept failing: the hostname a seller
     hands out answers on :80 with a MAG/Ministra portal page and has no get.php on it at all,
     while the Xtream/M3U service for the very same subscription runs on one of the panel ports.
     Nothing is blocking anything there — we were simply knocking on the wrong door and then
     reporting the portal page we found as though it were the answer.

     The ports below are the ones IPTV panels actually use AND that a CDN in front of the host will
     still proxy, so they stay reachable when the hostname is behind one. Bounded hard: only when
     the seller gave no port of their own, only with credentials to try, only the single
     highest-yield candidate shape per port, and only after the normal walk has come up empty
     without being refused — so a working sign-in never spends one of these, and a panel that is
     genuinely refusing us is not knocked on six more times. */
  /* v19.32: the http ports IPTV panels use that a CDN in front of the host still proxies, then the
     https ones. A panel whose hostname is CDN-fronted answers on both schemes, and its get.php is
     as likely to sit behind the https edge as the http one — that is one of the few places a
     playlist can hide from a root that answers 404, which is exactly what this account's root
     does. Two shapes per port, because a panel that gates `output=ts` still serves plain
     `type=m3u_plus`, and asking only one of them is how a working endpoint reads as absent. */
  const PANEL_PORTS_HTTP = ['8080', '2082', '2086', '2095', '8880', '2052'];
  const PANEL_PORTS_HTTPS = ['2053', '2083', '2087', '2096', '8443'];
  /* ── v22.7: SWEEP OTHER PORTS EVEN WHEN THE SELLER GAVE ONE. ─────────────────────────────────
     The gate was `!baseUrl.port`, so the sweep ran ONLY when no port was typed. But the single
     most common shape a seller hands out is `host:8080` as the "portal URL" while the get.php
     playlist actually answers on PORT 80 (or another panel port) — the :8080 they gave is the
     Ministra/portal face, and it has no get.php at all. With a port given, the app tried only that
     port, found nothing, and stopped — reporting "no playlist" on a line that signs in perfectly
     on :80. Now the sweep runs whenever the given port produced nothing (still only after the
     normal walk came up empty WITHOUT being blocked or rejected, so a working sign-in never spends
     it), and it leads with the bare host — PORT 80 — which is exactly where that hidden get.php
     lives. The port the seller typed is skipped in the sweep since the walk above already tried
     it. */
  if (!blocked && !limited && !rejected && hasCreds && !sig.playlist) {
    const u = encodeURIComponent(user), p = encodeURIComponent(pass);
    const q = '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus';
    const given = baseUrl.port || '';
    const spots = [];
    /* port 80 first — the classic "portal on :8080, playlist on :80" case */
    if (given !== '' && given !== '80') spots.push('http://' + baseUrl.hostname);
    for (const port of PANEL_PORTS_HTTP) { if (port !== given) spots.push('http://' + baseUrl.hostname + ':' + port); }
    /* the plain https edge — no port at all — then its panel ports */
    spots.push('https://' + baseUrl.hostname);
    for (const port of PANEL_PORTS_HTTPS) { if (port !== given) spots.push('https://' + baseUrl.hostname + ':' + port); }
    /* v23.2 (owner report: a genuine XC login rate-limited here but signs in fine in other apps):
       spots.length * 2 shapes tops out at 24 requests with NO budget at all — on a panel that never
       explicitly refuses (no 403/429/rejection, just silence or 404 on every wrong door), this ran
       every single one of them before giving up. This app's sign-in goes through ONE shared relay
       (see CORS_RELAYS / SAME_ORIGIN_PROXY in index.html), so every one of these requests lands on
       the provider from the same handful of egress IPs as every OTHER customer signing into that
       same provider through this app — a 24-request sweep is 24 shots at whatever request budget
       the provider allots that shared IP, stacked on top of Pass 1's 10 and whatever the MAG
       handshake still has to spend (that one is load-bearing per CLAUDE.md and is NOT touched
       here). Capped to the highest-yield spots — port 80 and the first few panel ports, already the
       front of this list — rather than exhausting the long tail on a panel that was never going to
       answer on port 2096 anyway. */
    const PORT_SWEEP_BUDGET = 10;
    let sweepSpent = 0;
    outer:
    for (const spot of spots) {
      for (const shape of [q + '&output=ts', q]) {
        if (sweepSpent++ >= PORT_SWEEP_BUDGET) break outer;
        const ok = await attempt(spot + shape, false);
        if (ok) return ok;
        if (limited) return corsJson(200, { ok: false, status: 429, attempts, base: sig.root, reason: 'rate-limited' });
        if (blocked || rejected) break outer;   /* it is answering for itself now — stop guessing */
      }
    }
  }

  if (rejected) return corsJson(200, { ok: false, status: rejected, attempts, base: sig.root, reason: 'rejected' });

  /* ── v22.9 (owner request, reverses v19.6): THE XTREAM API, WHEN get.php IS NOT THERE. ────────
     A very large share of XC panels disable the raw M3U export (get.php 404s, which is exactly
     what playshare.co does on every port) but keep the Xtream API — player_api.php — which is what
     other XC apps read. v19.6 removed that API on purpose to go M3U-only; the owner has now asked
     for it back so that any correct XC login loads regardless of how the panel is configured. It
     is ADDITIVE: it runs only after get.php has produced nothing and nothing was blocked/rejected,
     so a panel that serves get.php never reaches it. Live + VOD are built into an M3U here (series
     needs a per-title episode call that a Worker cannot fan out to safely; it is a follow-up). */
  if (!blocked && !limited && !rejected && hasCreds && !sig.playlist) {
    const api = await tryXtreamApi(env, baseUrl, user, pass, relay, mac, attempts);
    if (api && api.m3u) {
      const headersOut = withCors(new Headers({
        'content-type': 'audio/x-mpegurl; charset=utf-8',
        'cache-control': 'no-store',
        'x-m26-source': api.endpoint,
        'x-m26-endpoint': api.endpoint,
        'x-m26-truncated': '0'
      }));
      headersOut.set('access-control-expose-headers', 'x-m26-source,x-m26-endpoint,x-m26-truncated');
      return new Response(api.m3u, { status: 200, headers: headersOut });
    }
    if (api && api.rejected) return corsJson(200, { ok: false, status: 401, attempts, base: sig.root, reason: 'rejected' });
  }

  /* No playlist endpoint answered. Before giving up, make ONE deliberate probe of the base URL to
     identify what kind of server this actually is. This is a diagnostic, not another playlist
     guess — which is why the bare URL is no longer in the candidate list: fetching it as if it
     might be a playlist is what produced the baffling "the panel answered / with HTTP 200 —
     stalker_portal…". Asked on purpose and read for what it is, the very same response instead
     tells us this is a MAG portal and the app can switch to the MAC handshake. */
  try {
    /* v18.0: take the probe down the route that is still open. Asking from Cloudflare after the
       edge has already refused this worker returns the challenge page every time, so the one
       question this request exists to answer — "is this a MAG portal?" — went unanswered on
       exactly the portals where knowing it matters most. */
    const probeTarget = new URL(baseUrl.origin + '/');
    const probe = (relay.originBlocked && !relay.dead)
      ? await viaRelay(env, probeTarget, false, mac, relay)
      : await fetch(probeTarget.href, {
          method: 'GET',
          headers: { 'user-agent': PLAYER_UA, 'accept': 'text/html,*/*' },
          redirect: 'follow'
        });
    const probeBody = probe ? (await readCapped(probe, 256 * 1024)).text : '';
    if (looksLikeStalkerPortal(probeBody)) sawStalker = true;
    else if (/^\s*(<!doctype\s+html|<html\b)/i.test(probeBody)) {
      attempts.push({
        endpoint: '/ (probe)', status: probe.status, error: 'served a web page, not a playlist',
        got: probeBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      });
    }
  } catch (e) {
    attempts.push({ endpoint: '/ (probe)', error: String((e && e.message) || e).slice(0, 120) });
  }

  /* ── v19.18: A PROVEN REFUSAL OUTRANKS A FINGERPRINT. ────────────────────────────────────────
     sawStalker used to be returned ahead of `blocked`, and that ordering is what put a MAC verdict
     in front of a customer signing in with a username and password on tv.stream4k.cc.

     What actually happened there: every playlist endpoint was refused at the edge (403, before the
     panel's own code ran), and then the diagnostic probe of / reached a page carrying portal
     markup. Those two facts are not equal in weight. The refusal is something we OBSERVED about
     the addresses that matter; the fingerprint is a guess drawn from a page we merely happened to
     be allowed to see, and it says nothing about whether get.php would have answered. Returning it
     as the verdict told the app "this is a MAG portal, sign in by MAC" — so a line with a login, a
     password and a deliberately empty MAC field on the seller's panel was pushed into a MAC
     handshake it can never complete, and reported back in the language of MACs.

     So: if the edge turned us away, that is the finding. The Stalker fingerprint is still returned
     when nothing was blocked — a portal that genuinely answers and genuinely is Ministra. */
  if (sawStalker && !blocked) return corsJson(200, { ok: false, reason: 'stalker-portal', attempts, base: sig.root });
  /* v18.0: both egresses were turned away before the portal answered for itself. Said plainly,
     this is the one verdict the app can act on — it means retry, and it means the MAC handshake
     is still worth trying, not that anybody's details are wrong. */
  /* v19.18: relayRefused says the SECOND egress answered for itself and was turned away too. The
     app used to respond to every edge block by waiting up to 75 seconds for that relay to boot and
     then re-running the whole sign-in, up to three times — which is exactly right when the relay
     was merely asleep, and pure dead time when it was awake and blocked. Only the worker can tell
     those apart, so it says which one happened. */
  if (blocked) return corsJson(200, { ok: false, status: blocked, attempts, base: sig.root, edge: blockedBy, relayRefused: !!relay.refused, reason: 'edge-blocked' });
  return corsJson(200, { ok: false, reason: 'no-playlist', attempts, base: sig.root });
}

function rewriteLocation(location, requestUrl, origin) {
  if (!location) return '';
  const current = new URL(requestUrl);
  try {
    const upstream = new URL(location, origin);
    if (upstream.origin === origin) {
      return `${current.origin}/transcoder${upstream.pathname}${upstream.search}`;
    }
  } catch {}
  if (location.startsWith('/')) return `${current.origin}/transcoder${location}`;
  return location;
}

function rewriteTranscoderProxyM3u8(text, baseUrl, requestUrl, renderOrigin, relaySuffix) {
  const current = new URL(requestUrl);
  const prox = u => {
    try {
      const abs = new URL(u, baseUrl);
      let target = '';
      if ((abs.origin === renderOrigin || abs.origin === current.origin) && abs.pathname === '/proxy') {
        target = abs.searchParams.get('url') || '';
      } else if (abs.origin === current.origin && abs.pathname === '/transcoder/proxy') {
        target = abs.searchParams.get('url') || '';
      }
      if (!target) target = abs.href;
      return current.origin + '/transcoder/proxy?url=' + encodeURIComponent(target) + (relaySuffix || '');
    } catch {
      return u;
    }
  };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + prox(u) + '"');
    return prox(t);
  }).join('\n');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/proxy') {
      return handleProxy(request);
    }
    if (url.pathname === '/api/playlist') {
      return handlePlaylist(request, env);
    }
    if (!url.pathname.startsWith('/transcoder/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors(new Headers()) });
    }

    const origin = await resolveTranscoderOrigin(env);
    const upstreamPath = url.pathname.replace(/^\/transcoder/, '') || '/';

    /* ── v24.62: THE ACTIVATION STORE IS SERVED HERE, NOT UPSTREAM. ────────────────────────────
       server.js turns its whole /api/* surface off unless UPSTASH_REDIS_REST_URL and
       UPSTASH_REDIS_REST_TOKEN are set, and on the live deployment they never have been — so
       "activate the code the customer gave me" answered 503 no matter what was typed. Those
       routes are now answered by a Durable Object the deploy creates itself (licensing.js): no
       keys, no dashboard step, and no cold start on the sign-in path.
       Same URLs and same response shapes, so the app and admin.html need no change. Stripe's two
       routes are NOT in this set — they need secrets only the container holds — and everything
       else under /transcoder/ still proxies exactly as before.
       If the binding is somehow absent the request falls through to the container untouched,
       which is the pre-v24.62 behaviour rather than a new failure. */
    /* A tiny probe the EDGE answers, never the container. The dashboard needs to know whether it
       can activate a customer, and that must not depend on a sleeping free-tier container: with
       the store in the Worker, activation works even while the transcoder is cold. /health keeps
       meaning what it always meant (is the transcoder up, what can it do) and is left alone. */
    if (upstreamPath === '/api/activation-status') {
      /* Really ask the store, rather than only checking that a binding exists. A binding that is
         present but broken would otherwise light the dashboard green and fail every activation
         afterwards — the exact silent failure this whole change exists to end. */
      let live = false;
      /* On a host that FORWARDS to a license home, the only answer that means anything is whether
         that home can be reached — its own binding is irrelevant and reporting it would light the
         dashboard green while every activation 502s. */
      if (!isLicenseHome(env, url)) {
        const home = licenseHome(env);
        try {
          const r = await fetch(home + '/transcoder/api/activation-status', { cf: { cacheTtl: 0 } });
          const hj = r.ok ? await r.json().catch(() => null) : null;
          live = !!(hj && hj.activation);
        } catch (e) { live = false; }
        return new Response(JSON.stringify({
          ok: true, activation: live, store: live ? 'worker' : 'unreachable',
          home, host: url.host, upstream: origin
        }), { status: 200, headers: withCors(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })) });
      }
      if (env.LICENSES) {
        try {
          const probe = await env.LICENSES.get(env.LICENSES.idFromName('v1'))
            .fetch(new Request('https://licenses.internal/api/admin/list', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
            }));
          live = probe.ok;
        } catch (e) { live = false; }
      }
      return new Response(JSON.stringify({
        ok: true,
        activation: live,
        store: live ? 'worker' : 'upstream',
        home: licenseHome(env) || url.origin,
        host: url.host,
        upstream: origin
      }), { status: 200, headers: withCors(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })) });
    }

    /* Not the home host — forward to it, so every deployment shares one set of codes. */
    if (isLicensingPath(upstreamPath) && !isLicenseHome(env, url)) {
      const home = licenseHome(env);
      try {
        const fwd = await fetch(home + '/transcoder' + upstreamPath + url.search, {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
        });
        const hh = withCors(fwd.headers);
        hh.set('x-transcoder-origin', 'worker:licenses@' + (new URL(home)).host);
        hh.delete('content-length');
        hh.delete('content-encoding');
        return new Response(await fwd.text(), { status: fwd.status, headers: hh });
      } catch (e) {
        return new Response(JSON.stringify({
          error: 'The activation store could not be reached. It is hosted at ' + home + '.'
        }), { status: 502, headers: withCors(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })) });
      }
    }

    if (env.LICENSES && isLicensingPath(upstreamPath)) {
      const stub = env.LICENSES.get(env.LICENSES.idFromName('v1'));
      const inner = new Request('https://licenses.internal' + upstreamPath, {
        method: request.method,
        headers: { 'content-type': 'application/json', 'x-upstream-origin': origin },
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
      });
      const out = await stub.fetch(inner);
      const h = withCors(out.headers);
      h.set('x-transcoder-origin', 'worker:licenses');
      return new Response(out.body, { status: out.status, headers: h });
    }
    const upstreamUrl = new URL(upstreamPath + url.search, origin);
    const headers = new Headers(request.headers);
    headers.delete('host');

    /* v18.1: answer a cold transcoder with a PROPER 504, not an unhandled throw. The service sleeps
       on a free plan, and a subrequest to a container that is still booting can time out or be
       refused — which used to escape this handler and become the runtime's own error page: no CORS
       headers, so the player's poll saw a rejected fetch rather than a status it could reason
       about. A clean CORS 504 is the signal the player now waits on (see stillWaking in
       m26player2.js), so a channel that only needs the service to finish waking plays instead of
       reporting a gateway number to the customer. */
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual'
      });
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'Transcoder is starting up',
        origin,
        detail: String((e && e.message) || e).slice(0, 200)
      }), { status: 504, headers: withCors(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-transcoder-origin': origin })) });
    }

    /* The container reports activation:false whenever it has no Upstash keys — true of this
       deployment and irrelevant now that the Worker holds the store. Correct that one field so
       every screen reading /health sees the truth; nothing else in the body is touched. */
    if (env.LICENSES && upstreamPath === '/health' && upstreamResponse.ok) {
      const j = await upstreamResponse.clone().json().catch(() => null);
      if (j && typeof j === 'object') {
        j.activation = true;
        j.activationStore = 'worker';
        const hh = withCors(upstreamResponse.headers);
        hh.set('content-type', 'application/json; charset=utf-8');
        hh.set('x-transcoder-origin', origin);
        hh.delete('content-length');
        hh.delete('content-encoding');
        return new Response(JSON.stringify(j), { status: upstreamResponse.status, headers: hh });
      }
    }

    const responseHeaders = withCors(upstreamResponse.headers);
    /* v24.61: SAY WHICH SERVICE ANSWERED. The origin behind /transcoder is whatever
       TRANSCODER_ORIGIN is set to (this deployment points at Railway, not Render) or whichever
       candidate answered a probe — so nothing downstream could know which host to go and
       configure, and the admin dashboard was left telling people to fix "Render" whether or not
       Render was involved. Stamping the resolved origin on the response lets that screen name the
       real host instead of guessing. */
    responseHeaders.set('x-transcoder-origin', origin);
    const location = rewriteLocation(responseHeaders.get('location'), request.url, origin);
    if (location) responseHeaders.set('location', location);

    /* v19.72: Render 13.5 can fetch the MAG playlist as the registered STB, but its HLS playlist
       rewrite drops stb/mac/token on the child segment URLs. Until Render is redeployed to 13.7,
       repair those playlist bodies at the Worker edge so FFmpeg keeps the MAC identity for every
       variant, segment and key request. */
    if (request.method === 'GET' && upstreamResponse.ok && upstreamPath === '/proxy' && url.searchParams.get('stb') === '1') {
      const raw = url.searchParams.get('url') || '';
      const ct = (upstreamResponse.headers.get('content-type') || '').toLowerCase();
      if (/mpegurl|m3u8/.test(ct) || /\.m3u8(?:$|\?)/i.test(raw)) {
        const text = await upstreamResponse.text();
        if (/#EXTM3U/.test(text)) {
          const mac = url.searchParams.get('mac') || '';
          const token = (url.searchParams.get('token') || '').trim();
          const relaySuffix = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(mac)
            ? '&stb=1&mac=' + encodeURIComponent(mac.toUpperCase()) + (token && /^[\w.\-]{1,256}$/.test(token) ? '&token=' + encodeURIComponent(token) : '') + (url.searchParams.get('ua') === 'browser' ? '&ua=browser' : '')
            : '';
          responseHeaders.delete('content-length');
          responseHeaders.delete('content-encoding');
          responseHeaders.set('content-type', 'application/vnd.apple.mpegurl');
          responseHeaders.set('cache-control', 'no-store');
          return new Response(rewriteTranscoderProxyM3u8(text, upstreamResponse.url || upstreamUrl.href, request.url, origin, relaySuffix), {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: responseHeaders
          });
        }
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        return new Response(text, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: responseHeaders
        });
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  }
};
