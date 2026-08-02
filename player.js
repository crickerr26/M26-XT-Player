/* Media26 inbuilt player — rebuilt from scratch (v15.8).
 *
 * WHY THIS EXISTS
 * The previous player was one 500-line function in which URL construction, device detection,
 * engine setup, failure handling, stall watchdogs and DOM updates were interleaved. Every new
 * format or panel quirk had to be threaded through that single body, which is how routes that
 * could only ever 404 ended up ahead of routes that worked, and how a missing address could reach
 * the point of attaching an undefined source. This module keeps the same three responsibilities
 * strictly apart, so a new container or a new panel behaviour is a change in exactly one of them:
 *
 *   1. PLAN      — an item becomes an ordered list of {url, engine} candidates. Pure data. No DOM,
 *                  no playback, no side effects, so it can be reasoned about and tested on its own.
 *   2. ENGINES   — native <video>, hls.js, native HLS, mpegts.js, the in-app Matroska remuxer and
 *                  the server transcoder each implement one small interface: start(), stop().
 *                  Adding a format means adding an engine, not editing a cascade.
 *   3. SUPERVISOR— drives the plan: start budgets, automatic failover to the next candidate,
 *                  stall detection, in-place reconnect, position keeping, and cancellation.
 *
 * FORMAT COVERAGE — the point of the rebuild. Any address a playlist can hand us is mapped to the
 * engines that can actually decode it ON THIS DEVICE, and the ones that cannot are never queued:
 *
 *   .m3u8            native HLS on Apple (hardware decode, HEVC + 4K), hls.js everywhere else
 *   .ts / raw MPEG-TS mpegts.js where MSE exists; where it does not (iPhone) the panel's .m3u8
 *                    sibling is used instead, because Safari cannot decode a raw transport stream
 *                    at all — queueing it there was the old "plays in VLC, not in the app" bug
 *   .mp4 .m4v .mov   native <video>, byte-range seekable
 *   .mkv             the in-app Matroska remuxer (mkv.js) — parsed to fMP4 in JS, no server
 *   .avi .wmv .flv … the transcoder, which is the only thing that can play them in a browser
 *
 * Every address is also tried through the app's own CORS relay, because a panel that sends no
 * CORS headers fails the browser's very first read while playing perfectly in VLC.
 *
 * The module holds no app state and touches no globals of its own: everything it needs is injected
 * through configure(), and everything it reports goes back through the hooks passed to play().
 */
(function (global) {
  'use strict';

  var D = {};
  function configure(deps) { D = deps || {}; }

  /* ── capabilities ───────────────────────────────────────────────────────────────────────────
     Recomputed on every play(). hls.js may still be arriving from the CDN when the app boots, so
     a value cached at load time can be wrong for the rest of the session. */
  function caps(video) {
    var Hls = global.Hls;
    return {
      hlsjs:     !!(Hls && Hls.isSupported()),
      nativeHls: !!(video && (video.canPlayType('application/vnd.apple.mpegurl') ||
                              video.canPlayType('application/x-mpegURL'))),
      mpegts:    !!(global.mpegts && global.mpegts.isSupported()),
      mkv:       !!(global.Media26Mkv && global.Media26Mkv.supported()),
      apple:     /iphone|ipad|ipod/i.test((global.navigator && navigator.userAgent) || '')
    };
  }

  /* ── url shape ──────────────────────────────────────────────────────────────────────────── */
  var HLS_RE  = /\.m3u8(?:$|[?#])/i;
  var TS_EXT  = /^(ts|m2ts|mts|trp|mpg|mpeg)$/;
  var HARD_EXT= /^(mkv|avi|wmv|flv|vob|divx|ogm|rm|rmvb|3gp)$/;
  function extOf(u) { var m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(u || '')); return m ? m[1].toLowerCase() : ''; }
  function isHls(u) { return HLS_RE.test(String(u || '')); }

  /* ── 1. PLAN ────────────────────────────────────────────────────────────────────────────────
     item -> [{url, engine, label, transcode?}]  in the order this device should try them.

     An ADDRESS is one physical URL. enginesFor() decides which decoders can handle that address
     here, so an address the device cannot decode contributes nothing rather than burning a start
     budget. addAddress() then queues each engine against both the plain URL and the relayed one. */
  function plan(item, video) {
    var c = caps(video);
    var live = !!D.isLive(item);
    var out = [], seen = {};

    function add(engine, url, label, opts) {
      if (!url) return;
      var key = engine + ' ' + url;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ engine: engine, url: url, label: label || engine, transcode: !!(opts && opts.transcode) });
    }

    /* Which decoders can play this address on this device, best first. */
    function enginesFor(url) {
      var e = extOf(url), list = [];
      if (isHls(url)) {
        /* Apple decodes HLS in hardware — including HEVC and 4K, which hls.js cannot do through
           MSE — so native leads there and hls.js is the fallback. Elsewhere hls.js leads because
           it is the only HLS implementation Chrome/Firefox have. */
        if (c.apple && c.nativeHls) { list.push('native'); if (c.hlsjs) list.push('hls'); }
        else if (c.hlsjs)           { list.push('hls'); if (c.nativeHls) list.push('native'); }
        else if (c.nativeHls)       { list.push('native'); }
        return list;
      }
      if (TS_EXT.test(e)) {
        /* A raw transport stream needs mpegts.js, which needs MSE. Without it NOTHING in the
           browser can play this address — do not queue it. The .m3u8 sibling added below is the
           route that works there. */
        if (c.mpegts) list.push('mpegts');
        return list;
      }
      if (e === 'mkv') {
        if (c.mkv) list.push('mkv');
        list.push('native');           /* panels mislabel plain H.264/AAC files as .mkv */
        return list;
      }
      if (HARD_EXT.test(e)) return [];  /* avi/wmv/flv/… — transcoder only, appended at the end */
      /* mp4/m4v/mov/webm and anything unlabelled: hand it to the element. An extensionless link is
         usually a redirect shim to a real file, so it gets the same treatment. */
      list.push('native');
      if (!e && c.mpegts) list.push('mpegts');
      return list;
    }

    /* Queue one address: direct first when the browser is allowed to fetch it, then through the
       relay. The relay is not only a mixed-content workaround — it adds the CORS headers and the
       player User-Agent that panels demand, without which the engines' own fetch/XHR reads fail. */
    function addAddress(url, label) {
      if (!url) return;
      var engines = enginesFor(url);
      if (!engines.length) return;
      var direct = D.blocked(url) ? '' : url;
      var relay  = D.proxyUrl(url);
      for (var i = 0; i < engines.length; i++) {
        if (direct) add(engines[i], direct, label);
        if (relay && relay !== direct) add(engines[i], relay, label + ' relay');
      }
    }

    /* ---- addresses, in the order this item should be attempted ---- */
    var direct = String(D.streamUrlOf(item) || '').trim();
    var forms  = direct ? D.xtreamForms(direct) : null;
    var cont   = String(item.container_extension || '').replace(/^\./, '').toLowerCase();

    if (live) {
      /* Live leads with the continuous transport stream where a TS engine exists: one connection,
         no playlist polling, first frame almost immediately — the way VLC reads it. Where there is
         no TS engine, HLS leads instead. 4K/UHD on Apple always leads with HLS: mpegts.js decodes
         in software and combs an interlaced 4K picture. */
      var tsFirst = c.mpegts && !(c.apple && D.looks4k(item));
      var addrTs  = [], addrHls = [];
      if (direct && !isHls(direct)) addrTs.push(direct);
      if (direct && isHls(direct))  addrHls.push(direct);
      if (forms) { addrTs.push(forms.ts); addrHls.push(forms.m3u8); }
      var xTs = D.directUrl(item, 'ts'), xM3u8 = D.directUrl(item, 'm3u8');
      if (xTs) addrTs.push(xTs);
      if (xM3u8) addrHls.push(xM3u8);

      var order = tsFirst ? addrTs.concat(addrHls) : addrHls.concat(addrTs);
      for (var i = 0; i < order.length; i++) addAddress(order[i], 'live');
    } else {
      /* Movies and series: the real file first — it is the full-quality source and it seeks by
         byte range — then the panel's own HLS remux, which is fragmented and hardware-decodable
         and is what makes an HEVC title play on a phone, then the .mp4 sibling for a panel that
         gates the container its own playlist printed. */
      var addrs = [];
      if (direct) addrs.push(direct);
      var xCont = D.directUrl(item, cont || 'mp4');
      if (xCont) addrs.push(xCont);
      if (forms) { addrs.push(forms.m3u8); if (forms.ext !== 'mp4') addrs.push(forms.file('mp4')); }
      var xMp4 = D.directUrl(item, 'mp4'), xM3u = D.directUrl(item, 'm3u8');
      if (xMp4) addrs.push(xMp4);
      if (xM3u) addrs.push(xM3u);
      for (var j = 0; j < addrs.length; j++) addAddress(addrs[j], 'vod');
    }

    /* ---- the transcoder, last: it re-wraps anything into browser-playable HLS, and is the only
       route for a container no browser can decode. A 4K title with a quality ceiling set goes to
       the downscaling profile first so a phone is never handed 80 Mbit/s. ---- */
    if (D.transcoderBase && D.transcoderBase()) {
      var src = D.transcoderInput(item);
      if (src) {
        var qp = D.qualityProfile && D.qualityProfile();
        if (qp && D.looks4k(item)) add('hls', D.transcodeUrl(src, qp), 'transcoder', { transcode: true });
        if (live) {
          add('hls', D.transcodeUrl(src, 'remux'), 'transcoder', { transcode: true });
        } else {
          if (qp) add('hls', D.transcodeUrl(src, qp), 'transcoder', { transcode: true });
          add('hls', D.transcodeUrl(src, HARD_EXT.test(cont) ? 'fastvod' : 'vod'), 'transcoder', { transcode: true });
          add('hls', D.transcodeUrl(src, 'vod'), 'transcoder', { transcode: true });
        }
      }
    }
    return out;
  }

  /* ── 2. ENGINES ─────────────────────────────────────────────────────────────────────────────
     Uniform contract. start(ctx) attaches the source; the engine reports exactly one of
     ctx.onFail (could not start — move to the next candidate) or ctx.onDrop (was playing and
     died — reconnect in place). ctx.onStarted comes from the element, not the engine, so every
     engine agrees on what "playing" means. stop() must leave the element clean. */
  var Engines = {};

  Engines.native = {
    start: function (ctx) { ctx.video.src = ctx.url; ctx.video.load(); },
    stop:  function (ctx) { try { ctx.video.removeAttribute('src'); ctx.video.load(); } catch (e) {} }
  };

  Engines.hls = {
    start: function (ctx) {
      var Hls = global.Hls;
      if (!Hls || !Hls.isSupported()) { return Engines.native.start(ctx); }
      var h = new Hls({
        enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3,
        startFragPrefetch: true, maxBufferLength: 30, startLevel: -1,
        abrEwmaDefaultEstimate: D.mobile() ? 1200000 : 4000000
      });
      ctx.hls = h;
      D.onEngine && D.onEngine('hls', h);
      h.on(Hls.Events.ERROR, function (e, data) {
        if (!data || !data.fatal || !ctx.alive()) return;
        ctx.started() ? ctx.onDrop() : ctx.onFail('hls: ' + (data.details || data.type || 'fatal'));
      });
      h.on(Hls.Events.MANIFEST_PARSED, function () { if (ctx.alive()) ctx.onLevels(); });
      h.on(Hls.Events.LEVEL_SWITCHED, function () { if (ctx.alive()) ctx.onLevels(); });
      h.loadSource(ctx.url);
      h.attachMedia(ctx.video);
    },
    stop: function (ctx) {
      if (ctx.hls) { try { ctx.hls.destroy(); } catch (e) {} ctx.hls = null; D.onEngine && D.onEngine('hls', null); }
      Engines.native.stop(ctx);
    }
  };

  Engines.mpegts = {
    start: function (ctx) {
      var mpegts = global.mpegts;
      if (!mpegts || !mpegts.isSupported()) return ctx.onFail('no TS engine on this device');
      /* A small initial stash lets the first packets decode immediately instead of waiting for a
         full buffer, which is what makes live open quickly. VOD keeps a larger one. */
      var p = mpegts.createPlayer(
        { type: 'mpegts', isLive: ctx.live, url: ctx.url, cors: true },
        { enableWorker: true, lazyLoad: false, isLive: ctx.live, enableStashBuffer: true,
          stashInitialSize: ctx.live ? (D.mobile() ? 24 * 1024 : 32 * 1024)
                                     : (D.mobile() ? 128 * 1024 : 256 * 1024),
          liveBufferLatencyChasing: false, autoCleanupSourceBuffer: true });
      ctx.ts = p;
      D.onEngine && D.onEngine('ts', p);
      p.on(mpegts.Events.ERROR, function (a, b, c) {
        if (!ctx.alive()) return;
        ctx.started() ? ctx.onDrop() : ctx.onFail('ts: ' + (c && c.msg || b || a || 'error'));
      });
      p.attachMediaElement(ctx.video);
      p.load();
    },
    stop: function (ctx) {
      if (ctx.ts) {
        try { ctx.ts.pause(); ctx.ts.unload(); ctx.ts.detachMediaElement(); ctx.ts.destroy(); } catch (e) {}
        ctx.ts = null; D.onEngine && D.onEngine('ts', null);
      }
      Engines.native.stop(ctx);
    }
  };

  /* In-app Matroska: parsed and remuxed to fragmented MP4 in JavaScript, fed to this same element,
     so the device's own decoder plays it with nothing re-encoded and no server involved. Only
     H.264/HEVC with AAC survives a pure remux; anything else fails fast to the transcoder. */
  Engines.mkv = {
    start: function (ctx) {
      if (!global.Media26Mkv || !global.Media26Mkv.supported()) return ctx.onFail('no in-app Matroska engine');
      global.Media26Mkv.play(ctx.video, ctx.url, {
        onInfo: function (info) {
          if (!ctx.alive() || !info) return;
          /* The header carries the real resolution, which catches a 4K file the provider never
             labelled — above the ceiling, hand it to the downscaling transcoder instead. */
          var vt = (info.tracks || []).filter(function (t) { return t.type === 'video'; })[0];
          if (vt && (vt.width || 0) >= 2560 && D.qualityProfile && D.qualityProfile()) {
            ctx.stopSelf(); ctx.onFail('4K source — switching to the downscaled stream'); return;
          }
          if (info.audioDropped) D.toast && D.toast('Playing video — this file’s audio track was rejected by the device.');
          else if (info.unsupportedAudio) D.toast && D.toast('Playing video — this file’s ' + String(info.unsupportedAudio).replace(/^A_/, '') + ' audio can’t be decoded in-app.');
        }
      }).catch(function (e) {
        if (!ctx.alive()) return;
        ctx.onFail('in-app Matroska: ' + ((e && e.message) || 'unsupported'));
      });
    },
    stop: function (ctx) {
      try { if (ctx.video.__mkvStop) { ctx.video.__mkvStop(); ctx.video.__mkvStop = null; } } catch (e) {}
      Engines.native.stop(ctx);
    }
  };

  /* ── 3. SUPERVISOR ──────────────────────────────────────────────────────────────────────────
     Owns the plan and the lifecycle. One instance per play() call, guarded by a token so a stale
     attempt that is still inside an await can never touch the element after a newer tap. */

  /* The transcoder's /hls endpoint blocks while ffmpeg builds the first segment, and a free host
     needs 30-50s to wake — far longer than any player's manifest timeout. Poll for a ready
     playlist with our own deadline first, then hand the resolved URL to the HLS engine. */
  function resolveTranscode(ctx, url, done) {
    var deadline = Date.now() + 120000;
    function describe(r) {
      var why = 'server returned ' + r.status;
      return r.clone().json().then(function (j) {
        var raw = String((j && (j.log || j.error)) || '');
        var tail = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).slice(-2).join(' · ');
        return tail ? why + ' — ' + tail.slice(-180) : why;
      }).catch(function () { return why; });
    }
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!ctx.alive()) return;
      var manifest = r.url || url;
      if (!r.ok && r.status !== 503) return describe(r).then(function (w) { ctx.onFail('transcoder: ' + w); });
      (function poll() {
        if (!ctx.alive()) return;
        fetch(manifest, { cache: 'no-store' }).then(function (m) {
          if (!ctx.alive()) return;
          if (m.ok) return m.text().then(function (t) {
            if (!ctx.alive()) return;
            if (/#EXTINF/.test(t)) return done(manifest);
            setTimeout(poll, 2000);
          });
          if (m.status !== 503 && m.status !== 404) return describe(m).then(function (w) { ctx.onFail('transcoder: ' + w); });
          setTimeout(poll, 2000);
        }).catch(function () { setTimeout(poll, 2000); });
        if (Date.now() > deadline) ctx.onFail('transcoder: no video produced in time (it may be waking up — try again in ~30s)');
      })();
    }).catch(function (e) {
      if (ctx.alive()) ctx.onFail('transcoder: unreachable (' + ((e && e.message) || 'network') + ')');
    });
  }

  function Session(item, video, hooks, token) {
    this.item = item; this.video = video; this.hooks = hooks || {}; this.token = token;
    this.live = !!D.isLive(item);
    this.plans = []; this.idx = 0;
    /* `playing` is per-ATTEMPT (reset on every attach) and drives the start budget; `everPlayed`
       is per-SESSION and decides the meaning of a failure — a route that has never produced
       picture is dead and we move on, while one that has is a drop and we reconnect in place. */
    this.startedAt = 0; this.attachAt = 0; this.playing = false; this.everPlayed = false;
    this.lastT = 0; this.lastProgress = Date.now();
    this.reconnects = 0; this.drops = []; this.lastReconnect = 0; this.cleanSince = Date.now();
    this.reason = ''; this.beat = null; this.ctx = null;
  }

  Session.prototype.alive = function () { return D.token() === this.token; };

  Session.prototype.say = function (state, text) {
    if (this.alive() && this.hooks.onState) this.hooks.onState(state, text);
  };

  Session.prototype.start = function () {
    var self = this;
    this.plans = plan(this.item, this.video).filter(function (p) { return p && p.url; });
    if (!this.plans.length) { this.fail(D.noRouteReason ? D.noRouteReason(this.item) : ''); return; }
    this.attach(0);
    /* A self-rescheduling timeout, not an interval: the app cancels this handle with
       clearTimeout() from its own cleanup(), so the two must be the same kind of timer. */
    (function beat() {
      self.beat = setTimeout(function () { self.tick(); if (self.beat) beat(); }, 1000);
      D.onTimer && D.onTimer(self.beat);
    })();
  };

  Session.prototype.stop = function () {
    if (this.beat) { clearTimeout(this.beat); this.beat = null; }
    this.detach();
  };

  Session.prototype.detach = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    var eng = Engines[ctx.engine];
    try { if (eng) eng.stop(ctx); } catch (e) {}
  };

  /* Attach candidate i. Everything an engine may touch lives on ctx, so stop() can always undo it. */
  Session.prototype.attach = function (i) {
    var self = this, p = this.plans[i];
    if (!this.alive() || !p) return;
    this.idx = i;
    this.detach();
    this.attachAt = Date.now();
    this.playing = false;

    var v = this.video;
    v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.autoplay = true; v.loop = false; v.preload = 'auto';
    /* the previous engine's handlers must never survive into this attempt */
    v.onwaiting = v.onstalled = v.onsuspend = v.ontimeupdate = null;

    var ctx = this.ctx = {
      engine: p.engine, url: p.url, video: v, live: this.live, hls: null, ts: null,
      alive:   function () { return self.alive() && self.ctx === ctx; },
      started: function () { return self.everPlayed; },
      onLevels:function () { self.hooks.onLevels && self.hooks.onLevels(); },
      onFail:  function (why) { if (ctx.alive()) self.next(why); },
      onDrop:  function ()    { if (ctx.alive()) self.reconnect(); },
      stopSelf:function ()    { var e = Engines[ctx.engine]; try { if (e) e.stop(ctx); } catch (x) {} }
    };

    v.onplaying = function () {
      if (!ctx.alive() || self.playing) return;
      self.playing = true; self.everPlayed = true; self.startedAt = Date.now();
      self.say('playing');
      self.hooks.onStarted && self.hooks.onStarted(p);
    };
    v.onerror = function () {
      if (!ctx.alive()) return;
      self.everPlayed ? self.reconnect() : self.next('the browser could not decode this stream');
    };

    /* Movies and series resume where they were left, once the media knows its duration. */
    if (!this.live) {
      var at = D.getResume ? (D.getResume(this.item) || 0) : 0;
      if (at > 5) {
        var seek = function () {
          try { if ((v.currentTime || 0) < 1.5) v.currentTime = at; } catch (e) {}
          v.removeEventListener('loadedmetadata', seek);
        };
        v.addEventListener('loadedmetadata', seek);
      }
    }

    this.say('loading', p.label);

    var run = function (engineName, url) {
      ctx.engine = engineName; ctx.url = url;
      try { Engines[engineName].start(ctx); }
      catch (e) { return self.next((e && e.message) || 'engine failed to start'); }
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () {
        if (!ctx.alive()) return;
        /* Unmuted autoplay was refused. Play muted rather than stall, and let the app re-enable
           sound on the next interaction. */
        v.muted = true;
        D.onAutoplayMuted && D.onAutoplayMuted();
        var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {});
      });
    };

    if (p.transcode) { this.say('loading', 'preparing'); resolveTranscode(ctx, p.url, function (m) { if (ctx.alive()) run('hls', m); }); }
    else run(p.engine, p.url);
  };

  Session.prototype.next = function (why) {
    if (!this.alive()) return;
    if (why) this.reason = why;
    if (this.idx + 1 >= this.plans.length) { this.fail(this.reason); return; }
    this.attach(this.idx + 1);
  };

  Session.prototype.fail = function (why) {
    if (!this.alive()) return;
    this.stop();
    this.say('failed', why || this.reason);
    this.hooks.onFailed && this.hooks.onFailed(why || this.reason);
  };

  /* Reconnect the CURRENT candidate in place — live rejoins the edge, a movie keeps its position.
     This is what keeps a dedicated IPTV app alive through a blip, and it never switches to a worse
     stream, so it cannot loop. Repeated drops mean the route itself is bad: move on instead. */
  Session.prototype.reconnect = function () {
    if (!this.alive()) return;
    var now = Date.now(), v = this.video;
    /* A user seek is not a failure: the element briefly errors and stalls while it fetches the new
       position. Reloading there is what used to snap a movie back to 0:00. */
    if (!this.live && (v.seeking || (now - (D.getLastSeekAt ? D.getLastSeekAt() : 0)) < 12000)) {
      this.lastProgress = now; this.lastT = v.currentTime || 0; return;
    }
    if (now - this.lastReconnect < 3000) return;
    this.drops = this.drops.filter(function (t) { return now - t < 60000; });
    this.drops.push(now);
    var limit = this.live ? 2 : 3;
    if (this.drops.length >= limit && this.idx + 1 < this.plans.length) {
      this.drops = []; this.reconnects = 0; this.lastReconnect = now; this.lastProgress = now;
      this.say('switching');
      this.attach(this.idx + 1);
      return;
    }
    if (this.reconnects >= 40) { this.fail('the stream kept dropping'); return; }
    this.lastReconnect = now; this.reconnects++; this.lastProgress = now; this.lastT = v.currentTime || 0;
    this.say('reconnecting');
    var keep = (!this.live && v.currentTime > 0) ? v.currentTime : 0;
    this.attach(this.idx);
    if (keep > 0) {
      var restore = function () { try { v.currentTime = keep; } catch (e) {} v.removeEventListener('loadedmetadata', restore); };
      v.addEventListener('loadedmetadata', restore);
    }
  };

  /* One calm 1s heartbeat is the only watchdog: it moves on from a candidate that never starts,
     and reconnects one that started and then froze. It never touches a healthy stream. */
  Session.prototype.tick = function () {
    /* A newer tap bumped the token — this session is history. Stand down without touching the
       element, which the newer session now owns. */
    if (!this.alive()) { if (this.beat) { clearTimeout(this.beat); this.beat = null; } return; }
    var v = this.video, now = Date.now();
    if (Math.abs((v.currentTime || 0) - this.lastT) > 0.25) {
      this.lastT = v.currentTime || 0; this.lastProgress = now;
      if (now - this.cleanSince > 30000) { this.reconnects = 0; this.cleanSince = now; }
    } else if (this.playing) { this.cleanSince = now; }

    if (!this.playing) {
      var p = this.plans[this.idx], last = this.idx >= this.plans.length - 1;
      /* The transcoder may be cold-starting on a free host; the last candidate gets a long grace so
         a big first frame can buffer; everything else fails fast so the plan is walked quickly. */
      var budget = p && p.transcode ? 60000 : (this.live ? 14000 : (last ? 38000 : 12000));
      if (this.attachAt && now - this.attachAt > budget) this.next('“' + (p && p.label || 'this route') + '” did not start in time');
      return;
    }
    if (!v.paused && !v.ended && !v.seeking &&
        (now - (D.getLastSeekAt ? D.getLastSeekAt() : 0)) > 12000 &&
        now - this.lastProgress > 9000) this.reconnect();
  };

  /* ── public API ─────────────────────────────────────────────────────────────────────────── */
  var current = null;

  function play(item, hooks) {
    if (current) { try { current.stop(); } catch (e) {} current = null; }
    var video = D.video();
    var s = new Session(item, video, hooks, D.token());
    current = s;
    s.start();
    return s;
  }
  function stop() { if (current) { try { current.stop(); } catch (e) {} current = null; } }

  global.Media26Player = {
    configure: configure,
    play: play,
    stop: stop,
    plan: plan,          /* exported so the plan can be inspected and tested on its own */
    caps: caps
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Media26Player;
})(typeof window !== 'undefined' ? window : globalThis);
