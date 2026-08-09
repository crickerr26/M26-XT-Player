/* M26 Player 2 — the inbuilt player.
 *
 * Replaces the Media26 inbuilt player entirely. The old engine picked a decoder from the file
 * extension in the URL and then waited 12-38 seconds per candidate to discover whether the guess
 * was right. On IPTV that guess is wrong constantly: panels serve HEVC-in-Matroska under a .mp4
 * name, hand out extensionless links that are really HLS, publish a .ts that 404s, and answer some
 * addresses with an HTML error page carrying a 200. Every one of those cost most of a minute
 * before anything else was tried, and the reason was never visible.
 *
 * M26 Player 2 asks instead of guessing. Before a decoder is chosen, one small ranged request
 * fetches the first two kilobytes of the stream and the format is read from the bytes themselves:
 *
 *     #EXTM3U                     -> HLS
 *     0x47 at 0, 188 and 376      -> MPEG-TS   (the transport stream sync pattern)
 *     'ftyp' at offset 4          -> MP4 / MOV
 *     1A 45 DF A3                 -> Matroska / WebM
 *
 * That single request settles four things a URL cannot: whether the address exists at all, what it
 * really contains, whether this browser is allowed to read it (a CORS refusal shows up here, not
 * forty seconds later inside a decoder), and therefore which decoder can play it. A dead candidate
 * is dropped in about a fifth of a second instead of most of a minute, and a mislabelled file
 * reaches the right decoder on the first attempt rather than the fourth.
 *
 * Probing is strictly an optimisation and never a requirement. It runs under a hard deadline, is
 * aborted the moment it has an answer, and on any failure — timeout, no range support, an opaque
 * response — playback proceeds on the extension-based guess exactly as before. Live TV with a
 * working transport-stream decoder skips the probe entirely: the format is not in doubt there, it
 * is the most latency-sensitive content, and it is where a provider's single-connection limit is
 * least forgiving of an extra socket.
 *
 * Structure — four parts, each replaceable on its own:
 *
 *   CATALOG    an item becomes an ordered list of candidate addresses. Pure data.
 *   PROBE      an address becomes hard evidence: reachable? what format? readable from here?
 *   ENGINES    native <video>, hls.js, native HLS, mpegts.js, in-app Matroska, transcoder —
 *              each behind one start()/stop() interface, selected by DETECTED format.
 *   MACHINE    an explicit state machine: resolving, probing, loading, playing, recovering,
 *              failed. Every transition is named, so a failure can always say what it was doing.
 *
 * The module owns no application state and reads no globals of its own. Everything it needs comes
 * in through configure(); everything it reports goes out through the hooks passed to play().
 */
(function (global) {
  'use strict';

  var D = {};
  function configure(deps) { D = deps || {}; }

  var PROBE_BUDGET_MS = 2500;   /* a probe that has not answered by now is not worth waiting for */
  var PROBE_BYTES     = 2048;   /* enough for every signature below, small enough to be free */
  var SETTLE_MS       = 200;    /* let a single-connection panel release the probe's slot */

  /* ── capabilities ───────────────────────────────────────────────────────────────────────────
     Read fresh on every play(): hls.js may still be arriving from the CDN when the app boots, so a
     value captured at load time can be wrong for the rest of the session. */
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

  /* ── formats ────────────────────────────────────────────────────────────────────────────── */
  var HLS = 'hls', TS = 'mpegts', MP4 = 'mp4', MKV = 'matroska', UNKNOWN = 'unknown';

  function extOf(u) { var m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(u || '')); return m ? m[1].toLowerCase() : ''; }

  /* What the URL claims. Used before a probe, and whenever a probe cannot answer. */
  function formatFromUrl(u) {
    var e = extOf(u);
    if (/\.m3u8(?:$|[?#])/i.test(String(u || ''))) return HLS;
    if (/^(ts|m2ts|mts|trp|mpg|mpeg)$/.test(e)) return TS;
    if (/^(mp4|m4v|mov|webm|m4a|mp3|aac)$/.test(e)) return MP4;
    if (/^(mkv)$/.test(e)) return MKV;
    if (/^(avi|wmv|flv|vob|divx|ogm|rm|rmvb|3gp)$/.test(e)) return 'hard';
    return UNKNOWN;
  }

  /* What the bytes say. This is the evidence the whole design rests on. */
  function formatFromBytes(bytes, contentType) {
    var b = bytes || new Uint8Array(0);
    if (b.length >= 7) {
      /* #EXTM3U, allowing for a UTF-8 BOM or leading whitespace */
      var i = 0;
      if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) i = 3;
      while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0A || b[i] === 0x0D)) i++;
      if (b[i] === 0x23 && b[i + 1] === 0x45 && b[i + 2] === 0x58 && b[i + 3] === 0x54 &&
          b[i + 4] === 0x4D && b[i + 5] === 0x33 && b[i + 6] === 0x55) return HLS;
    }
    if (b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return MKV;
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return MP4;
    /* MPEG-TS: 0x47 every 188 bytes. Two hits is already conclusive; three is certain. */
    if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return TS;
    if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return TS;
    var ct = String(contentType || '').toLowerCase();
    if (/mpegurl/.test(ct)) return HLS;
    if (/mp2t/.test(ct)) return TS;
    if (/matroska/.test(ct)) return MKV;
    if (/mp4|quicktime/.test(ct)) return MP4;
    return UNKNOWN;
  }

  /* ── PROBE ──────────────────────────────────────────────────────────────────────────────────
     One ranged request, aborted as soon as it has answered. Resolves to
     {ok, status, format, contentType, error} and NEVER rejects — a probe that cannot answer must
     not be able to stop playback. */
  function probe(url) {
    return new Promise(function (resolve) {
      var done = false, ctl = null;
      function finish(r) { if (done) return; done = true; try { ctl && ctl.abort(); } catch (e) {} resolve(r); }
      var timer = setTimeout(function () { finish({ ok: false, status: 0, format: UNKNOWN, error: 'timed out' }); }, PROBE_BUDGET_MS);

      try { ctl = new AbortController(); } catch (e) { ctl = null; }
      var opts = { cache: 'no-store', headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) } };
      if (ctl) opts.signal = ctl.signal;

      fetch(url, opts).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        /* 200 and 206 are both fine — plenty of panels ignore Range and send the whole body, which
           is exactly why the request is aborted the instant enough bytes have arrived. */
        if (!res.ok && res.status !== 206) {
          clearTimeout(timer);
          return finish({ ok: false, status: res.status, format: UNKNOWN, contentType: ct, error: 'HTTP ' + res.status });
        }
        function settle(bytes) {
          clearTimeout(timer);
          finish({ ok: true, status: res.status, contentType: ct, format: formatFromBytes(bytes, ct) });
        }
        /* Stream the first chunk where possible so a panel that ignores Range does not make us
           download a whole film to identify it. */
        if (res.body && res.body.getReader) {
          var reader = res.body.getReader(), acc = new Uint8Array(PROBE_BYTES), n = 0;
          (function pump() {
            reader.read().then(function (r) {
              if (done) return;
              if (r.value && r.value.length) {
                var take = Math.min(r.value.length, PROBE_BYTES - n);
                acc.set(r.value.subarray(0, take), n); n += take;
              }
              if (r.done || n >= 377 || (r.done && n)) return settle(acc.subarray(0, n));
              if (n >= PROBE_BYTES) return settle(acc);
              pump();
            }).catch(function () { if (!done) settle(acc.subarray(0, n)); });
          })();
        } else {
          res.arrayBuffer().then(function (buf) { settle(new Uint8Array(buf).subarray(0, PROBE_BYTES)); })
                           .catch(function () { settle(new Uint8Array(0)); });
        }
      }).catch(function (e) {
        clearTimeout(timer);
        /* A network-level rejection here is usually CORS or mixed content — which is precisely the
           thing that used to surface as an unexplained decoder failure much later. */
        finish({ ok: false, status: 0, format: UNKNOWN, error: (e && e.name === 'AbortError') ? 'aborted' : ((e && e.message) || 'blocked') });
      });
    });
  }

  /* ── CATALOG ────────────────────────────────────────────────────────────────────────────────
     item -> ordered candidate addresses. Deliberately format-agnostic: which decoder plays an
     address is decided later, from evidence, not from the name. */
  function catalog(item, video) {
    var c = caps(video), live = !!D.isLive(item), out = [], seen = {};

    function add(url, opts) {
      if (!url || seen[url]) return;
      seen[url] = 1;
      out.push({
        url: url,
        claim: (opts && opts.claim) || formatFromUrl(url),
        label: (opts && opts.label) || 'stream',
        transcode: !!(opts && opts.transcode),
        noProbe: !!(opts && opts.noProbe)
      });
    }
    /* Direct first when the browser is allowed the address, then through the app's relay, which
       supplies the CORS headers and the player User-Agent panels expect. */
    /* ── v19.28: THE MAG PASS-THROUGH RELAY, WHICH THIS ENGINE NEVER HAD. ──────────────────────
       index.html's plan() learned in v16.6 that a MAG stream node BLOCKS CLOUDFLARE: measured
       against a live portal, the stream host answers the app's own /proxy — which runs on
       Cloudflare — with "error code: 1003" / 403, while the transcoder's plain pass-through /proxy
       (ordinary hosting, a normal IP) fetches the very same link with HTTP 200. So plan() leads a
       Stalker stream with that relay.
       This engine builds its own catalogue and was never given that knowledge, so on a MAG portal
       it offered exactly two routes that cannot work — the raw cross-origin address (no CORS) and
       the Cloudflare relay (1003) — before falling through to a full ffmpeg transcode on a free
       instance. That is why Player 1 would not play here while the same link was fine elsewhere.
       It is a plain relay, not a re-encode: same bytes, different egress IP. Nothing about the MAC,
       the handshake or the token is involved — this is purely which address the video is fetched
       from once the portal has already issued the link. */
    function streamRelay(url) {
      if (!url || !D.streamRelayUrl) return '';
      try { return D.streamRelayUrl(url, item) || ''; } catch (e) { return ''; }
    }
    var useStreamRelayFirst = !!(D.isMag && D.isMag(item));
    function addStreamRelay(url, label) {
      var sr = streamRelay(url);
      if (sr) add(sr, { label: label + ' via stream relay', claim: formatFromUrl(url) });
    }
    function addPair(url, label) {
      if (!url) return;
      if (useStreamRelayFirst) addStreamRelay(url, label);
      if (!D.blocked(url)) add(url, { label: label });
      var relay = D.proxyUrl(url);
      if (relay) add(relay, { label: label + ' via relay', claim: formatFromUrl(url) });
      if (!useStreamRelayFirst) addStreamRelay(url, label);
    }

    var direct = String(D.streamUrlOf(item) || '').trim();
    /* v19.67: tell xtreamForms which section this item belongs to. Extensionless playlist links
       carry only /user/pass/id, so omitting the type rewrites Movies/Series as /live/... siblings. */
    var itemType = live ? 'live' : String((item && item._type) || '').toLowerCase();
    var forms  = (direct && D.xtreamForms) ? D.xtreamForms(direct, itemType) : null;
    var cont   = String(item.container_extension || '').replace(/^\./, '').toLowerCase();

    if (live) {
      /* A transport stream is one continuous connection with no playlist polling — the fastest
         start and the way VLC reads a channel — so it leads wherever a TS decoder exists. Without
         one nothing in the browser can decode a raw transport stream at all, and the panel's HLS
         form is the only thing that can play.
         v18.2: that used to read "an iPhone has no Media Source Extensions", which stopped being
         true at iOS 17.1 — ManagedMediaSource is one, mpegts.js 1.8 uses it, and c.mpegts asks the
         library rather than the user agent. An iPhone on a current OS now decodes a raw .ts in the
         inbuilt player like every other device, which is what removes the transcoder from the
         critical path for live TV. Older iPhones still report false here and keep the HLS form. */
      var tsFirst = c.mpegts && !(c.apple && D.looks4k(item));
      var ts = [], hls = [];
      if (forms) { ts.push(forms.ts); hls.push(forms.m3u8); }
      var xt = D.directUrl(item, 'ts'), xm = D.directUrl(item, 'm3u8');
      if (xt) ts.push(xt);
      if (xm) hls.push(xm);
      var order = tsFirst ? ts.concat(hls) : hls.concat(ts);
      /* THE ADDRESS THE PROVIDER PRINTED GOES FIRST. Everything else in this list is a form the
         app DERIVED from it — the sibling .ts/.m3u8 that rescues a panel gating its own legacy
         link — and a derivation is a good guess, never better than the panel's own answer.
         It used to be filed into the ts/hls buckets by GUESSING its format from its name, and the
         commonest playlist link of all (the extensionless .../user/pass/421107 shim) reads as
         neither, so it landed in the ts bucket and on an iPhone — which has no transport-stream
         decoder, so hls leads there — the real link was tried THIRD, behind two guesses.
         Leading with it costs one probe, and the probe is exactly what makes that safe: a format
         this device cannot decode is identified from the bytes and skipped in a fifth of a second. */
      if (direct) order.unshift(direct);
      for (var i = 0; i < order.length; i++) addPair(order[i], i === 0 && direct ? 'provider link' : 'live');
    } else {
      /* The real file first — full quality, and seekable by byte range — then the panel's own HLS
         remux, which is fragmented and hardware-decodable and is what makes an HEVC title play on
         a phone, then the .mp4 form for a panel that gates the container its own listing printed. */
      var addrs = [];
      if (direct) addrs.push(direct);
      var xc = D.directUrl(item, cont || 'mp4');
      if (xc) addrs.push(xc);
      if (forms) { addrs.push(forms.m3u8); if (forms.ext !== 'mp4') addrs.push(forms.file('mp4')); }
      var xmp4 = D.directUrl(item, 'mp4'), xm3u = D.directUrl(item, 'm3u8');
      if (xmp4) addrs.push(xmp4);
      if (xm3u) addrs.push(xm3u);
      for (var j = 0; j < addrs.length; j++) addPair(addrs[j], j === 0 && direct ? 'provider link' : 'title');
    }

    /* The transcoder last: it re-wraps anything at all into browser-playable HLS and is the only
       route for a container no browser can decode. Never probed — its endpoint blocks while ffmpeg
       builds the first segment, which the machine resolves by polling instead. */
    if (D.transcoderBase && D.transcoderBase()) {
      var src = D.transcoderInput(item);
      if (src) {
        var qp = D.qualityProfile && D.qualityProfile();
        var t = function (profile) { add(D.transcodeUrl(src, profile), { label: 'transcoder', transcode: true, noProbe: true, claim: HLS }); };
        if (qp && D.looks4k(item)) t(qp);
        if (live) t('remux');
        else { if (qp) t(qp); t('fastvod'); t('vod'); }
      }
    }
    return out;
  }

  /* ── ENGINES ────────────────────────────────────────────────────────────────────────────────
     One interface: start(ctx), stop(ctx). An engine reports exactly one of ctx.fail (could not
     start — try the next candidate) or ctx.drop (was playing and died — recover in place).
     "Playing" is decided by the element, not the engine, so every engine agrees on what it means. */
  var Engines = {};

  /* ── v18.2: THE ONE LINE THAT DECIDES WHETHER AN IPHONE CAN PLAY ANYTHING IN-APP ────────────
     iOS 17.1+ has no plain MediaSource. What it has is ManagedMediaSource, and WebKit attaches one
     ONLY to an element whose remote playback is disabled — AirPlay and a managed source cannot
     coexist, so with AirPlay left on the attach simply throws and the decoder dies before it has
     read a byte. The element in index.html is authored `x-webkit-airplay="allow"`, which opts in.
     The previous engine knew this and turned it off (see the old tryPlans path), and so does the
     in-app Matroska player — but M26 Player 2, which replaced that engine, never did. So on every
     iPhone hls.js and mpegts.js reported themselves supported, started, and immediately failed,
     and every title fell through to the transcoder: the inbuilt player could not play at all, and
     a raw .ts live channel had nothing left to fall back to.
     Set per engine rather than once on the element, because it is a genuine trade: a media-source
     engine needs AirPlay off, while native playback can keep it on and should. */
  function remotePlayback(video, allow) {
    if (!video) return;
    try {
      video.disableRemotePlayback = !allow;
      if (allow) { video.removeAttribute('disableremoteplayback'); video.setAttribute('x-webkit-airplay', 'allow'); }
      else       { video.setAttribute('disableremoteplayback', ''); video.removeAttribute('x-webkit-airplay'); }
    } catch (e) {}
  }
  /* Engines that drive a MediaSource/ManagedMediaSource themselves. */
  function needsManagedSource(video) { remotePlayback(video, false); }

  Engines.native = {
    /* Plain file or native HLS: the element fetches for itself, so AirPlay stays available. */
    start: function (ctx) { remotePlayback(ctx.video, true); ctx.video.src = ctx.url; ctx.video.load(); },
    stop:  function (ctx) { try { ctx.video.removeAttribute('src'); ctx.video.load(); } catch (e) {} }
  };

  Engines.hlsjs = {
    start: function (ctx) {
      var Hls = global.Hls;
      if (!Hls || !Hls.isSupported()) return Engines.native.start(ctx);
      needsManagedSource(ctx.video);
      var h = new Hls({
        enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3,
        startFragPrefetch: true, maxBufferLength: 30, startLevel: -1,
        abrEwmaDefaultEstimate: D.mobile() ? 1200000 : 4000000
      });
      ctx.hls = h;
      D.onEngine && D.onEngine('hls', h);
      h.on(Hls.Events.ERROR, function (e, data) {
        if (!data || !data.fatal || !ctx.alive()) return;
        ctx.played() ? ctx.drop() : ctx.fail('HLS: ' + (data.details || data.type || 'fatal error'));
      });
      h.on(Hls.Events.MANIFEST_PARSED, function () { if (ctx.alive()) ctx.levels(); });
      h.on(Hls.Events.LEVEL_SWITCHED, function () { if (ctx.alive()) ctx.levels(); });
      h.loadSource(ctx.url); h.attachMedia(ctx.video);
    },
    stop: function (ctx) {
      if (ctx.hls) { try { ctx.hls.destroy(); } catch (e) {} ctx.hls = null; D.onEngine && D.onEngine('hls', null); }
      Engines.native.stop(ctx);
    }
  };

  Engines.mpegts = {
    start: function (ctx) {
      var mpegts = global.mpegts;
      if (!mpegts || !mpegts.isSupported()) return ctx.fail('this device has no transport-stream decoder');
      needsManagedSource(ctx.video);
      /* A small initial stash lets the first packets decode as they arrive rather than waiting for
         a full buffer — that is what makes a channel open quickly. VOD keeps a larger one. */
      var p = mpegts.createPlayer(
        { type: 'mpegts', isLive: ctx.live, url: ctx.url, cors: true },
        { enableWorker: true, lazyLoad: false, isLive: ctx.live, enableStashBuffer: true,
          stashInitialSize: ctx.live ? (D.mobile() ? 24 * 1024 : 32 * 1024)
                                     : (D.mobile() ? 128 * 1024 : 256 * 1024),
          liveBufferLatencyChasing: false, autoCleanupSourceBuffer: true });
      ctx.ts = p;
      D.onEngine && D.onEngine('ts', p);
      p.on(mpegts.Events.ERROR, function (a, b, info) {
        if (!ctx.alive()) return;
        ctx.played() ? ctx.drop() : ctx.fail('transport stream: ' + ((info && info.msg) || b || a || 'error'));
      });
      p.attachMediaElement(ctx.video); p.load();
    },
    stop: function (ctx) {
      if (ctx.ts) {
        try { ctx.ts.pause(); ctx.ts.unload(); ctx.ts.detachMediaElement(); ctx.ts.destroy(); } catch (e) {}
        ctx.ts = null; D.onEngine && D.onEngine('ts', null);
      }
      Engines.native.stop(ctx);
    }
  };

  /* Matroska parsed and remuxed to fragmented MP4 in JavaScript, fed to this same element, so the
     device's own decoder plays it with nothing re-encoded and no server involved. Only H.264/HEVC
     with AAC survives a pure remux; anything else fails quickly to the transcoder. */
  Engines.matroska = {
    start: function (ctx) {
      if (!global.Media26Mkv || !global.Media26Mkv.supported()) return ctx.fail('this device has no in-app Matroska decoder');
      /* mkv.js sets disableRemotePlayback itself once it knows the source is managed, but it does
         not clear the element's x-webkit-airplay attribute — do the whole switch here so every
         media-source engine leaves the element in the same known state. */
      needsManagedSource(ctx.video);
      global.Media26Mkv.play(ctx.video, ctx.url, {
        onInfo: function (info) {
          if (!ctx.alive() || !info) return;
          var vt = (info.tracks || []).filter(function (t) { return t.type === 'video'; })[0];
          /* The header carries the true resolution, which catches a 4K file the provider never
             labelled — above the ceiling, hand it to the downscaling transcoder instead. */
          if (vt && (vt.width || 0) >= 2560 && D.qualityProfile && D.qualityProfile()) {
            ctx.stopSelf(); ctx.fail('4K source — switching to the downscaled stream'); return;
          }
          if (info.audioDropped) D.toast && D.toast('Playing video — this file’s audio track was rejected by the device.');
          else if (info.unsupportedAudio) D.toast && D.toast('Playing video — this file’s ' + String(info.unsupportedAudio).replace(/^A_/, '') + ' audio can’t be decoded in-app.');
        }
      }).catch(function (e) {
        if (ctx.alive()) ctx.fail('in-app Matroska: ' + ((e && e.message) || 'unsupported'));
      });
    },
    stop: function (ctx) {
      try { if (ctx.video.__mkvStop) { ctx.video.__mkvStop(); ctx.video.__mkvStop = null; } } catch (e) {}
      Engines.native.stop(ctx);
    }
  };

  /* Which engine plays a given FORMAT on this device, best first. Returns [] when nothing here
     can — the candidate is then skipped rather than queued to fail slowly. */
  function enginesFor(format, c) {
    if (format === HLS) {
      /* Apple decodes HLS in hardware, including HEVC and 4K, which hls.js cannot do through
         Media Source Extensions — so native leads there and hls.js backs it up. Everywhere else
         hls.js leads, because it is the only HLS implementation those browsers have. */
      if (c.apple && c.nativeHls) return c.hlsjs ? ['native', 'hlsjs'] : ['native'];
      if (c.hlsjs) return c.nativeHls ? ['hlsjs', 'native'] : ['hlsjs'];
      return c.nativeHls ? ['native'] : [];
    }
    if (format === TS)  return c.mpegts ? ['mpegts'] : [];
    if (format === MKV) return c.mkv ? ['matroska', 'native'] : ['native'];
    if (format === MP4) return ['native'];
    if (format === 'hard') return [];               /* avi/wmv/flv — transcoder only */
    return ['native'];                              /* unknown: let the element try to sniff it */
  }

  /* ── MACHINE ────────────────────────────────────────────────────────────────────────────────
     States: resolving -> probing -> loading -> playing, with recovering and failed. Every
     transition is named so a failure can always say what it was doing when it gave up. */

  /* The transcoder's endpoint blocks while ffmpeg builds the first segment, and a free host needs
     30-50s to wake — far longer than any decoder's own manifest timeout. Poll for a ready playlist
     under our own deadline, then hand the resolved address to the HLS engine. */
  /* v18.1: WHAT "STILL WAKING" ACTUALLY LOOKS LIKE ON THE WIRE.
     This polling loop knew exactly one waking signal — 503 — and treated everything else as the
     transcoder's final answer. A free-plan instance that has gone to sleep does not answer 503.
     Render's edge answers 502 while the container boots, and the gateway in front of it gives up
     first and answers 504 once the boot outruns its own timeout, which is the common case: a cold
     start is 30-50s and the gateway's patience is shorter. Cloudflare's /transcoder pass-through
     adds its own origin-timeout family (522 connection timed out, 523 unreachable, 524 origin took
     too long) for the same situation.
     So the ONE route that can play a raw transport stream on a device with no Media Source (every
     iPhone) was being written off at the exact moment it was coming up, and the customer was shown
     "server returned 504" — a number that reads like the provider refusing the channel, when it
     means the app's own helper had not finished starting. Poll through all of them; the 120-second
     deadline below is what decides when to genuinely give up. */
  function stillWaking(status) {
    return !status || status === 408 || status === 502 || status === 503 || status === 504
      || status === 522 || status === 523 || status === 524;
  }

  function awaitTranscode(ctx, url, ready) {
    var deadline = Date.now() + 120000;
    function why(res) {
      var base = 'server returned ' + res.status;
      return res.clone().json().then(function (j) {
        var raw = String((j && (j.log || j.error)) || '');
        var tail = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).slice(-2).join(' · ');
        return tail ? base + ' — ' + tail.slice(-180) : base;
      }).catch(function () { return base; });
    }
    function poll(manifest) {
      if (!ctx.alive()) return;
      if (Date.now() > deadline) return ctx.fail('transcoder: no video produced in time (it may be waking up — try again in ~30s)');
      var again = function () { setTimeout(function () { poll(manifest); }, 2000); };
      fetch(manifest, { cache: 'no-store' }).then(function (m) {
        if (!ctx.alive()) return;
        if (m.ok) return m.text().then(function (t) {
          if (!ctx.alive()) return;
          if (/#EXTINF/.test(t)) return ready(manifest);
          again();
        });
        /* 404 stays in the keep-polling set for its own reason: ffmpeg has been started but has
           not written the playlist file yet, so the address is briefly genuinely absent. */
        if (!stillWaking(m.status) && m.status !== 404) return why(m).then(function (w) { ctx.fail('transcoder: ' + w); });
        again();
      }).catch(again);
    }
    fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!ctx.alive()) return;
      if (!res.ok && !stillWaking(res.status)) return why(res).then(function (w) { ctx.fail('transcoder: ' + w); });
      poll(res.url || url);
    }).catch(function () {
      /* v18.1: a THROWN fetch here is not proof the transcoder is dead. A host that is still
         booting refuses the connection outright, and the pass-through in front of it can answer
         with an error page carrying no CORS headers — both surface as a rejected promise, and
         both clear themselves seconds later. This used to end the only route an iPhone has with
         "transcoder: unreachable" before the service had finished starting. Hand it to the same
         poll loop as every other waking signal and let the deadline decide. */
      if (ctx.alive()) poll(url);
    });
  }

  function Machine(item, video, hooks, token) {
    this.item = item; this.video = video; this.hooks = hooks || {}; this.token = token;
    this.live = !!D.isLive(item);
    this.caps = caps(video);
    this.queue = [];              /* [{url, engine, format, label, transcode}] built as we probe */
    this.candidates = [];         /* the catalog, still to be examined */
    this.at = -1;
    this.state = 'idle';
    this.playing = false; this.everPlayed = false;
    this.attachedAt = 0; this.lastT = 0; this.lastProgress = Date.now();
    this.recoveries = 0; this.drops = []; this.lastRecovery = 0; this.cleanSince = Date.now();
    this.reason = ''; this.beat = null; this.ctx = null;
  }

  Machine.prototype.alive = function () { return D.token() === this.token; };

  Machine.prototype.to = function (state, detail) {
    this.state = state;
    if (this.alive() && this.hooks.onState) this.hooks.onState(state, detail);
  };

  Machine.prototype.start = function () {
    var self = this;
    this.candidates = catalog(this.item, this.video);
    this.to('resolving');
    if (!this.candidates.length) return this.giveUp(D.noRouteReason ? D.noRouteReason(this.item) : '');
    (function beat() {
      self.beat = setTimeout(function () { self.tick(); if (self.beat) beat(); }, 1000);
      D.onTimer && D.onTimer(self.beat);
    })();
    this.advance();
  };

  Machine.prototype.stop = function () {
    if (this.beat) { clearTimeout(this.beat); this.beat = null; }
    this.release();
  };

  Machine.prototype.release = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    try { if (Engines[ctx.engine]) Engines[ctx.engine].stop(ctx); } catch (e) {}
  };

  /* Take the next catalog entry, establish what it really is, and attach the right decoder.
     This is the heart of the player: evidence in, decoder out. */
  Machine.prototype.advance = function () {
    var self = this;
    if (!this.alive()) return;

    var cand = this.candidates.shift();
    if (!cand) return this.giveUp(this.reason);

    /* The transcoder is not probed: it has to be woken and polled first. */
    if (cand.transcode) return this.attach(cand, 'hlsjs', HLS);

    /* Live with a working transport-stream decoder keeps the direct path. The format is not in
       doubt, it is the most latency-sensitive content there is, and it is where a provider's
       single-connection limit is least forgiving of an extra socket. */
    var claimEngines = enginesFor(cand.claim, this.caps);
    if (this.live && cand.claim === TS && this.caps.mpegts) return this.attach(cand, 'mpegts', TS);

    this.to('probing', cand.label);
    probe(cand.url).then(function (r) {
      if (!self.alive()) return;

      if (!r.ok) {
        /* Hard evidence that this address is not usable: a 401/403/404, or a read this browser is
           not permitted to make. Drop it now instead of spending a start budget on it. */
        self.note(cand.label + ': ' + (r.error || 'unreachable'));
        return self.advance();
      }
      var format = r.format !== UNKNOWN ? r.format : cand.claim;
      var engines = enginesFor(format, self.caps);
      if (!engines.length) {
        self.note(cand.label + ': this device cannot decode ' + describe(format));
        return self.advance();
      }
      /* Queue the remaining decoders for this same address as in-place alternatives, so a decoder
         that refuses the stream does not cost us the address itself. */
      for (var i = engines.length - 1; i >= 1; i--) self.candidates.unshift({ url: cand.url, claim: format, label: cand.label, forceEngine: engines[i], noProbe: true });
      /* Give a single-connection panel a moment to release the probe's slot before the real read. */
      setTimeout(function () { if (self.alive()) self.attach(cand, engines[0], format); }, SETTLE_MS);
    });
  };

  function describe(f) {
    return f === HLS ? 'this HLS stream' : f === TS ? 'a raw transport stream'
         : f === MKV ? 'Matroska video' : f === MP4 ? 'this MP4' : f === 'hard' ? 'this container' : 'this stream';
  }

  Machine.prototype.note = function (why) { if (why) this.reason = why; };

  Machine.prototype.attach = function (cand, engine, format) {
    var self = this, v = this.video;
    if (!this.alive()) return;
    if (cand.forceEngine) engine = cand.forceEngine;
    this.release();
    this.at++;
    this.attachedAt = Date.now();
    this.playing = false;
    this.current = { cand: cand, engine: engine, format: format };

    v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.autoplay = true; v.loop = false; v.preload = 'auto';
    v.onwaiting = v.onstalled = v.onsuspend = v.ontimeupdate = null;   /* no handler outlives its attempt */

    var ctx = this.ctx = {
      engine: engine, url: cand.url, video: v, live: this.live, hls: null, ts: null,
      alive:    function () { return self.alive() && self.ctx === ctx; },
      played:   function () { return self.everPlayed; },
      levels:   function () { self.hooks.onLevels && self.hooks.onLevels(); },
      fail:     function (why) { if (ctx.alive()) { self.note(why); self.advance(); } },
      drop:     function ()    { if (ctx.alive()) self.recover(); },
      stopSelf: function ()    { try { if (Engines[ctx.engine]) Engines[ctx.engine].stop(ctx); } catch (e) {} }
    };

    v.onplaying = function () {
      if (!ctx.alive() || self.playing) return;
      self.playing = true; self.everPlayed = true;
      self.to('playing');
      self.hooks.onStarted && self.hooks.onStarted(self.current);
    };
    v.onerror = function () {
      if (!ctx.alive()) return;
      self.everPlayed ? self.recover() : ctx.fail('the browser refused this stream');
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

    var run = function (name, url) {
      ctx.engine = name; ctx.url = url;
      self.to('loading', cand.label);
      try { Engines[name].start(ctx); }
      catch (e) { return ctx.fail((e && e.message) || 'the decoder failed to start'); }
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () {
        if (!ctx.alive()) return;
        /* Unmuted autoplay refused — play muted rather than stall, and let the app restore sound on
           the next interaction. */
        v.muted = true;
        D.onAutoplayMuted && D.onAutoplayMuted();
        var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {});
      });
    };

    if (cand.transcode) { this.to('loading', 'preparing'); awaitTranscode(ctx, cand.url, function (m) { if (ctx.alive()) run('hlsjs', m); }); }
    else run(engine, cand.url);
  };

  Machine.prototype.giveUp = function (why) {
    if (!this.alive()) return;
    this.stop();
    this.to('failed', why || this.reason);
    this.hooks.onFailed && this.hooks.onFailed(why || this.reason);
  };

  /* Recover the CURRENT stream in place — live rejoins the edge, a title keeps its position. This
     is what carries a channel through a blip, and it never switches to a worse stream so it cannot
     loop. Repeated drops mean the route itself is unreliable: move on instead. */
  Machine.prototype.recover = function () {
    if (!this.alive()) return;
    var now = Date.now(), v = this.video;
    /* A user seek is not a failure: the element briefly errors and stalls while it fetches the new
       position. Reloading there is what used to snap a film back to the start. */
    if (!this.live && (v.seeking || (now - (D.getLastSeekAt ? D.getLastSeekAt() : 0)) < 12000)) {
      this.lastProgress = now; this.lastT = v.currentTime || 0; return;
    }
    if (now - this.lastRecovery < 3000) return;
    this.drops = this.drops.filter(function (t) { return now - t < 60000; });
    this.drops.push(now);
    if (this.drops.length >= (this.live ? 2 : 3) && this.candidates.length) {
      this.drops = []; this.recoveries = 0; this.lastRecovery = now; this.lastProgress = now;
      this.to('switching');
      return this.advance();
    }
    if (this.recoveries >= 40) return this.giveUp('the stream kept dropping');
    this.lastRecovery = now; this.recoveries++; this.lastProgress = now; this.lastT = v.currentTime || 0;
    this.to('recovering');
    var keep = (!this.live && v.currentTime > 0) ? v.currentTime : 0;
    var cur = this.current;
    this.attach(cur.cand, cur.engine, cur.format);
    if (keep > 0) {
      var restore = function () { try { v.currentTime = keep; } catch (e) {} v.removeEventListener('loadedmetadata', restore); };
      v.addEventListener('loadedmetadata', restore);
    }
  };

  /* One calm 1s heartbeat, the only watchdog: move on from a candidate that never starts, recover
     one that started and then froze. It never touches a healthy stream. */
  Machine.prototype.tick = function () {
    if (!this.alive()) { if (this.beat) { clearTimeout(this.beat); this.beat = null; } return; }
    if (this.state === 'probing' || this.state === 'resolving') return;
    var v = this.video, now = Date.now();

    if (Math.abs((v.currentTime || 0) - this.lastT) > 0.25) {
      this.lastT = v.currentTime || 0; this.lastProgress = now;
      if (now - this.cleanSince > 30000) { this.recoveries = 0; this.cleanSince = now; }
    } else if (this.playing) { this.cleanSince = now; }

    if (!this.playing) {
      var cur = this.current;
      /* Budgets are shorter than the old player's because the probe has already ruled out the
         addresses that were never going to answer — what remains is a decoder that should be
         producing picture. The transcoder keeps a long one: it may be cold-starting. */
      var budget = cur && cur.cand.transcode ? 60000 : (this.live ? 12000 : (this.candidates.length ? 10000 : 30000));
      if (this.attachedAt && now - this.attachedAt > budget) {
        this.note((cur && cur.cand.label || 'this route') + ' did not start in time');
        this.advance();
      }
      return;
    }
    if (!v.paused && !v.ended && !v.seeking &&
        (now - (D.getLastSeekAt ? D.getLastSeekAt() : 0)) > 12000 &&
        now - this.lastProgress > 9000) this.recover();
  };

  /* ── public API ─────────────────────────────────────────────────────────────────────────── */
  var live = null;

  function play(item, hooks) {
    if (live) { try { live.stop(); } catch (e) {} live = null; }
    var m = new Machine(item, D.video(), hooks, D.token());
    live = m;
    m.start();
    return m;
  }
  function stop() { if (live) { try { live.stop(); } catch (e) {} live = null; } }

  global.M26Player2 = {
    name: 'Player 1',
    configure: configure,
    play: play,
    stop: stop,
    /* exported so the catalog, the format detector and the decoder choice can each be exercised
       on their own, without a browser */
    catalog: catalog,
    probe: probe,
    caps: caps,
    formatFromBytes: formatFromBytes,
    formatFromUrl: formatFromUrl,
    enginesFor: enginesFor
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.M26Player2;
})(typeof window !== 'undefined' ? window : globalThis);
