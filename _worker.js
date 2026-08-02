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
  /* v13.8: ask the panel as a PLAYER, not as a browser. Xtream panels routinely refuse a generic
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
    headers.set('user-agent', 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3');
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

function playlistCandidates(base, user, pass, variant) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return [];
  const u = encodeURIComponent(user || ''), p = encodeURIComponent(pass || '');
  /* A direct .m3u/.m3u8 link pasted as the portal URL is already the playlist. */
  if (/\.(m3u8?)(\?|$)/i.test(b)) return [b];
  if (!user) return [b];
  /* v13.8: the FULL-CATALOGUE variant, asked for separately and only once the user is already
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
  ];
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

async function handlePlaylist(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors(new Headers()) });
  }
  if (request.method !== 'POST') {
    return corsJson(405, { error: 'Use POST with {url, username, password}' });
  }
  let body = {};
  try { body = await request.json(); } catch { return corsJson(400, { error: 'Invalid JSON body' }); }

  const rawBase = String(body.url || '').trim();
  if (!rawBase) return corsJson(400, { error: 'Missing portal url' });
  /* Accept a bare host ("tv.example.com") the same way the app's own normalise() does. */
  const withScheme = /^https?:\/\//i.test(rawBase) ? rawBase : 'http://' + rawBase;
  let baseUrl;
  try { baseUrl = new URL(withScheme); } catch { return corsJson(400, { error: 'Invalid portal url' }); }
  if (!/^https?:$/.test(baseUrl.protocol)) return corsJson(400, { error: 'Portal url must be http or https' });
  if (PRIVATE_HOST.test(baseUrl.hostname)) return corsJson(403, { error: 'Target host not allowed' });

  const variant = String(body.variant || '').trim().toLowerCase();
  const candidates = playlistCandidates(withScheme.replace(/\/+$/, ''), body.username, body.password, variant);
  const attempts = [];

  for (const candidate of candidates) {
    let target;
    try { target = new URL(candidate); } catch { continue; }
    if (PRIVATE_HOST.test(target.hostname)) continue;   /* a redirect target could differ from base */
    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: 'GET',
        headers: { 'user-agent': PLAYER_UA, 'accept': '*/*' },
        redirect: 'follow'
      });
    } catch (e) {
      attempts.push({ endpoint: target.pathname + (target.search ? '?…' : ''), error: String((e && e.message) || e).slice(0, 120) });
      continue;
    }
    if (!upstream.ok) {
      attempts.push({ endpoint: target.pathname + (target.search ? '?…' : ''), status: upstream.status });
      /* A rate-limit or auth rejection is the panel's final answer — walking the remaining
         candidates just spends more requests against the same limit. */
      if (upstream.status === 429 || upstream.status === 401 || upstream.status === 403) {
        return corsJson(200, { ok: false, status: upstream.status, attempts, reason: upstream.status === 429 ? 'rate-limited' : 'rejected' });
      }
      continue;
    }
    let text = '', truncated = false;
    try {
      const read = await readCapped(upstream, MAX_PLAYLIST_BYTES);
      text = read.text; truncated = read.truncated;
    } catch (e) {
      attempts.push({ endpoint: target.pathname + (target.search ? '?…' : ''), error: 'read failed: ' + String((e && e.message) || e).slice(0, 80) });
      continue;
    }
    if (!looksLikePlaylist(text)) {
      /* A Stalker portal is a definite, recognisable answer — stop and say so, rather than
         spending the remaining candidates (and the panel's rate limit) on endpoints that this
         product does not implement. */
      if (looksLikeStalkerPortal(text)) {
        return corsJson(200, { ok: false, reason: 'stalker-portal', attempts });
      }
      /* Report WHAT came back instead of just "not a playlist" — an HTML challenge page, a login
         form or a panel error message are all diagnosable, and all look identical without this. */
      attempts.push({
        endpoint: target.pathname + (target.search ? '?…' : ''),
        status: upstream.status,
        error: 'not an M3U playlist',
        got: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      });
      continue;
    }
    const headers = withCors(new Headers({
      'content-type': 'audio/x-mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'x-m26-source': target.origin + target.pathname,
      'x-m26-truncated': truncated ? '1' : '0'
    }));
    headers.set('access-control-expose-headers', 'x-m26-source,x-m26-truncated');
    return new Response(text, { status: 200, headers });
  }

  /* No playlist endpoint answered. Before giving up, make ONE deliberate probe of the base URL to
     identify what kind of server this actually is. This is a diagnostic, not another playlist
     guess — which is why the bare URL is no longer in the candidate list: fetching it as if it
     might be a playlist is what produced the baffling "the panel answered / with HTTP 200 —
     stalker_portal…". Asked on purpose and read for what it is, the very same response instead
     tells us this is a MAG portal and the app can switch to the MAC handshake. */
  try {
    const probe = await fetch(baseUrl.origin + '/', {
      method: 'GET',
      headers: { 'user-agent': PLAYER_UA, 'accept': 'text/html,*/*' },
      redirect: 'follow'
    });
    const body = (await readCapped(probe, 256 * 1024)).text;
    if (looksLikeStalkerPortal(body)) {
      return corsJson(200, { ok: false, reason: 'stalker-portal', attempts });
    }
    if (/^\s*(<!doctype\s+html|<html\b)/i.test(body)) {
      attempts.push({
        endpoint: '/ (probe)', status: probe.status, error: 'served a web page, not a playlist',
        got: body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      });
    }
  } catch (e) {
    attempts.push({ endpoint: '/ (probe)', error: String((e && e.message) || e).slice(0, 120) });
  }

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
      return handlePlaylist(request);
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

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    });

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
