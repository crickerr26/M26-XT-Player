const TRANSCODER_ORIGIN = 'https://smarter-iptv-transcoder.onrender.com';

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
  let upstream;
  try {
    upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
  } catch (e) {
    return corsJson(502, { error: 'Upstream fetch failed: ' + ((e && e.message) || e) });
  }
  const responseHeaders = withCors(upstream.headers);
  responseHeaders.delete('set-cookie');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

function rewriteLocation(location, requestUrl) {
  if (!location) return '';
  const current = new URL(requestUrl);
  try {
    const upstream = new URL(location, TRANSCODER_ORIGIN);
    if (upstream.origin === TRANSCODER_ORIGIN) {
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

    const upstreamPath = url.pathname.replace(/^\/transcoder/, '') || '/';
    const upstreamUrl = new URL(upstreamPath + url.search, TRANSCODER_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('host');

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    });

    const responseHeaders = withCors(upstreamResponse.headers);
    const location = rewriteLocation(responseHeaders.get('location'), request.url);
    if (location) responseHeaders.set('location', location);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  }
};
