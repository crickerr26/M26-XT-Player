/* The ONE Render service behind /transcoder: it both transcodes and holds the Upstash
   activation store. It must be the same service the admin dashboard writes codes to, and the
   same one that auto-deploys from this repo — when those drifted apart, customer codes came
   back unknown and MKV kept hitting a server that never received the HEVC fix.
   Override without a code change by setting a TRANSCODER_ORIGIN variable on the Worker/Pages
   project, so moving to a new Render service is a dashboard edit, not a redeploy of this file. */
const DEFAULT_TRANSCODER_ORIGIN = 'https://media26-transcoder-xutt.onrender.com';
function transcoderOrigin(env) {
  try {
    const v = String((env && env.TRANSCODER_ORIGIN) || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(v)) return v;
  } catch (e) {}
  return DEFAULT_TRANSCODER_ORIGIN;
}

function withCors(headers) {
  const out = new Headers(headers);
  out.set('access-control-allow-origin', '*');
  out.set('access-control-allow-methods', 'GET,HEAD,POST,OPTIONS');
  out.set('access-control-allow-headers', 'accept,content-type,range,authorization,x-admin-key');
  out.set('access-control-expose-headers', 'content-length,content-range,accept-ranges,content-type,location');
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
function rewriteM3u8(text, baseUrl, selfOrigin) {
  const prox = u => {
    try { return selfOrigin + '/proxy?url=' + encodeURIComponent(new URL(u, baseUrl).href); }
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
    if (uaMode !== 'browser') {
      headers.set('user-agent', 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3');
    } else {
      headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15');
      headers.set('accept-language', 'en-US,en;q=0.9');
    }
    headers.set('x-user-agent', 'Model: MAG250; Link: WiFi');
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
      return new Response(rewriteM3u8(text, upstream.url || target.href, origin), {
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

/* v15.0: PLAYLIST BY MAC ADDRESS. This is the flow the app is built around — the app shows a MAC,
   the reseller binds a line to it, and from then on the portal hands that MAC its own M3U, with no
   username or password anywhere in the picture. Panels differ in where they expose it and in
   whether they want the MAC with or without colons, so both shapes are tried, most common first. */
function macPlaylistCandidates(base, mac) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b || !mac) return [];
  const enc = encodeURIComponent(mac);         // 00%3A1A%3A79%3A45%3AFD%3AAD
  const flat = mac.replace(/:/g, '');          // 001A7945FDAD
  return [
    b + '/get.php?mac=' + enc + '&type=m3u_plus&output=ts',
    b + '/get.php?mac=' + enc + '&type=m3u_plus',
    b + '/get.php?username=' + enc + '&password=' + enc + '&type=m3u_plus&output=ts',
    b + '/get.php?mac=' + enc + '&type=m3u',
    b + '/playlist/' + enc + '/m3u_plus',
    b + '/play/get.php?mac=' + enc + '&type=m3u_plus',
    b + '/get.php?mac=' + flat + '&type=m3u_plus',
    b + '/get.php?username=' + flat + '&password=' + flat + '&type=m3u_plus',
    b + '/get.php?mac=' + enc
  ];
}
function playlistCandidates(base, user, pass, variant, mac) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return [];
  const u = encodeURIComponent(user || ''), p = encodeURIComponent(pass || '');
  /* A direct .m3u/.m3u8 link pasted as the portal URL is already the playlist. */
  if (/\.(m3u8?)(\?|$)/i.test(b)) return [b];
  /* No username at all: the MAC IS the identity.
     v19.1.0: this returned before the variant==='full' branch below ever ran, so a MAC-only line
     asking for the FULL catalogue was handed the same candidate list as the login — led by the
     compact `output=ts` document it already had. The follow-up request therefore re-fetched the
     document that was short in the first place, merged nothing, and Movies/Series stayed exactly
     as they were. v18.3 fixed the client-side guard for MAC lines (fullPlaylistCatalog) but this
     side still discarded the variant, which is why that fix did not show up for them. */
  if (!user) {
    if (!mac) return [b];
    const macList = macPlaylistCandidates(b, mac);
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
    return [
      b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus',
      b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=m3u8',
      b + '/get.php?username=' + u + '&password=' + p + '&type=m3u',
      b + '/playlist/' + u + '/' + p + '/m3u_plus'
    ];
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
  return [
    b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=ts',
    b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus',
    b + '/get.php?username=' + u + '&password=' + p + '&type=m3u',
    b + '/playlist/' + u + '/' + p + '/m3u_plus',
    b + '/get.php?username=' + u + '&password=' + p
  ].concat(macPlaylistCandidates(b, mac));
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

async function viaRelay(env, target, useMac, mac, state) {
  const st = state || {};
  if (st.dead) return null;                       /* already established it is not coming up */
  const base = transcoderOrigin(env);
  if (!/^https?:\/\//i.test(base)) { st.dead = true; return null; }
  let relay = base.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(target.href);
  if (useMac && mac) relay += '&stb=1&mac=' + encodeURIComponent(mac);
  const headers = { 'user-agent': useMac ? MAG_UA : PLAYER_UA, 'accept': '*/*' };
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

  /* v14.3: THE DEVICE MAC, sent with the username and password.
     The product flow is: the app shows a MAC, the reseller creates the line in their panel BOUND
     to that MAC, and the customer then signs in with a username and password. A MAC-locked line
     refuses a request that carries no MAC, and until now the playlist login sent none at all —
     so the one flow the app is built around could not complete. Panels implement the check two
     ways, so both are sent together on the MAC pass: `&mac=` on the query string, and the MAG
     `mac=` cookie with a set-top-box User-Agent. Strictly validated, never forwarded verbatim. */
  /* Which of the two products this is being asked on behalf of: a line with a username and
     password is authorised by those, a line without one is authorised by its MAC. */
  const hasCreds = !!String(body.username || '').trim();
  const variant = String(body.variant || '').trim().toLowerCase();
  const candidates = playlistCandidates(withScheme.replace(/\/+$/, ''), body.username, body.password, variant, mac);
  const attempts = [];
  let sawStalker = false, rejected = 0, limited = 0, blocked = 0;
  /* Shared across every candidate in this login: whether the portal's edge has already turned this
     worker away, and what state the second egress is in. */
  const relay = { awake: false, dead: false, originBlocked: false, spent: 0, exhausted: false };
  wakeRelay(env, relay);

  /* Stop walking candidates when there is provably nothing left to learn from another request:
     the portal's edge has refused this worker AND the relay is not coming up (so every remaining
     candidate would fetch the same challenge page), or the relay's candidate budget is spent. In
     both cases the next useful step is the diagnostic probe, not twenty-odd more knocks — and
     those knocks are what push a portal that was merely throttling into refusing outright. */
  const exhausted = () => relay.exhausted || (relay.originBlocked && relay.dead);

  const label = (target, useMac) =>
    target.pathname + (target.search ? '?…' : '') + (useMac ? ' +stb' : (mac ? ' +mac' : ''));

  /* Read and validate whatever answered — the portal directly or the relay standing in for it.
     Split out so both routes through attempt() judge the body by exactly the same rules. */
  const finish = async (upstream, target, useMac) => {
    let text = '', truncated = false;
    try {
      const read = await readCapped(upstream, MAX_PLAYLIST_BYTES);
      text = read.text; truncated = read.truncated;
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
      /* Report WHAT came back instead of just "not a playlist" — an HTML challenge page, a login
         form or a panel error message are all diagnosable, and all look identical without this. */
      attempts.push({
        endpoint: label(target, useMac),
        status: upstream.status,
        error: 'not an M3U playlist',
        got: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      });
      return null;
    }
    const headersOut = withCors(new Headers({
      'content-type': 'audio/x-mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'x-m26-source': target.origin + target.pathname,
      'x-m26-truncated': truncated ? '1' : '0'
    }));
    headersOut.set('access-control-expose-headers', 'x-m26-source,x-m26-truncated');
    return new Response(text, { status: 200, headers: headersOut });
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
    const headers = { 'user-agent': useMac ? MAG_UA : PLAYER_UA, 'accept': '*/*' };
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
    /* v15.3: SECOND EGRESS. A 403/429/503 here is very often not the panel refusing the account
       but the panel's EDGE refusing where the request came from — this worker runs on Cloudflare,
       and a portal behind Cloudflare routinely blocks that on the very first request, which is
       why waiting never clears it. The transcoder service runs on ordinary hosting with entirely
       different IPs and already relays these exact requests (server.js /proxy, MAG headers and
       all), so the same attempt is simply a different visitor. Retry there before giving up. */
    if (edgeRefused(upstream.status)) {
      relay.originBlocked = true;
      const relayed = await viaRelay(env, target, useMac, mac, relay);
      if (relayed && relayed.ok) {
        attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: 'edge refused; succeeded via relay' });
        upstream = relayed;
      } else {
        attempts.push({ endpoint: label(target, useMac), status: upstream.status, note: relayed ? 'relay also ' + relayed.status : 'relay unreachable' });
        /* v18.0: THIS IS NOT A REJECTION OF THE ACCOUNT. A 403 or 503 from an edge means the
           portal's own code never saw the request, so it can have had no opinion about the
           username, the password or the MAC — and reporting it as `rejected` is what put "check
           the username and password" in front of customers whose details were exactly right.
           Only the portal answering for itself (below) can reject credentials. A 429 keeps its
           own reason because "wait, it is throttling" is both true and more specific. */
        if (upstream.status === 429) limited = 429;
        else blocked = upstream.status;
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
  for (const candidate of candidates) {
    const ok = await attempt(candidate, false);
    if (ok) return ok;
    if (limited) return corsJson(200, { ok: false, status: 429, attempts, reason: 'rate-limited' });
    if (exhausted()) break;
  }
  /* Pass 2: the same endpoints again, now carrying the device MAC. Only reached when pass 1
     produced nothing, so a working login never spends these requests. */
  if (mac && !exhausted()) {
    for (const candidate of candidates) {
      const ok = await attempt(candidate, true);
      if (ok) return ok;
      if (limited) return corsJson(200, { ok: false, status: 429, attempts, reason: 'rate-limited' });
      if (exhausted()) break;
    }
  }
  if (rejected) return corsJson(200, { ok: false, status: rejected, attempts, reason: 'rejected' });

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

  if (sawStalker) return corsJson(200, { ok: false, reason: 'stalker-portal', attempts });
  /* v18.0: both egresses were turned away before the portal answered for itself. Said plainly,
     this is the one verdict the app can act on — it means retry, and it means the MAC handshake
     is still worth trying, not that anybody's details are wrong. */
  if (blocked) return corsJson(200, { ok: false, status: blocked, attempts, reason: 'edge-blocked' });
  return corsJson(200, { ok: false, reason: 'no-playlist', attempts });
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

    const origin = transcoderOrigin(env);
    const upstreamPath = url.pathname.replace(/^\/transcoder/, '') || '/';
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
        detail: String((e && e.message) || e).slice(0, 200)
      }), { status: 504, headers: withCors(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })) });
    }

    const responseHeaders = withCors(upstreamResponse.headers);
    const location = rewriteLocation(responseHeaders.get('location'), request.url, origin);
    if (location) responseHeaders.set('location', location);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  }
};
