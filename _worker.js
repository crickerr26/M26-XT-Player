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
  headers.set('user-agent', request.headers.get('user-agent') || 'Mozilla/5.0');
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
  const qs = new URL(request.url).searchParams;
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
