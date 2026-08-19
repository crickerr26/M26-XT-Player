/* Yez Player — the inbuilt player for Media26 XT.
 *
 * Everything plays here: Live TV, Movies and Series, on the website and on a phone, in the page's
 * own <video> element. Nothing is handed to an external app unless the customer asks for it.
 *
 * WHAT THIS ADDS OVER THE ENGINE IT DRIVES
 * ----------------------------------------
 * Decoding is not the hard part of IPTV and it is already solved: m26player2.js probes a stream's
 * real bytes and picks native / hls.js / mpegts.js / in-app Matroska / transcoder from the
 * evidence, then recovers in place when a live stream drops. That machinery is proven against real
 * customer lines and Yez Player drives it rather than duplicating it.
 *
 * The part that was NOT solved is which ADDRESS to ask for, and it is what stops a whole line
 * dead. Measured on a live account (redproibo.online, 13,245 channels, August 2026):
 *
 *     http://host:8080/Gz1234/000000/112997            -> HTTP 511, 0 bytes      (as printed)
 *     http://host:8080/live/Gz1234/000000/112997.ts    -> HTTP 511, 0 bytes      (xtreamForms sibling)
 *     http://host/Gz1234/000000/112997                 -> HTTP 200, video/mp2t   <- plays
 *     http://host/live/Gz1234/000000/112997.ts         -> HTTP 200, video/mp2t   <- plays
 *
 * The panel publishes port 8080 in its own get.php playlist and then refuses that port, while
 * serving the identical stream on the default port. Every channel, every movie, every episode.
 * xtreamForms() already derives the /live/ and /movie/ path siblings, but the discriminator here
 * is not the PATH — it is the PORT, and no amount of path rewriting reaches it. So each candidate
 * address is expanded through a host ladder: the address exactly as the provider printed it, then
 * the same address on the panel's default port.
 *
 * THE PROVIDER'S OWN ANSWER IS ALWAYS TRIED FIRST. A derived variant is a good guess and never
 * better than what the panel published — on a line where 8080 is the only working port, the
 * original still leads and nothing changes. The variant costs one probe (~0.2s) when the original
 * is genuinely dead, which is the whole price of making a gated line play.
 *
 * The ladder is applied to relay and transcoder addresses too, by rewriting the inner ?url=
 * parameter: a transcoder fed a 511 address fails exactly like the browser does, so ffmpeg has to
 * be pointed at the port that answers as well.
 *
 * FAILURE REPORTING
 * -----------------
 * When every route is exhausted the summary names the FIRST refusal, not just the last one. A
 * customer whose panel answered 511 was being shown "transcoder: HTTP 503" — the app's own helper
 * being asleep — which reads as a different fault entirely and sends the investigation to the
 * wrong place. Both verdicts are reported. (Same rule as the sign-in path in CLAUDE.md: never let
 * a later failure erase an earlier one's evidence.)
 */
(function (global) {
  'use strict';

  var CORE = null;                 /* m26player2.js — the decode engine Yez Player drives */
  var D = {};

  function core() { return CORE || (CORE = global.M26Player2) || null; }

  /* ── HOST LADDER ──────────────────────────────────────────────────────────────────────────
     One address in, its alternates out — most-trusted first, never including the input itself. */

  /* The same address on the panel's default port. Returns '' when there is no explicit port to
     drop, so a link that never named one produces no variant and costs nothing. */
  function withoutPort(u) {
    try {
      var x = new URL(String(u || ''));
      if (!x.port) return '';
      x.port = '';
      return x.href;
    } catch (e) { return ''; }
  }

  /* Relay and transcoder addresses carry the real stream in a ?url= parameter. Rewrite that inner
     address and hand back the wrapper rebuilt around it, so /proxy and /transcoder/hls climb the
     same ladder as a direct link. */
  function remapInner(u, fn) {
    try {
      var x = new URL(String(u || ''));
      var inner = x.searchParams.get('url');
      if (!inner) return '';
      var v = fn(inner);
      if (!v || v === inner) return '';
      x.searchParams.set('url', v);
      return x.href;
    } catch (e) { return ''; }
  }

  /* Does this address CARRY a stream address rather than being one? /proxy?url=… and
     /transcoder/hls?url=… both do. */
  function hasInner(u) {
    try { return !!new URL(String(u || '')).searchParams.get('url'); } catch (e) { return false; }
  }

  /* Every alternate address worth trying for one route, in order.
     A wrapper is rewritten ONLY on the inside. Stripping the port off the wrapper itself would
     rewrite the APP'S OWN origin — on a build served from localhost:8899, or a self-hosted install
     on :8080, that produced a dead same-origin address instead of a working stream. The stream
     address is the only thing whose port is ever in question. */
  function ladder(url) {
    var out = [], seen = {};
    function push(v) { if (v && v !== url && !seen[v]) { seen[v] = 1; out.push(v); } }
    if (hasInner(url)) push(remapInner(url, withoutPort));
    else push(withoutPort(url));
    return out;
  }

  /* ── GATE MEMORY ──────────────────────────────────────────────────────────────────────────
     Which host:port has already refused this device, remembered across reloads.

     Adding the default-port route is only half the fix. This line allows ONE upstream connection
     (its own panel reports max_connections:1), so every address tried before the working one costs
     a connection slot the panel then refuses with 401 — measured: the gated route ran first, the
     good route answered 200, and the routes behind it got 401 because the slot was still held.
     Trying a known-dead address is therefore not merely slow, it actively poisons the routes after
     it. So a refusal is remembered: the FIRST failure teaches the app, and from then on — including
     after a reload, on this device — the working port leads and the gated one drops to last. */
  var GATE_KEY = 'yez.gatedPorts.v1';
  var gated = null;

  function loadGate() {
    if (gated) return gated;
    gated = {};
    try {
      var raw = global.localStorage && global.localStorage.getItem(GATE_KEY);
      if (raw) gated = JSON.parse(raw) || {};
    } catch (e) { gated = {}; }
    return gated;
  }
  function saveGate() {
    try { global.localStorage && global.localStorage.setItem(GATE_KEY, JSON.stringify(gated || {})); } catch (e) {}
  }
  /* The stream address inside a wrapper is the one whose port is judged, never the wrapper's. */
  function streamOf(u) {
    try {
      var x = new URL(String(u || ''));
      var inner = x.searchParams.get('url');
      return inner || x.href;
    } catch (e) { return String(u || ''); }
  }
  function hostPort(u) {
    try { var x = new URL(streamOf(u)); return x.port ? x.host : ''; } catch (e) { return ''; }
  }
  function isGated(u) { var k = hostPort(u); return !!(k && loadGate()[k]); }

  /* Called by the app when a route fails. Only a refusal that is clearly the PORT being gated
     counts — 511 (what this panel answers on live), 403, 401, and "src not supported", which is
     how a deceptive 200-carrying-HTML reaches us through the media element (this panel's answer on
     movies: HTTP 200, content-type text/html, zero bytes). A decoder giving up, a timeout or a
     404 says nothing about the port and must never poison it. */
  var REFUSAL = /\b(511|403|401)\b|src not supported/i;
  function noteRefusal(url, why) {
    var k = hostPort(url);
    if (!k) return false;
    if (!REFUSAL.test(String(why || ''))) return false;
    loadGate();
    if (gated[k]) return false;
    gated[k] = Date.now();
    saveGate();
    return true;
  }
  function forgetGates() { gated = {}; saveGate(); }

  /* ── EXPAND ───────────────────────────────────────────────────────────────────────────────
     A route list in, the same list with each entry followed immediately by its ladder.
     Shape-agnostic on purpose: index.html's plan() emits {kind,label,url} and the engine's
     catalogue emits {url,claim,label,…}. Every field is carried across untouched and only the
     address changes, so an expanded route is decoded by exactly the same engine as its original. */
  function expand(routes) {
    var out = [], seen = {};
    function add(r) {
      if (!r || !r.url) return;
      var k = (r.kind || r.forceEngine || '') + '|' + r.url;
      if (seen[k]) return;
      seen[k] = 1;
      out.push(r);
    }
    var demoted = [];
    for (var i = 0; i < (routes || []).length; i++) {
      var r = routes[i];
      var alts = ladder(r.url);
      var variants = [];
      for (var j = 0; j < alts.length; j++) {
        var c = {};
        for (var f in r) if (Object.prototype.hasOwnProperty.call(r, f)) c[f] = r[f];
        c.url = alts[j];
        c.label = (r.label || 'Route') + ' (default port)';
        variants.push(c);
      }
      /* Once this host:port is known to refuse us, the variant LEADS and the original is pushed
         behind every other route — not dropped, because a panel can be fixed at any time and the
         app must be able to find its way back without the customer clearing anything. */
      if (variants.length && isGated(r.url)) {
        for (var v = 0; v < variants.length; v++) add(variants[v]);
        demoted.push(r);
      } else {
        add(r);
        for (var w = 0; w < variants.length; w++) add(variants[w]);
      }
    }
    for (var d = 0; d < demoted.length; d++) add(demoted[d]);
    return out;
  }

  /* The expansion is applied immediately after each original, never appended at the end: a gated
     address and its working twin differ by one request, and burying the twin behind a full
     transcoder wake-up is exactly what made these lines look unplayable. */
  var plan = expand;   /* the engine's catalogue hook uses the same function */

  /* ── PUBLIC API ───────────────────────────────────────────────────────────────────────────
     Deliberately the same shape as M26Player2 so index.html can drive either one. */

  function configure(deps) {
    D = deps || {};
    var c = core();
    if (!c) return false;
    /* Pass the host ladder in as the route planner and hand everything else through untouched. */
    var wrapped = {};
    for (var k in D) if (Object.prototype.hasOwnProperty.call(D, k)) wrapped[k] = D[k];
    wrapped.planCandidates = function (candidates) { return plan(candidates); };
    c.configure(wrapped);
    return true;
  }

  function play(item, hooks) {
    var c = core();
    if (!c) return null;
    return c.play(item, hooks);
  }

  function stop() { var c = core(); if (c) c.stop(); }

  global.YezPlayer = {
    name: 'Yez Player',
    configure: configure,
    play: play,
    stop: stop,
    /* expand() is what index.html's live route planner calls; the rest is exported so the ladder
       can be exercised on its own, without a browser */
    expand: expand,
    /* the app calls this on every failed route so one refusal teaches the whole app */
    noteRefusal: noteRefusal,
    isGated: isGated,
    forgetGates: forgetGates,
    ladder: ladder,
    plan: plan,
    hasInner: hasInner,
    withoutPort: withoutPort,
    remapInner: remapInner
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.YezPlayer;
})(typeof window !== 'undefined' ? window : globalThis);
