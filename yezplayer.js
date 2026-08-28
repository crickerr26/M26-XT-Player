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
  /* host:port when an explicit port is present, otherwise the bare host — unlike hostPort()
     above this never returns '' just because the address used an implicit default port, which
     is what Slow Memory below needs (a hanging route is a hanging route whether or not the panel
     spelled out :80/:443 in the address). */
  function fullHost(u) {
    try { return new URL(streamOf(u)).host; } catch (e) { return ''; }
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

  /* ── SLOW MEMORY ──────────────────────────────────────────────────────────────────────────
     v24.33 (measured with a mock upstream that silently drops the connection — mimicking a
     real-world firewalled/black-holed port, which answers nothing at all rather than a clean
     403/404): a route with ZERO evidence of ever connecting — no bytes, no decoded frame — still
     burns the FULL start budget (20s live / 45s transcoded) before the app gives up on it and
     tries the next one. Measured directly: one such route in front of a working one added 20.4
     REAL seconds before playback started. That budget is deliberately generous and is NOT
     shortened here — v20.0's redproibo.online fix depends on exactly this patience for a route
     that IS slowly connecting (mpegts.js can hold up to ~8s of stash buffer before producing any
     visible progress, which looks identical to "nothing happening yet" from here) — cutting the
     zero-progress window short would silently break that already-proven fix for a different
     provider.
     What CAN safely change is what happens on the NEXT play. A route that needed the full budget
     to fail is real, useful evidence for THIS host — weaker than GATE MEMORY's refusal signal
     (a timeout proves nothing about the PORT, exactly as the comment above says, so it must never
     gate anything), but still worth acting on for ORDERING: never removed, only ever tried LAST
     among the routes for this host, so a channel that shares the same dead port as a previous one
     stops paying that 20s tax on every single play — it pays it once, then Slow Memory keeps that
     specific address at the back of the line from then on, while still trying it as a last resort
     in case the panel recovers. */
  var SKEY = 'yez.slowPorts.v1';
  var slow = null;
  function loadSlow() {
    if (slow) return slow;
    slow = {};
    try {
      var raw = global.localStorage && global.localStorage.getItem(SKEY);
      if (raw) slow = JSON.parse(raw) || {};
    } catch (e) { slow = {}; }
    return slow;
  }
  function saveSlow() {
    try { global.localStorage && global.localStorage.setItem(SKEY, JSON.stringify(slow || {})); } catch (e) {}
  }
  /* Only "startup timeout" — overBudget()'s own verdict for a route with no evidence of
     connecting at all — counts. Every other failure reason (a decode error, a stall after real
     playback started, a mid-stream reconnect giving up) says nothing about whether THIS address
     is worth trying first next time and must not be learned from here. */
  var TIMEOUT_WHY = /^startup timeout$/i;
  function noteTimeout(url, why) {
    if (!TIMEOUT_WHY.test(String(why || '').trim())) return false;
    var k = fullHost(url);
    if (!k) return false;
    loadSlow();
    slow[k] = Date.now();
    saveSlow();
    return true;
  }
  function isSlow(u) { var k = fullHost(u); return !!(k && loadSlow()[k]); }
  function forgetSlow() { slow = {}; saveSlow(); }

  /* The address this device should actually use for a stream — the ladder's answer once the
     original's port is known to be refused, otherwise the provider's own link untouched.
     Sync, so anything that builds a URL can call it, including the external-player handoff. */
  function preferredUrl(u) {
    if (!isGated(u)) return u;
    var alts = ladder(u);
    return alts.length ? alts[0] : u;
  }

  /* Settle a host's port BEFORE handing the link to something we cannot observe.
     The in-app player learns which port works by failing on it, but VLC is a different app — it
     opens, gets the panel's refusal, and shows the customer a black screen with nothing reported
     back here. So for an external handoff the verdict is established first, once per host, with a
     single tiny ranged request that is thrown away. `probe(url)` is supplied by the app (it knows
     the relay) and resolves true only if the ORIGINAL port really serves media. */
  var verifying = {};
  function verifyPort(u, probe) {
    var k = hostPort(u);
    if (!k || typeof probe !== 'function') return Promise.resolve(preferredUrl(u));
    loadGate();
    if (gated[k] !== undefined) return Promise.resolve(preferredUrl(u));   /* already settled */
    if (!withoutPort(streamOf(u))) return Promise.resolve(u);
    if (!verifying[k]) {
      verifying[k] = Promise.resolve()
        .then(function () { return probe(streamOf(u)); })
        .then(function (ok) { gated[k] = ok ? 0 : Date.now(); saveGate(); })
        .catch(function () {});
    }
    return verifying[k].then(function () { return preferredUrl(u); });
  }

  /* ── TRANSCODER HEALTH ────────────────────────────────────────────────────────────────────
     A transcoded route carries a 130-second start budget, because waking a sleeping free instance
     legitimately takes that long. When the service is not asleep but GONE, that budget is spent in
     full on a route that cannot work — and for an MKV the transcoder is tried FIRST, because no
     browser is assumed to decode Matroska. Measured with the service suspended: an MKV movie took
     17.0s to start, 8.5s of it burned on the dead transcoder before anything else was tried.
     So its state is remembered, briefly. While it is known down, transcoded routes go last instead
     of first — never removed, so the moment the service is back a title that truly needs it still
     finds it, and the flag ages out on its own. */
  var TKEY = 'yez.transcoderDown.v1';
  var TDOWN_TTL = 10 * 60 * 1000;
  function transcoderDown() {
    try {
      var v = +(global.localStorage && global.localStorage.getItem(TKEY) || 0);
      return !!(v && (Date.now() - v) < TDOWN_TTL);
    } catch (e) { return false; }
  }
  function noteTranscoder(url, why) {
    if (!/\/transcoder\//.test(String(url || ''))) return false;
    try {
      if (/\b(50[0-9]|52[0-9]|408)\b/.test(String(why || ''))) {
        global.localStorage && global.localStorage.setItem(TKEY, String(Date.now()));
        return true;
      }
    } catch (e) {}
    return false;
  }
  function noteTranscoderUp() { try { global.localStorage && global.localStorage.removeItem(TKEY); } catch (e) {} }

  /* ── ROUTE MEMORY ─────────────────────────────────────────────────────────────────────────
     Which route SHAPE (kind + label, the ladder's " (default port)" suffix stripped so a win on
     either port variant recognises its sibling) actually reached PLAYING last time, per provider
     host. This is deliberately a SEPARATE, weaker signal from GATE MEMORY above: gate memory only
     learns from an explicit refusal (511/403/401/src-not-supported) and never from a timeout,
     because a timeout says nothing about the port and must not poison it (see the note by
     isGated). But on a real line the "this movie takes ten tries" complaint is usually exactly
     that — several routes that simply never start within their budget, which gate memory
     correctly refuses to learn from and so repeats on every single play. Route memory never
     removes or demotes anything; it only ever PROMOTES a shape already proven to work, so a wrong
     or stale memory costs nothing beyond falling back to the walk this line always did. */
  var RKEY = 'yez.wonRoute.v1';
  var won = null;
  function loadWon() {
    if (won) return won;
    won = {};
    try {
      var raw = global.localStorage && global.localStorage.getItem(RKEY);
      if (raw) won = JSON.parse(raw) || {};
    } catch (e) { won = {}; }
    return won;
  }
  function saveWon() {
    try { global.localStorage && global.localStorage.setItem(RKEY, JSON.stringify(won || {})); } catch (e) {}
  }
  function baseLabel(label) { return String(label || '').replace(/ \(default port\)$/, ''); }
  function routeHost(u) {
    try { return new URL(streamOf(u)).hostname; } catch (e) { return ''; }
  }
  /* Called by the app the moment a route actually reaches PLAYING. */
  function noteRouteWon(url, kind, label) {
    var h = routeHost(url);
    if (!h) return;
    loadWon();
    won[h] = { url: String(url || ''), kind: kind || '', label: baseLabel(label), ts: Date.now() };
    saveWon();
    wonGlobal = { kind: kind || '', label: baseLabel(label), ts: Date.now() };
    saveWonGlobal();
  }
  function wonShape(u) {
    var h = routeHost(u);
    if (!h) return null;
    loadWon();
    return won[h] || null;
  }
  /* v24.43: forget a remembered shape once it actually fails. The memory above only ever grew,
     so a route that won yesterday and is broken today kept leading the list and kept costing its
     full failure time on every play — measured on a real line at 16s per attempt for a transcoder
     route answering HTTP 502. Clearing on failure means one play re-learns the winner; leaving it
     meant every play paid for the stale answer. Only the exact remembered shape is cleared, so an
     unrelated route failing never disturbs it. */
  function noteRouteLost(url, kind, label) {
    var h = routeHost(url);
    if (!h) return false;
    loadWon();
    var w = won[h];
    if (!w) return false;
    if (w.kind !== (kind || '') || w.label !== baseLabel(label)) return false;
    delete won[h];
    saveWon();
    if (wonGlobal && wonGlobal.kind === (kind || '') && wonGlobal.label === baseLabel(label)) {
      wonGlobal = null; saveWonGlobal();
    }
    return true;
  }

  /* v24.32 (owner report: "most videos" still cycling through 10+ routes before playing): the
     memory above is keyed per HOSTNAME, so it only pays off once a customer has already seen a
     particular host win once. A provider that spreads channels across many CDN hostnames (common
     — a channel list of 60+ live entries regularly touches a dozen distinct edge hosts) meant most
     titles were still walking their full route list from cold, every time, because the host they
     happened to land on had no memory yet even though the SAME provider had already proven which
     route shape works, repeatedly, on other hosts this session.
     This is a second, weaker memory: the single most recent winning shape across ALL hosts. It is
     consulted only when the host-specific memory above has nothing to say, and it only ever
     PROMOTES — same rule as wonShape — so a wrong guess costs exactly one extra probe (~0.2s)
     before falling back to the walk this line always did; it can never make anything worse. */
  var wonGlobal = null;
  function loadWonGlobal() {
    if (wonGlobal) return wonGlobal;
    wonGlobal = null;
    try {
      var raw = global.localStorage && global.localStorage.getItem(RKEY + '.global');
      if (raw) wonGlobal = JSON.parse(raw) || null;
    } catch (e) { wonGlobal = null; }
    return wonGlobal;
  }
  function saveWonGlobal() {
    try { global.localStorage && global.localStorage.setItem(RKEY + '.global', JSON.stringify(wonGlobal || null)); } catch (e) {}
  }
  function wonShapeGlobal() { loadWonGlobal(); return wonGlobal; }

  var CONTAINER_RE = /\.(mkv|mp4|m4v|avi|mov|wmv|flv|ts)(?:$|[?#])/i;
  /* How far back a route deserves to be pushed. Lower runs first; the sort is stable, so routes
     that score the same keep the order the app chose for them. */
  function penalty(r) {
    var u = String(r.url || '');
    /* A route matching a KNOWN WIN for this host jumps ahead of everything else below — including
       the transcoder-alive and hls-on-container rules, which is right: nothing outranks a shape
       this exact line has already proven works.
       v24.33 (found by driving the real cascade end-to-end against a mock upstream, not just
       reading the code — see the run.js harness): the EXACT address that won must outrank a same-
       SHAPE sibling, not just tie with it. Without this, once GATE MEMORY had demoted a host for
       an unrelated refused route, isGated() pushed that host's untested "(default port)" ladder
       variant of the WINNING route ahead of the original — same kind, same base label, so the two
       tied on this rule and the stable sort kept whichever gating had already put first. The
       result, measured: a channel that had already proven "Direct TS works" still spent one whole
       failed hop on a never-tried port variant before reaching the address that was ACTUALLY
       proven, every single time the host had any other gated route. An exact URL is strictly
       stronger evidence than "same kind and label" — a variant has never been tried at all — so it
       must never be out-ranked by gating logic that knows nothing about this specific address. */
    var w = wonShape(u);
    if (w && w.kind === (r.kind || '') && w.label === baseLabel(r.label || '') && w.url === u) return -2;
    if (w && w.kind === (r.kind || '') && w.label === baseLabel(r.label || '')) return -1;
    /* No memory for THIS host yet — fall back to what most recently won anywhere on this
       provider. Still outranked by an exact host match above, and still ranks ahead of every
       other rule below, but slightly behind it so a real host-specific memory is always trusted
       first once one exists. */
    var g = wonShapeGlobal();
    if (g && g.kind === (r.kind || '') && g.label === baseLabel(r.label || '')) return -0.5;
    /* SLOW MEMORY: this host previously burned its full start budget on a route with zero
       evidence of connecting. Worse than every rule below (a transcoder that's merely asleep, or
       an hls.js/container mismatch, can still fail in under a second) — sink it to the very back,
       but never drop it: the panel can recover, and nothing here may remove a route outright. */
    if (isSlow(u)) return 3;
    /* A transcoder route is judged ONLY on whether the service is alive. Its input is a Matroska
       file but its OUTPUT is HLS, which is exactly what hls.js is for — so it must never be caught
       by the container rule below, or the one route that rescues a codec this device cannot decode
       would sink for doing its job. */
    if (/\/transcoder\//.test(u)) return transcoderDown() ? 2 : 0;
    /* hls.js cannot play a Matroska or MP4 FILE — handing it one only spends a start budget before
       the native element gets its turn. Measured: 5.7s of the 17s above. */
    if (r.kind === 'hls' && CONTAINER_RE.test(streamOf(u)) && !/\.m3u8(?:$|[?#])/i.test(streamOf(u))) return 1;
    return 0;
  }

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
    /* Stable ordering pass: routes that cannot work right now sink, routes keep their relative
       order otherwise. Decorate-sort-undecorate, because Array#sort is only guaranteed stable on
       modern engines and this has to hold on older phone browsers too. */
    return out
      .map(function (r, i) { return { r: r, i: i, p: penalty(r) }; })
      .sort(function (a, b) { return (a.p - b.p) || (a.i - b.i); })
      .map(function (e) { return e.r; });
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
    /* the app calls this on every failed route too, alongside noteRefusal — only a verdict of
       exactly "startup timeout" (zero evidence the route ever connected) is learned from, and it
       only ever demotes the route on THIS host to run last next time, never removes it */
    noteTimeout: noteTimeout,
    isSlow: isSlow,
    forgetSlow: forgetSlow,
    /* the app calls this the instant a route reaches PLAYING, so the next play on this host
       leads with the shape already proven to work instead of re-walking the whole ladder */
    noteRouteWon: noteRouteWon,
    /* the app calls this when a route FAILS, so a remembered winner that has since broken
       stops leading the list on every subsequent play */
    noteRouteLost: noteRouteLost,
    /* cross-host fallback for a route shape never seen on THIS host yet — exported for tests */
    wonShape: wonShape,
    wonShapeGlobal: wonShapeGlobal,
    /* the address to hand an external app (VLC), and the one-shot check behind it */
    preferredUrl: preferredUrl,
    verifyPort: verifyPort,
    /* transcoder health, so a dead helper stops costing 130s on every MKV */
    transcoderDown: transcoderDown,
    noteTranscoder: noteTranscoder,
    noteTranscoderUp: noteTranscoderUp,
    ladder: ladder,
    plan: plan,
    hasInner: hasInner,
    withoutPort: withoutPort,
    remapInner: remapInner
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.YezPlayer;
})(typeof window !== 'undefined' ? window : globalThis);
