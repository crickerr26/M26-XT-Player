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

  function classify(url, group, name) {
    const u = String(url || '').toLowerCase();
    /* Path segment is the strongest signal: Xtream serves /live/, /movie/ and /series/. */
    if (/\/series\//.test(u)) return 'series';
    if (/\/(movies?|vod)\//.test(u)) return 'vod';
    if (/\/live\//.test(u)) return 'live';
    const g = String(group || '').toLowerCase();
    const n = String(name || '');
    if (/\bseries\b|\bshow(s)?\b|\btv[ -]?show|\bseason(s)?\b|\bepisode(s)?\b|\banime\b|\bdrama(s)?\b/.test(g)) return 'series';
    if (/\bvod\b|\bmovie(s)?\b|\bfilm(s)?\b|\bcinema\b|\bpelicula|\bfilme(s)?\b/.test(g)) return 'vod';
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

  function parseM3U(text) {
    const lines = String(text || '').split(/\r?\n/);
    const buckets = { live: [], vod: [], series: [] };
    const catMaps = { live: new Map(), vod: new Map(), series: new Map() };
    const seriesIndex = new Map();
    let pending = null, seq = 0;

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
            _type: 'series', series_id: 'm3u_s' + (++seq), name: title,
            cover: pending.logo, stream_icon: pending.logo,
            category_id: catId, category_name: group,
            _m3uEpisodes: []
          };
          seriesIndex.set(key, show);
          buckets.series.push(show);
        }
        show._m3uEpisodes.push({
          _type: 'series', episode_id: 'm3u_e' + (++seq), title: pending.name, name: pending.name,
          direct_source: url, container_extension: extOf(url) || 'mp4',
          stream_icon: pending.logo || show.cover, category_id: catId
        });
        if (!show.cover && pending.logo) { show.cover = show.stream_icon = pending.logo; }
        continue;
      }

      buckets[type].push({
        _type: type,
        stream_id: 'm3u_' + (++seq),
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

  /* Candidate playlist URLs for a portal that gave us a username and password. Panels differ in
     which of these they answer, so they are tried in order of how common they are. */
  function m3uCandidates(base, user, pass) {
    const b = String(base || '').replace(/\/+$/, '');
    const u = encodeURIComponent(user || ''), p = encodeURIComponent(pass || '');
    if (/\.(m3u8?|php)(\?|$)/i.test(b) && !user) return [b];
    return [
      b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus&output=ts',
      b + '/get.php?username=' + u + '&password=' + p + '&type=m3u_plus',
      b + '/get.php?username=' + u + '&password=' + p + '&type=m3u',
      b + '/playlist/' + u + '/' + p + '/m3u_plus',
      b
    ];
  }

  /* ── Stalker / Ministra (MAG portal) ──────────────────────────────────────────────────────── */

  /* MAG boxes are identified by a MAC in Infomir's range. A portal ties the subscription to that
     MAC, which is why sellers ask for one instead of a username. */
  function randomMac() {
    const h = () => ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2).toUpperCase();
    return '00:1A:79:' + h() + ':' + h() + ':' + h();
  }
  function normaliseMac(mac) {
    const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 12);
    if (hex.length !== 12) return '';
    return hex.match(/../g).join(':');
  }

  /* Portals live at different paths depending on the panel build. */
  function stalkerEndpoints(base) {
    const b = String(base || '').replace(/\/+$/, '').replace(/\/(c|stalker_portal)\/?$/i, '');
    return [b + '/portal.php', b + '/stalker_portal/server/load.php', b + '/server/load.php', b + '/c/portal.php'];
  }
  function stalkerQuery(params) {
    return Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  }

  /* A Stalker channel's "cmd" is not a URL — it is a token the portal exchanges for a one-shot
     stream link, which is why a MAG playlist cannot simply be copied out. */
  function stalkerStreamCmd(ch) {
    const cmd = String((ch && (ch.cmd || ch.url)) || '');
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
        _stalkerCmd: stalkerStreamCmd(ch),
        container_extension: 'ts'
      });
    });
    return { live: out, liveCats: Array.from(cats.values()) };
  }

  global.Media26Portal = {
    parseM3U: parseM3U,
    looksLikeM3U: looksLikeM3U,
    m3uCandidates: m3uCandidates,
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
