/* Media26 portal connector.
 *
 * Not every IPTV service speaks Xtream Codes. The three that matter in practice:
 *
 *   1. XTREAM CODES   player_api.php?username=&password=  -> JSON categories + streams.
 *   2. M3U PLAYLIST   get.php?username=&password=&type=m3u_plus, or any .m3u/.m3u8 URL.
 *                     One text file listing every channel. This is what most panels that
 *                     "aren't Xtream" actually serve, including resellers of the same panel.
 *   3. STALKER/MINISTRA  the MAG portal that Smart STB, Eagle, Star and Smart4K emulate.
 *                     Identity is a MAC ADDRESS, not a username: the seller authorises the MAC
 *                     and the box asks the portal for a token, then resolves each channel to a
 *                     one-shot stream URL. Endpoints live under /portal.php or
 *                     /stalker_portal/server/load.php.
 *
 * This module normalises all of them into the shape the app already renders, so the player,
 * favourites, categories and search need no knowledge of where a channel came from.
 */
(function (global) {
  'use strict';

  /* ── M3U ──────────────────────────────────────────────────────────────────────────────────── */

  function attrs(line) {
    const out = {};
    const re = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(line))) out[m[1].toLowerCase()] = m[2];
    return out;
  }

  function extOf(url) {
    const m = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /* Which tab a playlist entry belongs in. The URL path is decisive when a panel uses the usual
     /live/ /movie/ /series/ layout; otherwise fall back to what the group is called, and treat
     anything with a file extension that is not a live container as on-demand. */
  /* SxxExx / 1x03 / "Season 2" in a TITLE means an episode even when the group says nothing —
     plenty of playlists dump series into generic groups, and without this they all landed in
     Live TV. Checked against the name only, never the URL (stream ids contain bare digits). */
  const EPISODE_RE = /(^|[\s\-–_.\[(])(s\s?\d{1,2}\s?[ex]\s?\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d+|episode\s*\d+)([\s\-–_.\])]|$)/i;

  /* Group-title keywords, kept as named constants because they are the ONLY signal for the many
     panels whose playlist URLs carry no /movie/ or /series/ path segment and no file extension.
     Written without \b on the non-English stems so they still match inside "PELICULAS|ACCION",
     "FILMES - LANCAMENTOS", "SERIES EN ESPANOL" and the other run-together group names panels use. */
  const GROUP_SERIES_RE = /\bseries\b|\bserie\b|s[ée]ries?|\bshow(s)?\b|\btv[ -]?show|\bseason(s)?\b|\bepisode(s)?\b|\banime\b|\bdrama(s)?\b|temporada|staffel|novela|serial(es)?|\bdizi\b|\bsezon\b|مسلسل/i;
  const GROUP_VOD_RE = /\bvod\b|\bmovie(s)?\b|\bfilm(s|e|es|me|mes)?\b|\bcinema\b|pelicula|película|filme|\bkino\b|\bpeliculas\b|\bmovi\b|\bott\b\s*movie|أفلام|\bfilmy\b/i;
  /* "SERIE A" / "SERIE B" are Italian football leagues, and they are among the most common LIVE
     group names there are. Without this they would trip the series keywords and every match in
     them would vanish out of Live TV. Checked before the series keywords, never after. */
  const FOOTBALL_SERIE_RE = /\bserie\s*[ab]\b/i;

  function classify(url, group, name) {
    const u = String(url || '').toLowerCase();
    /* Path segment is the strongest signal: Xtream serves /live/, /movie/ and /series/. */
    if (/\/series\//.test(u)) return 'series';
    if (/\/(movies?|vod)\//.test(u)) return 'vod';
    if (/\/live\//.test(u)) return 'live';
    const g = String(group || '').toLowerCase();
    const n = String(name || '');
    if (GROUP_SERIES_RE.test(g) && !FOOTBALL_SERIE_RE.test(g)) return 'series';
    if (GROUP_VOD_RE.test(g)) return 'vod';
    /* A file extension that isn't a live container means on-demand. Do this BEFORE the episode
       heuristic so a live channel merely named "Season Sports 1" is not mistaken for a show. */
    const e = extOf(u);
    if (e && !/^(ts|m3u8|mpd)$/.test(e)) return EPISODE_RE.test(n) ? 'series' : 'vod';
    if (EPISODE_RE.test(n)) return 'series';
    return 'live';
  }

  /* Series entries in a playlist are individual EPISODES. Group them under one title so the app
     shows a series rather than hundreds of loose rows. */
  function seriesTitle(name) {
    return String(name || '')
      .replace(/\s*[-–]?\s*S\d{1,2}\s*[ex]\s*\d{1,3}.*$/i, '')
      .replace(/\s*[-–]?\s*season\s*\d+.*$/i, '')
      .replace(/\s*\d{1,2}x\d{1,3}.*$/i, '')
      .trim() || String(name || '');
  }

  /* v18.4: AN ENTRY'S ID COMES FROM WHAT IT IS, NOT FROM WHERE IT SAT IN THE FILE.
     These ids used to be a running counter — m3u_1, m3u_2 … — restarted at zero on every parse.
     That is safe only while exactly one document is ever parsed. The app now reads two (the
     compact sign-in playlist and the full catalogue) and merges them, and a counter makes the
     fifth line of one document collide with the fifth line of the other: two DIFFERENT titles
     carrying one id. Everything that resolves a tap back to a title goes through that id
     (findByKey), so the collision plays the wrong programme — and favourites and Recently Played,
     which are stored by the same key, attach to the wrong title too.
     Derived from the stream address instead, an id is stable across documents, across refreshes
     and across sessions, and two different streams cannot share one. Two independent hashes are
     combined so the 64-bit result does not collide across a catalogue of tens of thousands. */
  function stableId(prefix, seed) {
    const s = String(seed || '');
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = ((h1 * 33) ^ c) >>> 0;
      h2 = ((h2 * 33) ^ (c + i)) >>> 0;
    }
    return prefix + h1.toString(36) + h2.toString(36);
  }

  function parseM3U(text) {
    const lines = String(text || '').split(/\r?\n/);
    const buckets = { live: [], vod: [], series: [] };
    const catMaps = { live: new Map(), vod: new Map(), series: new Map() };
    const seriesIndex = new Map();
    let pending = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (/^#EXTINF/i.test(line)) {
        const a = attrs(line);
        const comma = line.indexOf(',');
        pending = {
          name: (comma >= 0 ? line.slice(comma + 1) : '').trim() || a['tvg-name'] || 'Untitled',
          logo: a['tvg-logo'] || '',
          group: a['group-title'] || '',
          tvgId: a['tvg-id'] || ''
        };
        continue;
      }
      if (line.charAt(0) === '#') continue;      // other directives
      if (!pending) continue;                    // a URL with no preceding EXTINF
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) { pending = null; continue; }

      const url = line;
      const type = classify(url, pending.group, pending.name);
      const group = pending.group || (type === 'live' ? 'Live' : type === 'vod' ? 'Movies' : 'Series');
      const catId = 'g' + group.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (!catMaps[type].has(catId)) catMaps[type].set(catId, { category_id: catId, category_name: group });

      if (type === 'series') {
        /* Collapse episodes under their show. The episode list is carried on the entry so the
           picker can open it without another request — a playlist has no per-series endpoint. */
        const title = seriesTitle(pending.name);
        const key = catId + '|' + title.toLowerCase();
        let show = seriesIndex.get(key);
        if (!show) {
          show = {
            _type: 'series', series_id: stableId('m3u_s', catId + '|' + title.toLowerCase()), name: title,
            cover: pending.logo, stream_icon: pending.logo,
            category_id: catId, category_name: group,
            _m3uEpisodes: []
          };
          seriesIndex.set(key, show);
          buckets.series.push(show);
        }
        show._m3uEpisodes.push({
          _type: 'series', episode_id: stableId('m3u_e', url), title: pending.name, name: pending.name,
          direct_source: url, container_extension: extOf(url) || 'mp4',
          stream_icon: pending.logo || show.cover, category_id: catId
        });
        if (!show.cover && pending.logo) { show.cover = show.stream_icon = pending.logo; }
        /* Clear the pending EXTINF exactly like the live/vod branch below does. Without this a
           playlist that lists two URLs under one #EXTINF (some panels emit a backup source) had
           the second URL silently attached to the previous entry's metadata. */
        pending = null;
        continue;
      }

      buckets[type].push({
        _type: type,
        stream_id: stableId('m3u_', url),
        name: pending.name,
        stream_icon: pending.logo,
        category_id: catId,
        category_name: group,
        direct_source: url,
        container_extension: extOf(url) || (type === 'live' ? 'ts' : 'mp4'),
        epg_channel_id: pending.tvgId
      });
      pending = null;
    }

    /* v23.0: "newest uploads first" sort (owner request — a category filter like "Tamil Movies"
       needs a button to reorder newest-to-oldest). An M3U carries no added/upload-date attribute
       anywhere (see attrs() above — only tvg-name/tvg-logo/group-title/tvg-id are ever parsed), so
       the only signal available at all is where an entry sits in the file. Most panels export
       get.php in ascending id/insertion order, so the LAST entry listed for a title is the most
       recently added one; `_recentRank` (0 = newest) is stamped in that reverse order so the app
       can sort by it without knowing which provider produced the file. Live is left unranked —
       recency has no meaning for a channel list. */
    buckets.vod.forEach((x, i) => { x._recentRank = buckets.vod.length - 1 - i; });
    buckets.series.forEach((x, i) => { x._recentRank = buckets.series.length - 1 - i; });

    const cats = t => Array.from(catMaps[t].values())
      .sort((a, b) => a.category_name.localeCompare(b.category_name));
    return {
      live: buckets.live, vod: buckets.vod, series: buckets.series,
      liveCats: cats('live'), vodCats: cats('vod'), seriesCats: cats('series'),
      total: buckets.live.length + buckets.vod.length + buckets.series.length
    };
  }

  function looksLikeM3U(text) {
    return /^\s*#EXTM3U/i.test(String(text || '')) || /#EXTINF/i.test(String(text || '').slice(0, 4096));
  }

  /* ── v19.17: WHAT THE SELLER ACTUALLY HANDED OVER ──────────────────────────────────────────
     "Portal URL" is whatever the provider wrote in their own notes, and in practice it is one of
     half a dozen different things:

       http://host:8080                      the panel root
       http://host:8080/c/                   the MAG portal page a Smart-STB user is given
       http://host/stalker_portal/c/         the same thing on a Ministra install
       http://host:8080/player_api.php       an API file
       http://host:8080/get.php?username=…   the finished M3U link itself

     Every playlist address this app builds is base + '/get.php?…', so the base has to be the panel
     ROOT. Keeping the decoration the seller happened to include is what produced addresses like
     `http://host:8080/c/get.php?username=…`, which exist on no panel anywhere — and the portal HTML
     or 404 that came back was then read as "a security layer is blocking us" on a line where
     nothing was blocking anything. Stripping it is the difference between a working sign-in and an
     unfixable-looking error.

     Returns { root, typed, playlist, username, password }:
       root      the panel root, seller decoration removed — tried FIRST
       typed     origin + the path exactly as typed, for the rare panel really hosted in a subfolder
       playlist  set when the URL IS already a playlist; then it is used verbatim and nothing is
                 built at all, which is what makes "just paste the M3U link they gave you" work
       username/password  read back out of a pasted get.php link, so the line still has an identity */
  const PORTAL_PATH_JUNK = /^(c|client|stalker_portal|portal|play|player|api|index\.html?|index\.php|portal\.php|load\.php|get\.php|player_api\.php|panel_api\.php|xmltv\.php|enigma2\.php|m3u|playlist)$/i;

  function looksLikePlaylistUrl(u) {
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
    if (looksLikePlaylistUrl(x.href)) {
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

  /* Candidate playlist URLs for a portal that gave us a username and password. Panels differ in
     which of these they answer, so they are tried in order of how common they are.
     v19.17: built off the panel root first and the path as typed second, and short-circuited
     entirely when the "portal URL" is already the playlist. The bare base is no longer a candidate:
     a GET on / can only return the panel's landing page, and reading that as a playlist is exactly
     what made a MAG portal's HTML look like an answer. */
  function m3uCandidates(base, user, pass) {
    const sig = parseSignIn(base);
    if (sig.playlist) return [sig.playlist];
    const u = encodeURIComponent(user || sig.username || '');
    const p = encodeURIComponent(pass != null && pass !== '' ? pass : (sig.password || ''));
    const out = [];
    const add = x => { if (x && out.indexOf(x) < 0) out.push(x); };
    for (const b of [sig.root, sig.typed]) {
      if (!b) continue;
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=ts');
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus');
      add(b + '/get.php?username=' + u + '&password=' + p + '&type=m3u');
      add(b + '/playlist/' + u + '/' + p + '/m3u_plus');
    }
    return out;
  }

  /* Playlist URLs for a portal that identifies the customer by MAC ADDRESS instead of by a
     username. This is the flow the app is built around: the app shows a MAC, the reseller binds a
     line to it, and from then on the portal will hand that MAC its own M3U. Panels differ in where
     they expose it and in whether they want the MAC with or without colons, so both shapes are
     tried, most common first. */
  function macM3uCandidates(base, mac) {
    const sig = parseSignIn(base);
    if (sig.playlist) return [sig.playlist];
    const m = normaliseMac(mac);
    if (!m) return [];
    const enc = encodeURIComponent(m);           // 00%3A1A%3A79%3A45%3AFD%3AAD
    const flat = m.replace(/:/g, '');            // 001A7945FDAD
    const out = [];
    const add = x => { if (x && out.indexOf(x) < 0) out.push(x); };
    for (const b of [sig.root, sig.typed]) {
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

  /* ── Stalker / Ministra (MAG portal) ──────────────────────────────────────────────────────── */

  /* MAG boxes are identified by a MAC in Infomir's range. A portal ties the subscription to that
     MAC, which is why sellers ask for one instead of a username.
     v17.8: DRAWN FROM THE CRYPTO GENERATOR, NOT Math.random(). This is the identifier a seller
     BINDS a line to, so across a customer base it has to be independent per device — two customers
     handed the same MAC means the seller binds two subscriptions to one address, and neither of
     them can be told apart afterwards. Math.random() carries no independence guarantee at all: the
     spec allows any algorithm, and engines that seed from the clock can hand near-identical
     sequences to devices that first open the app within the same moment of each other — which is
     exactly what a batch of customers installing on the day a service launches looks like. The
     device id and the activation code have used crypto.getRandomValues since they were written;
     this was the one identifier that still did not, and it is the one that matters most.
     The 00:1A:79 prefix is kept: it is Infomir's OUI, and Stalker/MAG portals check for it.
     Falls back to Math.random() only where the crypto API is genuinely absent. */
  function randomMac() {
    let b = null;
    try {
      const c = (typeof globalThis !== 'undefined') && (globalThis.crypto || global.crypto);
      if (c && c.getRandomValues) { b = new Uint8Array(3); c.getRandomValues(b); }
    } catch (e) { b = null; }
    if (!b) b = [0, 0, 0].map(() => Math.floor(Math.random() * 256));
    const h = i => ('0' + b[i].toString(16)).slice(-2).toUpperCase();
    return '00:1A:79:' + h(0) + ':' + h(1) + ':' + h(2);
  }
  function normaliseMac(mac) {
    const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 12);
    if (hex.length !== 12) return '';
    return hex.match(/../g).join(':');
  }

  /* Portals live at different paths depending on the panel build. */
  /* v19.31: HTTPS TWINS. A portal behind a CDN always answers on https as well as http, and a
     WAF rule is routinely scoped to one scheme — the plain-http request is the one that looks like
     a scraper, while the https one goes through the same edge a browser would use. Trying both is
     cheap (they are only reached when the first has already been refused) and it costs a portal
     that is answering nothing at all, since the first candidate still wins on the first request.
     The http forms stay first: that is what has always worked, and this must not reorder them. */
  function stalkerEndpoints(base) {
    const b = String(base || '').replace(/\/+$/, '').replace(/\/(c|stalker_portal)\/?$/i, '');
    const paths = ['/portal.php', '/stalker_portal/server/load.php', '/server/load.php', '/c/portal.php'];
    const out = paths.map(p => b + p);
    if (/^http:\/\//i.test(b)) {
      const sec = b.replace(/^http:/i, 'https:');
      for (const p of paths) out.push(sec + p);
    }
    return out;
  }
  function stalkerQuery(params) {
    return Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  }

  /* A Stalker channel's "cmd" is not a URL — it is a token the portal exchanges for a one-shot
     stream link, which is why a MAG playlist cannot simply be copied out. */
  /* v19.63: TAKE THE URL, DO NOT GUESS THE PREFIX.
     A Stalker "cmd" is a player directive, not a bare address: the portal names the engine it
     wants the box to use in front of the URL — "ffmpeg http://…", "auto http://…",
     "mpegts http://…", "ffrt3 http://…", "extension http://…". Which word appears is per-panel and
     the vocabulary is open-ended, so stripping the single literal "ffmpeg " left every other
     prefix attached. The value then failed stalkerPickUrl's ^https?:// test, the link was thrown
     away, and the customer was told "the portal accepted the request but returned no link for
     this title" — about a channel that was working perfectly.
     Measured live on sw4u.net: create_link answered
       auto http://198.144.155.34:9101/<hash>/index.m3u8?token=<token>
     and every single channel reported "This channel didn't start".
     Pulling out the first http(s) substring is prefix-agnostic, so a panel that invents a new
     engine name tomorrow keeps working. When there is no URL at all — a relative
     "/media/file_<id>.mpg" command, which is a real shape — the original ffmpeg-stripping
     behaviour is kept exactly as it was. */
  function stalkerStreamCmd(ch) {
    const cmd = String((ch && (ch.cmd || ch.url)) || '').trim();
    const m = /https?:\/\/\S+/i.exec(cmd);
    if (m) return m[0];
    return cmd.replace(/^ffmpeg\s+/i, '').trim();
  }

  function stalkerChannelsToApp(list, genres) {
    const byId = new Map();
    (genres || []).forEach(g => byId.set(String(g.id), g.title || g.name || 'Live'));
    const cats = new Map(), out = [];
    (list || []).forEach((ch, i) => {
      const gid = String(ch.tv_genre_id || ch.genre_id || '0');
      const gname = byId.get(gid) || 'Live';
      const catId = 'st' + gid;
      if (!cats.has(catId)) cats.set(catId, { category_id: catId, category_name: gname });
      out.push({
        _type: 'live',
        stream_id: String(ch.id || ('st' + i)),
        name: ch.name || ch.title || 'Channel',
        stream_icon: ch.logo || ch.logo_big || '',
        category_id: catId,
        category_name: gname,
        /* v19.0.1: KEEP THE PORTAL'S ORIGINAL COMMAND STRING, exactly as the VOD and Series
           loaders already do (see stalkerLoadVod). create_link matches on the exact text the
           portal printed, and a channel is listed as `ffmpeg http://…` — stalkerStreamCmd()
           strips that prefix to make the value usable as a URL elsewhere, so sending only the
           cleaned form asks the portal for a command it never issued. The portal answers
           normally and returns a null link, which surfaces as "the portal accepted the request
           but returned no link for this title" on a channel that is perfectly fine.
           Live was the ONE loader that dropped the raw text; stalkerResolve has always tried
           _stalkerCmdRaw first, so carrying it here is all that was missing. The id is kept for
           the same reason it is on VOD: it is what /media/file_<id>.mpg is built from. */
        _stalkerCmdRaw: String(ch.cmd || ch.url || ''),
        _stalkerId: (ch.id != null ? String(ch.id) : ''),
        _stalkerCmd: stalkerStreamCmd(ch),
        container_extension: 'ts'
      });
    });
    return { live: out, liveCats: Array.from(cats.values()) };
  }

  global.Media26Portal = {
    parseM3U: parseM3U,
    looksLikeM3U: looksLikeM3U,
    parseSignIn: parseSignIn,
    looksLikePlaylistUrl: looksLikePlaylistUrl,
    m3uCandidates: m3uCandidates,
    macM3uCandidates: macM3uCandidates,
    classify: classify,
    seriesTitle: seriesTitle,
    randomMac: randomMac,
    normaliseMac: normaliseMac,
    stalkerEndpoints: stalkerEndpoints,
    stalkerQuery: stalkerQuery,
    stalkerChannelsToApp: stalkerChannelsToApp,
    stalkerStreamCmd: stalkerStreamCmd
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Media26Portal;
})(typeof window !== 'undefined' ? window : globalThis);
