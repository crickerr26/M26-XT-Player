/* Player 2 — the always-works fallback player.
 *
 * M26 Player 2 (m26player2.js) plays a title AS THE PROVIDER SENT IT — probing the real bytes,
 * picking the decoder the format and this device actually support, remuxing Matroska in JS when
 * it can. That is the fast path and it is right most of the time, but it still depends on this
 * browser having a decoder for whatever the provider actually serves: AC-3/DTS audio in an MKV,
 * an old codec, a container nothing in-app can demux. When none of that lines up, Player 1 gives
 * up and used to hand the customer straight to VLC/KMPlayer — leaving the app.
 *
 * Player 2 does not try to be clever about the source. It asks the transcoder to re-encode the
 * title into plain H.264/AAC HLS — a format every engine here (native on Apple, hls.js
 * everywhere else) can always play — and plays THAT. It never inspects the source bytes, never
 * picks between engines, never remuxes anything itself: one job, one path, so a failure in
 * Player 1's decoder selection can never also be a failure here. It is deliberately independent
 * of m26player2.js — no shared state, no shared code path — so the two really are two different
 * chances at the same title, not one engine with an extra branch.
 *
 * Requires a transcoder (see transcoderBase() in index.html) to be configured and reachable. On a
 * device with no transcoder set, Player 2 has nothing to try and fails immediately rather than
 * pretending — the caller decides what to do next (show VLC/KMPlayer, as before).
 *
 * Same shape as M26 Player 2 on purpose: configure(deps), play(item, hooks), stop(). Whatever
 * calls this can swap between the two without knowing which one is running.
 */
(function (global) {
  'use strict';

  var D = {};
  function configure(deps) { D = deps || {}; }

  var POLL_MS = 2000;
  var WAKE_DEADLINE_MS = 150000;   /* generous and independent of whatever budget Player 1 spent —
                                       a fresh attempt gets a fresh cold-start allowance */
  var STALL_MS = 10000;
  var START_BUDGET_MS = 45000;
  var MAX_RECOVERIES = 8;

  function isApple() { return /iphone|ipad|ipod/i.test((global.navigator && navigator.userAgent) || ''); }
  function nativeHls(video) {
    return !!(video && (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')));
  }
  function hlsjsOk() { var Hls = global.Hls; return !!(Hls && Hls.isSupported()); }

  /* Same tolerant read as Player 1's transcoder wait: a free-tier host answers a whole family of
     "still booting" statuses (its own 502/503/504, plus Cloudflare's 522-524 pass-through timeouts)
     before it is actually up, and none of those are the transcoder's final answer. */
  function stillWaking(status) {
    return !status || status === 408 || status === 502 || status === 503 || status === 504
      || status === 522 || status === 523 || status === 524;
  }

  /* Every profile worth trying, most-likely-to-succeed first. A resource limit or a bad encode on
     one tier does not take the whole attempt down — the next profile is a genuinely fresh request. */
  function profiles(item, live) {
    var out = [];
    var qp = D.qualityProfile && D.qualityProfile();
    if (live) { out.push('remux'); }
    else {
      if (qp && D.looks4k && D.looks4k(item)) out.push(qp);
      out.push('fastvod', 'vod');
    }
    return out;
  }

  function Session(item, video, hooks, token) {
    this.item = item; this.video = video; this.hooks = hooks || {}; this.token = token;
    this.live = !!(D.isLive && D.isLive(item));
    this.queue = profiles(item, this.live);
    this.recoveries = 0; this.everPlayed = false; this.playing = false;
    this.lastT = 0; this.lastProgress = Date.now(); this.attachedAt = 0;
    this.beat = null; this.hls = null; this.reason = ''; this.currentUrl = '';
  }

  Session.prototype.alive = function () { return !!(D.token) && D.token() === this.token; };
  Session.prototype.to = function (state, detail) { if (this.alive() && this.hooks.onState) this.hooks.onState(state, detail); };
  Session.prototype.note = function (why) { if (why) this.reason = why; };

  Session.prototype.start = function () {
    var self = this;
    var src = (D.transcoderBase && D.transcoderBase() && D.transcoderInput) ? D.transcoderInput(this.item) : '';
    if (!src) return this.giveUp('no transcoder is configured on this device');
    this.src = src;
    (function beat() {
      self.beat = setTimeout(function () { self.tick(); if (self.beat) beat(); }, 1000);
      D.onTimer && D.onTimer(self.beat);
    })();
    this.next();
  };

  Session.prototype.stop = function () {
    if (this.beat) { clearTimeout(this.beat); this.beat = null; }
    this.release();
  };

  Session.prototype.release = function () {
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; D.onEngine && D.onEngine('hls', null); }
    try { this.video.removeAttribute('src'); this.video.load(); } catch (e) {}
  };

  Session.prototype.next = function () {
    if (!this.alive()) return;
    var profile = this.queue.shift();
    if (!profile) return this.giveUp(this.reason || 'the transcoder could not produce a playable stream');
    this.to('loading', 'transcoding (' + profile + ')');
    var url = D.transcodeUrl(this.src, profile);
    if (!url) return this.next();
    this.awaitReady(url);
  };

  Session.prototype.awaitReady = function (manifestUrl) {
    var self = this, deadline = Date.now() + WAKE_DEADLINE_MS;
    function poll(url) {
      if (!self.alive()) return;
      if (Date.now() > deadline) { self.note('transcoder: taking too long to start'); return self.next(); }
      fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!self.alive()) return;
        if (r.ok) {
          return r.text().then(function (t) {
            if (!self.alive()) return;
            if (/#EXTINF/.test(t)) return self.attach(url);
            setTimeout(function () { poll(url); }, POLL_MS);
          });
        }
        /* 404 stays in the polling set: ffmpeg has started but not written the playlist yet. */
        if (stillWaking(r.status) || r.status === 404) return setTimeout(function () { poll(url); }, POLL_MS);
        self.note('transcoder: server returned ' + r.status); self.next();
      }).catch(function () { if (self.alive()) setTimeout(function () { poll(url); }, POLL_MS); });
    }
    poll(manifestUrl);
  };

  Session.prototype.attach = function (url) {
    var self = this, v = this.video;
    if (!this.alive()) return;
    this.release();
    this.playing = false; this.attachedAt = Date.now(); this.currentUrl = url;
    this.to('loading', 'starting');

    v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.autoplay = true; v.loop = false; v.preload = 'auto';
    v.onwaiting = v.onstalled = v.onsuspend = v.ontimeupdate = null;

    var useNative = isApple() && nativeHls(v);
    try {
      v.disableRemotePlayback = !useNative;
      if (useNative) { v.removeAttribute('disableremoteplayback'); v.setAttribute('x-webkit-airplay', 'allow'); }
      else { v.setAttribute('disableremoteplayback', ''); v.removeAttribute('x-webkit-airplay'); }
    } catch (e) {}

    v.onplaying = function () {
      if (!self.alive() || self.playing) return;
      self.playing = true; self.everPlayed = true;
      self.to('playing'); self.hooks.onStarted && self.hooks.onStarted();
    };
    v.onerror = function () {
      if (!self.alive()) return;
      if (self.everPlayed) return self.recover();
      self.note('the browser refused this stream'); self.next();
    };

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

    if (useNative) {
      v.src = url; v.load();
    } else if (hlsjsOk()) {
      var Hls = global.Hls;
      var h = new Hls({
        enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3,
        startFragPrefetch: true, maxBufferLength: 30, startLevel: -1,
        abrEwmaDefaultEstimate: (D.mobile && D.mobile()) ? 1200000 : 4000000
      });
      this.hls = h; D.onEngine && D.onEngine('hls', h);
      h.on(Hls.Events.ERROR, function (e, data) {
        if (!data || !data.fatal || !self.alive()) return;
        if (self.everPlayed) return self.recover();
        self.note('HLS: ' + (data.details || data.type || 'fatal error')); self.next();
      });
      h.on(Hls.Events.MANIFEST_PARSED, function () { if (self.alive()) self.hooks.onLevels && self.hooks.onLevels(); });
      h.on(Hls.Events.LEVEL_SWITCHED, function () { if (self.alive()) self.hooks.onLevels && self.hooks.onLevels(); });
      h.loadSource(url); h.attachMedia(v);
    } else if (nativeHls(v)) {
      v.src = url; v.load();
    } else {
      this.note('this device has no HLS decoder'); return this.next();
    }

    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () {
      if (!self.alive()) return;
      v.muted = true; D.onAutoplayMuted && D.onAutoplayMuted();
      var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {});
    });
  };

  /* Recover the CURRENT transcoded stream in place, same discipline as Player 1: a user seek is
     not a failure, and repeated drops move on to the next profile rather than looping forever. */
  Session.prototype.recover = function () {
    if (!this.alive()) return;
    var now = Date.now(), v = this.video;
    if (!this.live && (v.seeking || (now - (D.getLastSeekAt ? D.getLastSeekAt() : 0)) < 12000)) {
      this.lastProgress = now; this.lastT = v.currentTime || 0; return;
    }
    if (this.recoveries >= MAX_RECOVERIES) { this.note('the stream kept dropping'); return this.next(); }
    this.recoveries++; this.lastProgress = now; this.lastT = v.currentTime || 0;
    this.to('recovering');
    var keep = (!this.live && v.currentTime > 0) ? v.currentTime : 0;
    var url = this.currentUrl, v2 = this.video;
    this.attach(url);
    if (keep > 0) {
      var restore = function () { try { v2.currentTime = keep; } catch (e) {} v2.removeEventListener('loadedmetadata', restore); };
      v2.addEventListener('loadedmetadata', restore);
    }
  };

  Session.prototype.tick = function () {
    if (!this.alive()) { if (this.beat) { clearTimeout(this.beat); this.beat = null; } return; }
    var v = this.video, now = Date.now();
    if (Math.abs((v.currentTime || 0) - this.lastT) > 0.25) { this.lastT = v.currentTime || 0; this.lastProgress = now; }
    if (!this.playing) {
      if (this.attachedAt && now - this.attachedAt > START_BUDGET_MS) { this.note('this route did not start in time'); this.next(); }
      return;
    }
    if (!v.paused && !v.ended && !v.seeking &&
        (now - (D.getLastSeekAt ? D.getLastSeekAt() : 0)) > 12000 &&
        now - this.lastProgress > STALL_MS) this.recover();
  };

  Session.prototype.giveUp = function (why) {
    if (!this.alive()) return;
    this.stop();
    this.to('failed', why || this.reason);
    this.hooks.onFailed && this.hooks.onFailed(why || this.reason);
  };

  var live = null;
  function play(item, hooks) {
    if (live) { try { live.stop(); } catch (e) {} live = null; }
    var s = new Session(item, D.video(), hooks, D.token());
    live = s; s.start(); return s;
  }
  function stop() { if (live) { try { live.stop(); } catch (e) {} live = null; } }

  global.M26PlayerTwo = {
    name: 'Player 2',
    configure: configure,
    play: play,
    stop: stop
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.M26PlayerTwo;
})(typeof window !== 'undefined' ? window : globalThis);
