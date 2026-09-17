/* worker-compat.js — Node port of the parts of _worker.js needed once the app runs entirely on
   Railway (no Cloudflare Worker in front of it any more). Ported near-verbatim: this file uses
   only Web-standard APIs (fetch, Request, Response, Headers, ReadableStream) which Node 18+
   provides globally, so the original Cloudflare-Worker logic runs here almost unchanged. The
   Durable-Object-backed licensing store from the Worker is NOT ported — this server already has
   its own working activation-code store (Upstash-backed, see server.js), so /api/playlist is the
   only route pulled in here. /proxy stays server.js's own existing implementation.
   Kept in step with _worker.js's /api/playlist logic — see CLAUDE.md's note on keeping the two
   proxy implementations in sync; the same now applies to this file. */

const PRIVATE_HOST = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1?\]|\[f[cd])/i;

const PLAYER_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const MAG_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
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

function withCors(headers) {
  const out = new Headers(headers);
  out.set('access-control-allow-origin', '*');
  out.set('access-control-allow-methods', 'GET,HEAD,POST,OPTIONS');
  out.set('access-control-allow-headers', 'accept,content-type,range,authorization,x-admin-key');
  out.set('access-control-expose-headers', 'content-length,content-range,accept-ranges,content-type,location,retry-after,x-transcoder-origin');
  out.set('cross-origin-resource-policy', 'cross-origin');
  out.set('timing-allow-origin', '*');
  return out;
}

function corsJson(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCors(new Headers({ 'content-type': 'application/json' }))
  });
}

function transcoderOrigin(env) {
  return (env && env.TRANSCODER_ORIGIN) || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function relayWaking(status) { return !status || status === 502 || status === 503 || status === 504; }
const RELAY_WAKE_BACKOFF_MS = [0, 3000, 6000, 9000, 12000, 15000];
const RELAY_CANDIDATE_BUDGET = 6;

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
  if (st.dead) return null;
  const base = transcoderOrigin(env);
  if (!/^https?:\/\//i.test(base)) { st.dead = true; return null; }
  let relay = base.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(target.href);
  if (useMac && mac) relay += '&stb=1&mac=' + encodeURIComponent(mac);
  if (!useMac && st.originBlocked) relay += '&ua=browser';
  const headers = useMac
    ? { 'user-agent': MAG_UA, 'accept': '*/*' }
    : (st.originBlocked ? browserHeaders() : { 'user-agent': PLAYER_UA, 'accept': '*/*' });
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
  if (truncated) out = out.slice(0, out.lastIndexOf('\n') + 1 || out.length);
  return { text: out, truncated };
}

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

function macPlaylistCandidates(bases, mac) {
  if (!mac) return [];
  const enc = encodeURIComponent(mac);
  const flat = mac.replace(/:/g, '');
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
  if (sig.playlist) return [sig.playlist];
  const bases = sig.root === sig.typed ? [sig.root] : [sig.root, sig.typed];
  if (!bases[0]) return [];
  const u = encodeURIComponent(user || ''), p = encodeURIComponent(pass || '');
  const out = [];
  const add = x => { if (x && out.indexOf(x) < 0) out.push(x); };
  if (!user) {
    if (!mac) return [bases[0]];
    const macList = macPlaylistCandidates(bases, mac);
    if (variant === 'full') {
      const full = macList.filter(x => !/[?&]output=ts(&|$)/i.test(x));
      return full.length ? full : macList;
    }
    return macList;
  }
  if (variant === 'full') {
    for (const b of bases) {
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus');
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=m3u8');
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u');
      add(b + '/playlist/' + u + '/' + p + '/m3u_plus');
    }
    return out;
  }
  for (const b of bases) {
    add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=ts');
    add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus');
    add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u');
    add(b + '/playlist/' + u + '/' + p + '/m3u_plus');
    add(b + '/get.php?username=' + u + '&password=' + p);
  }
  return out;
}

function looksLikePlaylist(text) {
  const head = String(text || '').slice(0, 4096);
  return /^\s*#EXTM3U/i.test(head) || /#EXTINF/i.test(head);
}

function looksLikeStalkerPortal(text) {
  const head = String(text || '').slice(0, 20000);
  return /stalker_portal|\bvar\s+gmode\b|\bresolution_prefix\b|\/c\/version\.js|ministra/i.test(head);
}

function edgeRefused(status) {
  return status === 403 || status === 429 || status === 503;
}

function looksLikeChallenge(text) {
  const head = String(text || '').slice(0, 4096);
  return /just a moment|checking your browser|cf-browser-verification|__cf_chl|cf-chl-|cf_chl_opt|attention required|ddos protection by|enable javascript and cookies|please turn javascript on|_cf_chl_|challenge-platform/i.test(head);
}

function edgeName(response) {
  try {
    const server = String(response.headers.get('server') || '').toLowerCase();
    if (response.headers.get('cf-ray') || server === 'cloudflare') return 'cloudflare';
    if (server) return server.slice(0, 40);
  } catch (e) {}
  return '';
}

async function xtreamGet(base, user, pass, action, env, relay) {
  const u = encodeURIComponent(user), p = encodeURIComponent(pass);
  const url = base + '/player_api.php?username=' + u + '&password=' + p + (action ? '&action=' + action : '');
  let r = null;
  try {
    r = await fetch(url, { headers: { 'user-agent': PLAYER_UA, 'accept': 'application/json,*/*' }, redirect: 'follow' });
  } catch (e) { return null; }
  let text = '';
  try { text = r ? await r.text() : ''; } catch (e) { return null; }
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
    if (!info || !info.user_info) continue;
    const ui = info.user_info;
    if (ui.auth === 0 || /disabled|expired|banned/i.test(String(ui.status || ''))) {
      attempts.push({ endpoint: base + '/player_api.php', error: 'account not active (' + (ui.status || 'auth 0') + ')' });
      return { rejected: true };
    }
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

async function handlePlaylist(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors(new Headers()) });
  }
  if (request.method !== 'POST') {
    return corsJson(405, { error: 'Use POST with {url, username, password}' });
  }
  let body = {};
  try { body = await request.json(); } catch (e) { return corsJson(400, { error: 'Invalid JSON body' }); }

  const macHex = String(body.mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const mac = macHex.length === 12 ? macHex.match(/../g).join(':') : '';

  const rawBase = String(body.url || '').trim();
  if (!rawBase) return corsJson(400, { error: 'Missing portal url' });
  const withScheme = /^https?:\/\//i.test(rawBase) ? rawBase : 'http://' + rawBase;
  let baseUrl;
  try { baseUrl = new URL(withScheme); } catch (e) { return corsJson(400, { error: 'Invalid portal url' }); }
  if (!/^https?:$/.test(baseUrl.protocol)) return corsJson(400, { error: 'Portal url must be http or https' });
  if (PRIVATE_HOST.test(baseUrl.hostname)) return corsJson(403, { error: 'Target host not allowed' });
  const sig = parseSignIn(withScheme);
  if (!sig.root) return corsJson(400, { error: 'Invalid portal url' });

  const user = String(body.username || '').trim() || sig.username;
  const pass = (body.password != null && String(body.password) !== '') ? String(body.password) : sig.password;
  const hasCreds = !!user;
  const variant = String(body.variant || '').trim().toLowerCase();
  let candidates = playlistCandidates(sig, user, pass, variant, mac);
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
  const relay = { awake: false, dead: false, originBlocked: false, spent: 0, exhausted: false, uaTried: false, useBrowserUa: false, refused: false, sawChallenge: false };
  wakeRelay(env, relay);

  const exhausted = () => relay.exhausted || (relay.originBlocked && relay.dead);

  const label = (target, useMac) =>
    target.origin + target.pathname + (target.search ? '?…' : '') + (useMac ? ' +stb' : (mac ? ' +mac' : ''));

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
      if (looksLikeStalkerPortal(text)) { sawStalker = true; return null; }
      if (looksLikeChallenge(text)) relay.sawChallenge = true;
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
    if (!rest) return new Response(head || text, { status: 200, headers: headersOut });
    const respBody = new ReadableStream({
      start(controller) { controller.enqueue(head); },
      async pull(controller) {
        const { done, value } = await rest.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      },
      cancel(reason) { try { rest.cancel(reason); } catch (e) {} }
    });
    return new Response(respBody, { status: 200, headers: headersOut });
  };

  const attempt = async (candidate, useMac) => {
    let target;
    try { target = new URL(candidate); } catch (e) { return null; }
    if (PRIVATE_HOST.test(target.hostname)) return null;
    if (mac && (useMac || !hasCreds)) target.searchParams.set('mac', mac);
    const headers = useMac
      ? { 'user-agent': MAG_UA, 'accept': '*/*' }
      : (relay.useBrowserUa ? browserHeaders() : { 'user-agent': PLAYER_UA, 'accept': '*/*' });
    if (useMac) headers.cookie = 'mac=' + mac + '; stb_lang=en; timezone=UTC';
    let upstream;
    if (relay.originBlocked && !relay.dead) {
      if (relay.spent >= RELAY_CANDIDATE_BUDGET) { relay.exhausted = true; return null; }
      relay.spent++;
      upstream = await viaRelay(env, target, useMac, mac, relay);
      if (!upstream || !upstream.ok) {
        attempts.push({ endpoint: label(target, useMac), status: (upstream && upstream.status) || 0, note: 'via relay' });
        if (upstream && upstream.status === 429) limited = 429;
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
    if (edgeRefused(upstream.status)) {
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
        if (upstream.status === 429) limited = 429;
        else { blocked = upstream.status; blockedBy = blockedBy || edgeName(upstream); }
        return null;
      }
    } else if (!upstream.ok) {
      attempts.push({ endpoint: label(target, useMac), status: upstream.status });
      if (upstream.status === 429) limited = 429;
      else if (upstream.status === 401 || upstream.status === 403) rejected = upstream.status;
      return null;
    }
    return await finish(upstream, target, useMac);
  };

  for (let i = 0; i < candidates.length; i += 2) {
    const pair = candidates.slice(i, i + 2);
    const results = await Promise.all(pair.map(c => attempt(c, false)));
    const ok = results.find(Boolean);
    if (ok) {
      for (const other of results) { if (other && other !== ok) { try { other.body && other.body.cancel(); } catch (e) {} } }
      return ok;
    }
    if (limited) return corsJson(200, { ok: false, status: 429, attempts, base: sig.root, reason: 'rate-limited' });
    if (exhausted()) break;
  }
  if (mac && !hasCreds && !exhausted()) {
    for (const candidate of candidates) {
      const ok = await attempt(candidate, true);
      if (ok) return ok;
      if (limited) return corsJson(200, { ok: false, status: 429, attempts, base: sig.root, reason: 'rate-limited' });
      if (exhausted()) break;
    }
  }
  const PANEL_PORTS_HTTP = ['8080', '2082', '2086', '2095', '8880', '2052'];
  const PANEL_PORTS_HTTPS = ['2053', '2083', '2087', '2096', '8443'];
  if (!blocked && !limited && !rejected && hasCreds && !sig.playlist) {
    const u = encodeURIComponent(user), p = encodeURIComponent(pass);
    const q = '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus';
    const given = baseUrl.port || '';
    const spots = [];
    if (given !== '' && given !== '80') spots.push('http://' + baseUrl.hostname);
    for (const port of PANEL_PORTS_HTTP) { if (port !== given) spots.push('http://' + baseUrl.hostname + ':' + port); }
    spots.push('https://' + baseUrl.hostname);
    for (const port of PANEL_PORTS_HTTPS) { if (port !== given) spots.push('https://' + baseUrl.hostname + ':' + port); }
    const PORT_SWEEP_BUDGET = 10;
    let sweepSpent = 0;
    outer:
    for (const spot of spots) {
      for (const shape of [q + '&output=ts', q]) {
        if (sweepSpent++ >= PORT_SWEEP_BUDGET) break outer;
        const ok = await attempt(spot + shape, false);
        if (ok) return ok;
        if (limited) return corsJson(200, { ok: false, status: 429, attempts, base: sig.root, reason: 'rate-limited' });
        if (blocked || rejected) break outer;
      }
    }
  }

  if (rejected) return corsJson(200, { ok: false, status: rejected, attempts, base: sig.root, reason: 'rejected' });

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

  try {
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

  if (sawStalker && !blocked) return corsJson(200, { ok: false, reason: 'stalker-portal', attempts, base: sig.root });
  if (blocked) return corsJson(200, { ok: false, status: blocked, attempts, base: sig.root, edge: blockedBy, relayRefused: !!relay.refused, reason: 'edge-blocked' });
  return corsJson(200, { ok: false, reason: 'no-playlist', attempts, base: sig.root });
}

module.exports = { handlePlaylist };
