/* Media26 in-app Matroska player.
 *
 * Browsers cannot demux Matroska. Safari/iOS cannot at all, which is why every MKV either went to
 * an external app or through the server transcoder. This module removes that dependency: it parses
 * the MKV in JavaScript and REMUXES it into fragmented MP4, which is fed to the ordinary <video>
 * element through MediaSource (or ManagedMediaSource on iOS 17.1+). The elementary streams are
 * copied untouched — no decoding, no re-encoding — so the phone's hardware decoder does the work
 * and CPU cost is negligible.
 *
 * Plays: H.264 or HEVC video with AAC audio. HEVC is tagged hvc1 so Apple accepts it.
 * Video-only fallback: containers whose audio is AC-3/DTS/TrueHD (no browser can decode those).
 * Reports unsupported rather than failing silently, so the caller can fall back to the transcoder.
 */
(function (global) {
  'use strict';

  /* ── EBML primitives ──────────────────────────────────────────────────────────────────────── */

  // Element IDs are read with their length marker KEPT (that is how Matroska identifies them).
  function readId(b, p) {
    const f = b[p];
    if (f === undefined) return null;
    let len = 0;
    if (f & 0x80) len = 1; else if (f & 0x40) len = 2; else if (f & 0x20) len = 3; else if (f & 0x10) len = 4;
    else return null;
    if (p + len > b.length) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
    return { id: v, len };
  }

  // Sizes are read with the length marker STRIPPED. All-ones means "unknown size" (live segments).
  function readSize(b, p) {
    const f = b[p];
    if (f === undefined) return null;
    let len = 0, mask = 0;
    for (let i = 0; i < 8; i++) {
      if (f & (0x80 >> i)) { len = i + 1; mask = 0x80 >> i; break; }
    }
    if (!len || p + len > b.length) return null;
    let v = f & ~mask, unknown = (f & ~mask) === (0xff >> len);
    for (let i = 1; i < len; i++) {
      v = v * 256 + b[p + i];
      if (b[p + i] !== 0xff) unknown = false;
    }
    return { size: v, len, unknown };
  }

  function readUint(b, p, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; }
  function readFloat(b, p, n) {
    const dv = new DataView(b.buffer, b.byteOffset + p, n);
    return n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : 0;
  }

  const ID = {
    SEGMENT: 0x18538067, INFO: 0x1549a966, TIMECODE_SCALE: 0x2ad7b1, DURATION: 0x4489,
    TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83,
    CODEC_ID: 0x86, CODEC_PRIVATE: 0x63a2, DEFAULT_DURATION: 0x23e383,
    VIDEO: 0xe0, PIXEL_W: 0xb0, PIXEL_H: 0xba,
    AUDIO: 0xe1, SAMPLE_FREQ: 0xb5, CHANNELS: 0x9f,
    CLUSTER: 0x1f43b675, CLUSTER_TIME: 0xe7, SIMPLE_BLOCK: 0xa3, BLOCK_GROUP: 0xa0,
    BLOCK: 0xa1, BLOCK_DURATION: 0x9b
  };
  // Containers we descend into; everything else of known size is skipped wholesale.
  const DESCEND = new Set([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.VIDEO, ID.AUDIO, ID.CLUSTER, ID.BLOCK_GROUP]);

  /* ── MP4 box building ─────────────────────────────────────────────────────────────────────── */

  function box(type, ...payload) {
    let len = 8;
    for (const p of payload) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
    let o = 8;
    for (const p of payload) { out.set(p, o); o += p.length; }
    return out;
  }
  function u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; }
  function u16(n) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n & 0xffff); return a; }
  function u64(n) {
    const a = new Uint8Array(8), dv = new DataView(a.buffer);
    dv.setUint32(0, Math.floor(n / 4294967296)); dv.setUint32(4, n >>> 0);
    return a;
  }
  function str(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function cat(arrs) {
    let n = 0; for (const a of arrs) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  const TIMESCALE = 1000; // milliseconds — Matroska timecodes are ms once scaled

  function mvhd(dur) {
    return box('mvhd', u32(0), u32(0), u32(0), u32(TIMESCALE), u32(dur),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0xffffffff));
  }
  function tkhd(id, dur, w, h, isVideo) {
    return box('tkhd', u32(0x00000007), u32(0), u32(0), u32(id), u32(0), u32(dur),
      u32(0), u32(0), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      u32((w || 0) << 16), u32((h || 0) << 16));
  }
  function mdhd(dur) {
    return box('mdhd', u32(0), u32(0), u32(0), u32(TIMESCALE), u32(dur), u16(0x55c4), u16(0));
  }
  function hdlr(isVideo) {
    return box('hdlr', u32(0), u32(0), str(isVideo ? 'vide' : 'soun'),
      u32(0), u32(0), u32(0), str(isVideo ? 'VideoHandler\0' : 'SoundHandler\0'));
  }
  function dinf() {
    return box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1))));
  }

  function avc1(t) {
    const cfg = box('avcC', t.codecPrivate);
    return box('avc1',
      u32(0), u32(1), u32(0), u32(0), u32(0), u32(0),
      u16(t.width), u16(t.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      new Uint8Array(32), u16(0x0018), u16(0xffff), cfg);
  }
  function hvc1(t) {
    const cfg = box('hvcC', t.codecPrivate);
    return box('hvc1',
      u32(0), u32(1), u32(0), u32(0), u32(0), u32(0),
      u16(t.width), u16(t.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      new Uint8Array(32), u16(0x0018), u16(0xffff), cfg);
  }
  function esdsBox(asc) {
    /* ES_Descriptor wrapping the AudioSpecificConfig from CodecPrivate.
       DecoderConfigDescriptor's body is exactly 13 bytes before the DecoderSpecificInfo:
         objectTypeIndication(1) streamType/upStream/reserved(1) bufferSizeDB(3)
         maxBitrate(4) avgBitrate(4)
       Writing 12 and declaring 13 makes every demuxer read the AudioSpecificConfig one byte
       early, which Safari reports as a buffer error on the audio track and which silently cost
       the whole file — the video was fine. Counted out explicitly here so it cannot drift. */
    const dec = cat([new Uint8Array([0x05, asc.length]), asc]);
    const dcdBody = new Uint8Array([
      0x40,                    // objectTypeIndication: MPEG-4 audio
      0x15,                    // streamType 5 (audio) << 2 | upStream 0 | reserved 1
      0x00, 0x00, 0x00,        // bufferSizeDB
      0x00, 0x00, 0x00, 0x00,  // maxBitrate
      0x00, 0x00, 0x00, 0x00   // avgBitrate
    ]);
    const cfg = cat([new Uint8Array([0x04, dcdBody.length + dec.length]), dcdBody, dec]);
    const sl = new Uint8Array([0x06, 1, 0x02]);
    const es = cat([new Uint8Array([0x03, 3 + cfg.length + sl.length, 0, 0, 0]), cfg, sl]);
    return box('esds', u32(0), es);
  }
  function mp4a(t) {
    return box('mp4a', u32(0), u32(1), u32(0), u32(0),
      u16(t.channels || 2), u16(16), u16(0), u16(0), u32((t.sampleRate || 48000) << 16),
      esdsBox(t.codecPrivate));
  }

  /* Dolby sample entry: same AudioSampleEntry layout as mp4a, with dac3/dec3 in place of esds. */
  function dolby(t) {
    const type = t.kind === 'eac3' ? 'ec-3' : 'ac-3';
    const cfg = t.kind === 'eac3' ? dec3Box(t.ac3) : dac3Box(t.ac3);
    return box(type, u32(0), u32(1), u32(0), u32(0),
      u16(t.channels || 2), u16(16), u16(0), u16(0), u32((t.sampleRate || 48000) << 16), cfg);
  }
  function stbl(t) {
    let entry;
    if (t.kind === 'avc') entry = avc1(t);
    else if (t.kind === 'hevc') entry = hvc1(t);
    else if (t.kind === 'ac3' || t.kind === 'eac3') entry = dolby(t);
    else entry = mp4a(t);
    return box('stbl', box('stsd', u32(0), u32(1), entry),
      box('stts', u32(0), u32(0)), box('stsc', u32(0), u32(0)),
      box('stsz', u32(0), u32(0), u32(0)), box('stco', u32(0), u32(0)));
  }
  function trak(t, dur) {
    const isVideo = t.type === 'video';
    return box('trak', tkhd(t.id, dur, t.width, t.height, isVideo),
      box('mdia', mdhd(dur), hdlr(isVideo),
        box('minf', isVideo ? box('vmhd', u32(0), u32(0)) : box('smhd', u32(0), u32(0)),
          dinf(), stbl(t))));
  }

  function initSegment(tracks, durationMs) {
    const ftyp = box('ftyp', str('isom'), u32(1), str('isom'), str('iso6'), str('avc1'), str('mp41'));
    const traks = tracks.map(t => trak(t, durationMs || 0));
    const trexs = tracks.map(t => box('trex', u32(0), u32(t.id), u32(1), u32(0), u32(0), u32(0)));
    const moov = box('moov', mvhd(durationMs || 0), ...traks, box('mvex', ...trexs));
    return cat([ftyp, moov]);
  }

  function fragment(track, samples, seq, nextDts, shift) {
    /* Matroska stores blocks in DECODE order but stamps them with PRESENTATION times. Any file
       with B-frames — which is every real movie encode — therefore has non-monotonic timestamps,
       so treating the gaps between them as sample durations yields negative and nonsensical
       values and the browser rejects the stream. Synthetic clips with no B-frames hide this
       completely.
       Rebuild a proper decode timeline: the i-th decode slot takes the i-th smallest presentation
       time, which is monotonic by construction, and the difference between a sample's real
       presentation time and its decode time is carried as a composition offset. That is precisely
       what fragmented MP4 expects, and it is what makes B-frames display in the right order. */
    const n = samples.length;
    const dts = samples.map(s => s.pts).sort((a, b) => a - b);

    /* The final sample's duration comes from where the NEXT fragment begins, so consecutive
       fragments meet exactly instead of leaving a gap the browser has to paper over. */
    const dur = new Array(n);
    for (let i = 0; i < n; i++) {
      dur[i] = Math.max(1, (i + 1 < n) ? (dts[i + 1] - dts[i])
        : (nextDts != null ? (nextDts - dts[i]) : (track.defaultDuration || 40)));
    }

    /* ── v21.0: FRAGMENTS MUST NOT OVERLAP, AND ON AN OPEN GOP THEY DID. ──────────────────────
       Every fragment's decode timeline was rebuilt from ITS OWN samples — the i-th slot taking the
       i-th smallest presentation time in that fragment. In a closed-GOP encode that lines up
       exactly with where the previous fragment ended. A real broadcast/IPTV encode uses OPEN GOPs,
       where the frames following a keyframe in decode order include leading B-frames that are
       PRESENTED before it, referencing the GOP before. Their timestamps are lower, so each new
       fragment started 1-3 frames BEFORE the previous one finished — measured on an open-GOP
       H.264 High file: every fragment after the first overlapped by 40-120ms. A SourceBuffer
       rejects an overlapping fragment outright, which is what reached the customer as
       "Buffer error on avc1.64001f" on a file that is in every other way fine.
       So the decode clock now runs forward across fragments: a fragment starts where the last one
       ended, and the overlap is absorbed out of its earliest sample durations rather than added to
       the front, so the fragment still ENDS where its own timestamps say it should and the
       displacement cannot accumulate over a two-hour film. Nothing is dropped or re-ordered — the
       samples and their composition offsets are untouched. */
    let base = dts[0];
    let overlap = 0;
    if (track._nextDts != null && track._nextDts > base) { overlap = track._nextDts - base; base = track._nextDts; }
    for (let i = 0; overlap > 0 && i < n; i++) {
      const take = Math.min(overlap, dur[i] - 1);
      if (take > 0) { dur[i] -= take; overlap -= take; }
    }

    const trunEntries = new Uint8Array(n * 16);
    const dv = new DataView(trunEntries.buffer);
    let clock = base;
    for (let i = 0; i < n; i++) {
      dv.setUint32(i * 16, dur[i]);
      dv.setUint32(i * 16 + 4, samples[i].data.length);
      // Non-keyframes are marked non-sync and depend on other samples.
      dv.setUint32(i * 16 + 8, samples[i].key ? 0x02000000 : 0x01010000);
      /* Composition offset = presentation - decode. Taken raw this goes NEGATIVE for B-frames,
         which claims a frame is shown before it is decoded — impossible, and the decoder throws
         it out ("Buffer error on avc1..."). The whole presentation timeline is therefore delayed
         by a constant `shift`, big enough that no sample is ever displayed before its decode
         time. The same shift is applied to every track, so audio and video stay in sync. */
      dv.setInt32(i * 16 + 12, samples[i].pts + (shift || 0) - clock);
      clock += dur[i];
    }
    track._nextDts = clock;   /* where the next fragment of this track must begin */

    const tfhd = box('tfhd', u32(0x020000), u32(track.id));   // default-base-is-moof
    const tfdt = box('tfdt', u32(0x01000000), u64(base));     // version 1, 64-bit DECODE time
    /* version 1 (signed composition offsets) + data-offset, sample-duration, sample-size,
       sample-flags and sample-composition-time-offset all present.
       v20.6: the flag word said 0x1701, and the composition-offset bit is 0x800 — 0x1000 is not a
       flag at all. So every fragment WROTE four fields per sample (16 bytes) while ANNOUNCING
       three (12), and any reader stepping the table by what the header declared drifted four bytes
       further out of step with every sample: sizes read out of the middle of other fields, then
       "invalid NAL unit size" and a fragment the browser rejects outright. That is why an .mkv
       never actually played in-app and every MKV title ended up waiting on the transcoder. */
    const trunHeader = cat([u32(0x01000F01), u32(n)]);
    const trafLen = 8 + tfhd.length + tfdt.length + (8 + trunHeader.length + 4 + trunEntries.length);
    const moofLen = 8 + (8 + 8) + trafLen;
    const dataOffset = moofLen + 8;

    const trun = box('trun', trunHeader, u32(dataOffset), trunEntries);
    const traf = box('traf', tfhd, tfdt, trun);
    const moof = box('moof', box('mfhd', u32(0), u32(seq)), traf);
    const mdat = box('mdat', ...samples.map(s => s.data));
    return cat([moof, mdat]);
  }

  /* ── codec identification ─────────────────────────────────────────────────────────────────── */

  function avcCodecString(p) {
    if (!p || p.length < 4) return 'avc1.42E01E';
    const hex = n => ('0' + n.toString(16)).slice(-2);
    return 'avc1.' + hex(p[1]) + hex(p[2]) + hex(p[3]);
  }
  function hevcCodecString(p) {
    // hvcC: [0]=version [1]=profile_space<<6|tier<<5|profile_idc, [2..5]=compat flags, [12]=level
    if (!p || p.length < 13) return 'hvc1.1.6.L93.B0';
    const profileSpace = (p[1] >> 6) & 0x3, tier = (p[1] >> 5) & 0x1, profileIdc = p[1] & 0x1f;
    const spaceStr = ['', 'A', 'B', 'C'][profileSpace];
    let compat = 0;
    for (let i = 2; i <= 5; i++) compat = ((compat << 8) | p[i]) >>> 0;
    // Compatibility flags are written reversed, per ISO 14496-15.
    let rev = 0;
    for (let i = 0; i < 32; i++) rev = (rev << 1) | ((compat >>> i) & 1);
    return 'hvc1.' + spaceStr + profileIdc + '.' + (rev >>> 0).toString(16).toUpperCase() +
      '.' + (tier ? 'H' : 'L') + p[12] + '.B0';
  }
  function aacCodecString(asc) {
    if (!asc || !asc.length) return 'mp4a.40.2';
    let objType = (asc[0] >> 3) & 0x1f;
    if (objType === 31 && asc.length > 1) objType = 32 + (((asc[0] & 0x7) << 3) | ((asc[1] >> 5) & 0x7));
    return 'mp4a.40.' + (objType || 2);
  }

  /* About a second of video at any normal frame rate — enough for the decoder to start, small
     enough that the wait is not felt. See the v21.7 note in _block. */
  const FIRST_FRAGMENT_SAMPLES = 24;
  const VIDEO_CODECS = { 'V_MPEG4/ISO/AVC': 'avc', 'V_MPEGH/ISO/HEVC': 'hevc' };
  /* Apple devices decode Dolby Digital and Digital Plus natively inside MP4 — treating them as
     "no browser can decode this" cost the soundtrack on films that would have played with sound
     all along. Matroska carries no CodecPrivate for either, so the configuration has to be read
     out of the first audio frame's syncframe header (below). */
  const AUDIO_CODECS = { 'A_AAC': 'aac', 'A_AC3': 'ac3', 'A_EAC3': 'eac3' };

  function BitReader(d) { this.d = d; this.p = 0; }
  BitReader.prototype.read = function (n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((this.d[this.p >> 3] >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v >>> 0;
  };
  function BitWriter() { this.bits = []; }
  BitWriter.prototype.write = function (v, n) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1);
  };
  BitWriter.prototype.bytes = function () {
    while (this.bits.length % 8) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) out[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return out;
  };

  const AC3_SAMPLE_RATES = [48000, 44100, 32000, 0];
  const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];   // by acmod, before adding LFE

  /* AC-3 syncframe -> the fields a dac3 box needs. */
  function parseAc3(d) {
    if (!d || d.length < 8 || d[0] !== 0x0b || d[1] !== 0x77) return null;
    const r = new BitReader(d);
    r.read(16); r.read(16);                 // syncword, crc1
    const fscod = r.read(2), frmsizecod = r.read(6);
    const bsid = r.read(5), bsmod = r.read(3), acmod = r.read(3);
    if ((acmod & 0x1) && acmod !== 0x1) r.read(2);   // cmixlev
    if (acmod & 0x4) r.read(2);                      // surmixlev
    if (acmod === 0x2) r.read(2);                    // dsurmod
    const lfeon = r.read(1);
    return { fscod: fscod, bsid: bsid, bsmod: bsmod, acmod: acmod, lfeon: lfeon,
             bitRateCode: frmsizecod >> 1,
             sampleRate: AC3_SAMPLE_RATES[fscod] || 48000,
             channels: (AC3_CHANNELS[acmod] || 2) + lfeon };
  }
  function dac3Box(c) {
    const w = new BitWriter();
    w.write(c.fscod, 2); w.write(c.bsid, 5); w.write(c.bsmod, 3);
    w.write(c.acmod, 3); w.write(c.lfeon, 1); w.write(c.bitRateCode, 5); w.write(0, 5);
    return box('dac3', w.bytes());
  }

  /* E-AC-3 syncframe -> the fields a dec3 box needs, for one independent substream. */
  function parseEac3(d) {
    if (!d || d.length < 8 || d[0] !== 0x0b || d[1] !== 0x77) return null;
    const r = new BitReader(d);
    r.read(16);                              // syncword
    r.read(2);                               // strmtyp
    r.read(3);                               // substreamid
    const frmsiz = r.read(11);
    const fscod = r.read(2);
    let numblkscod = 3;
    if (fscod === 3) r.read(2); else numblkscod = r.read(2);
    const acmod = r.read(3), lfeon = r.read(1), bsid = r.read(5);
    const blocks = [1, 2, 3, 6][numblkscod];
    const sampleRate = fscod === 3 ? 24000 : (AC3_SAMPLE_RATES[fscod] || 48000);
    const frameBytes = (frmsiz + 1) * 2;
    // kbit/s = bytes * 8 * frames-per-second / 1000
    const dataRate = Math.round(frameBytes * 8 * (sampleRate / (blocks * 256)) / 1000);
    return { fscod: fscod, bsid: bsid, bsmod: 0, acmod: acmod, lfeon: lfeon,
             dataRate: Math.min(dataRate || 768, 8191),
             sampleRate: sampleRate,
             channels: (AC3_CHANNELS[acmod] || 2) + lfeon };
  }
  function dec3Box(c) {
    const w = new BitWriter();
    w.write(c.dataRate, 13);
    w.write(0, 3);                 // num_ind_sub - 1  (one independent substream)
    w.write(c.fscod, 2); w.write(c.bsid, 5); w.write(0, 1); w.write(0, 1);
    w.write(c.bsmod, 3); w.write(c.acmod, 3); w.write(c.lfeon, 1); w.write(0, 3);
    w.write(0, 4);                 // num_dep_sub = 0
    w.write(0, 1);                 // reserved (present because num_dep_sub is 0)
    return box('dec3', w.bytes());
  }

  /* ── the remuxer ──────────────────────────────────────────────────────────────────────────── */

  function MkvRemuxer() {
    this.buf = new Uint8Array(0);
    this.pos = 0;              // absolute stream offset of buf[0]
    this.stack = [];           // open container end-offsets
    this.timecodeScale = 1000000;
    this.durationMs = 0;
    this.tracks = [];
    this.byNumber = new Map();
    this.clusterTime = 0;
    this.ready = false;
    this.seq = 1;
    this.firstEmitted = false;
    this.pending = new Map();  // trackId -> samples awaiting a known duration
    this.onInit = null;
    this.onFragment = null;
    this.unsupported = null;
  }

  MkvRemuxer.prototype.append = function (chunk) {
    /* ── v22.4: REJECT A NON-MATROSKA BODY ON THE FIRST BYTES. ──────────────────────────────────
       A real Matroska file begins with the EBML magic 1A 45 DF A3. When a provider blocks our
       server fetch it answers with an HTML error page instead, and those bytes are still DATA — so
       the player's "no data" stall deadline never fired, and this parser churned through the HTML
       as garbage EBML for the whole route budget (~45s) before giving up, on every route in turn.
       That is the minute-plus of "loading" on a movie the provider will not serve us. Four bytes
       settle it: if the stream does not start with the EBML magic it is not Matroska, so fail at
       once and let the cascade move on (and, quickly, reach the verdict/VLC offer). */
    if (!this._magicChecked && (this.buf.length + chunk.length) >= 4) {
      this._magicChecked = true;
      const b0 = this.buf.length ? this.buf[0] : chunk[0];
      const b1 = this.buf.length > 1 ? this.buf[1] : chunk[1 - this.buf.length];
      const b2 = this.buf.length > 2 ? this.buf[2] : chunk[2 - this.buf.length];
      const b3 = this.buf.length > 3 ? this.buf[3] : chunk[3 - this.buf.length];
      if (!(b0 === 0x1A && b1 === 0x45 && b2 === 0xDF && b3 === 0xA3)) {
        const head = [b0, b1, b2, b3].map(function (x) { return String.fromCharCode(x); }).join('');
        this._notMatroska = 'not a Matroska stream (starts with "' + head.replace(/[^\x20-\x7e]/g, '.') + '") — the source likely returned an error page, not video';
        return;   /* stop here; playMkv sees _notMatroska and fails the route immediately */
      }
    }
    if (this._notMatroska) return;
    if (this.buf.length) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      this.buf = merged;
    } else this.buf = chunk;
    this._parse();
  };

  MkvRemuxer.prototype._trim = function (upto) {
    if (upto <= 0) return;
    this.buf = this.buf.subarray(upto);
    this.pos += upto;
  };

  MkvRemuxer.prototype._parse = function () {
    let p = 0;
    for (;;) {
      // Close any containers we have run past. A TrackEntry closing is what tells us that track's
      // fields are all in — committing earlier would capture it before CodecPrivate/width arrive.
      while (this.stack.length && this.pos + p >= this.stack[this.stack.length - 1].end) {
        const closed = this.stack.pop();
        if (closed.id === ID.TRACK_ENTRY && this._pendingTrack) {
          this._commitTrack(this._pendingTrack);
          this._pendingTrack = null;
        }
      }

      const idr = readId(this.buf, p);
      if (!idr) break;
      const szr = readSize(this.buf, p + idr.len);
      if (!szr) break;
      const headerLen = idr.len + szr.len;
      const id = idr.id, size = szr.size;

      if (DESCEND.has(id)) {
        if (id === ID.CLUSTER) { this.clusterTime = 0; this._finalizeTracks(); }
        this.stack.push({ id: id, end: szr.unknown ? Infinity : this.pos + p + headerLen + size });
        p += headerLen;
        this._trim(p); p = 0;
        continue;
      }

      // Leaf element: we need all of it before we can use it.
      if (szr.unknown) break;
      if (p + headerLen + size > this.buf.length) break;
      const data = this.buf.subarray(p + headerLen, p + headerLen + size);
      this._leaf(id, data);
      p += headerLen + size;
      this._trim(p); p = 0;
    }
    this._trim(p);
  };

  MkvRemuxer.prototype._leaf = function (id, data) {
    switch (id) {
      case ID.TIMECODE_SCALE: this.timecodeScale = readUint(data, 0, data.length); break;
      case ID.DURATION: this.durationMs = Math.round(readFloat(data, 0, data.length) * this.timecodeScale / 1e6); break;
      case ID.CLUSTER_TIME: this.clusterTime = readUint(data, 0, data.length); break;
      case ID.SIMPLE_BLOCK: this._block(data, true); break;
      case ID.BLOCK: this._block(data, false); break;
      case ID.TRACK_NUMBER: this._cur().number = readUint(data, 0, data.length); break;
      case ID.TRACK_TYPE: this._cur().trackType = readUint(data, 0, data.length); break;
      case ID.CODEC_ID: this._cur().codecId = String.fromCharCode.apply(null, data).replace(/\0+$/, ''); break;
      case ID.CODEC_PRIVATE: this._cur().codecPrivate = new Uint8Array(data); break;
      case ID.DEFAULT_DURATION: this._cur().defaultDuration = readUint(data, 0, data.length); break;
      case ID.PIXEL_W: this._cur().width = readUint(data, 0, data.length); break;
      case ID.PIXEL_H: this._cur().height = readUint(data, 0, data.length); break;
      case ID.SAMPLE_FREQ: this._cur().sampleRate = Math.round(readFloat(data, 0, data.length)) || 48000; break;
      case ID.CHANNELS: this._cur().channels = readUint(data, 0, data.length); break;
      default: break;
    }
  };

  MkvRemuxer.prototype._cur = function () {
    if (!this._pendingTrack) this._pendingTrack = {};
    return this._pendingTrack;
  };

  MkvRemuxer.prototype._commitTrack = function (t) {
    if (!t || !t.number || !t.codecId) return;
    const vk = VIDEO_CODECS[t.codecId], ak = AUDIO_CODECS[t.codecId];
    if (t.trackType === 1 && vk) {
      this.tracks.push({
        id: this.tracks.length + 1, number: t.number, type: 'video', kind: vk,
        codecPrivate: t.codecPrivate || new Uint8Array(0),
        width: t.width || 1920, height: t.height || 1080,
        defaultDuration: t.defaultDuration ? Math.round(t.defaultDuration / 1e6) : 40,
        codec: vk === 'avc' ? avcCodecString(t.codecPrivate) : hevcCodecString(t.codecPrivate)
      });
    } else if (t.trackType === 2) {
      if (ak === 'aac') {
        this.tracks.push({
          id: this.tracks.length + 1, number: t.number, type: 'audio', kind: 'aac',
          codecPrivate: t.codecPrivate || new Uint8Array([0x11, 0x90]),
          sampleRate: t.sampleRate || 48000, channels: t.channels || 2,
          defaultDuration: 21,
          codec: aacCodecString(t.codecPrivate)
        });
      } else if (ak === 'ac3' || ak === 'eac3') {
        /* Matroska stores no CodecPrivate for Dolby, so this track cannot be described until its
           first frame arrives and the syncframe can be read. It is registered now and configured
           in _block; the init segment waits for it. */
        this.tracks.push({
          id: this.tracks.length + 1, number: t.number, type: 'audio', kind: ak,
          codecPrivate: new Uint8Array(0), ac3: null, needsFrameConfig: true,
          sampleRate: t.sampleRate || 48000, channels: t.channels || 2,
          defaultDuration: 32,
          codec: ak === 'eac3' ? 'ec-3' : 'ac-3'
        });
      } else if (!this.unsupported) {
        // DTS, TrueHD, Vorbis… genuinely undecodable in a browser. Video still plays.
        this.unsupported = t.codecId;
      }
    }
  };

  MkvRemuxer.prototype._finalizeTracks = function () {
    if (this.ready) return;
    if (this._pendingTrack) { this._commitTrack(this._pendingTrack); this._pendingTrack = null; }
    if (!this.tracks.length) return;
    this.tracks.forEach(t => { this.byNumber.set(t.number, t); this.pending.set(t.id, []); });
    this.ready = true;
    this._emitInit();
  };

  /* The init segment can only be built once every track can describe itself. Dolby tracks are
     configured from their first frame, so emitting immediately would leave them out. If a Dolby
     frame never turns up, _block gives up after a short grace period and emits without it rather
     than stalling the file. */
  MkvRemuxer.prototype._emitInit = function () {
    if (this.initSent) return;
    const waiting = this.tracks.filter(t => t.needsFrameConfig && !t.ac3);
    if (waiting.length && !this._initForced) return;
    const usable = this.tracks.filter(t => !t.needsFrameConfig || t.ac3);
    if (!usable.length) return;
    for (const t of this.tracks) {
      if (t.needsFrameConfig && !t.ac3 && !this.unsupported) this.unsupported = t.kind.toUpperCase();
    }
    this.tracks = usable;
    this.initSent = true;
    if (this.onInit) this.onInit(initSegment(this.tracks, this.durationMs), this.tracks, this.unsupported);
  };

  MkvRemuxer.prototype._block = function (data, isSimple) {
    if (!this.ready) this._finalizeTracks();
    const tn = readSize(data, 0);
    if (!tn) return;
    let o = tn.len;
    const track = this.byNumber.get(tn.size);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rel = dv.getInt16(o); o += 2;
    const flags = data[o]; o += 1;
    if (!track) return;

    const key = isSimple ? !!(flags & 0x80) : true;
    const lacing = (flags & 0x06) >> 1;
    /* Relative timecodes are signed and legitimately go negative near a cluster boundary. The
       decode time is written as an unsigned 64-bit value, so a negative result would be encoded
       as garbage — clamp it. */
    const pts = Math.max(0, Math.round((this.clusterTime + rel) * this.timecodeScale / 1e6));

    const frames = [];
    if (!lacing) {
      frames.push(data.subarray(o));
    } else {
      const count = data[o] + 1; o += 1;
      const sizes = [];
      if (lacing === 2) {                       // fixed
        const each = (data.length - o) / count;
        for (let i = 0; i < count; i++) sizes.push(each);
      } else if (lacing === 1) {                // Xiph
        let total = 0;
        for (let i = 0; i < count - 1; i++) {
          let s = 0;
          while (data[o] === 255) { s += 255; o++; }
          s += data[o]; o++;
          sizes.push(s); total += s;
        }
        sizes.push(data.length - o - total);
      } else {                                  // EBML
        const first = readSize(data, o); o += first.len;
        sizes.push(first.size);
        let prev = first.size, total = first.size;
        for (let i = 1; i < count - 1; i++) {
          const d = readSize(data, o); o += d.len;
          const bias = (1 << (7 * d.len - 1)) - 1;
          prev = prev + (d.size - bias);
          sizes.push(prev); total += prev;
        }
        if (count > 1) sizes.push(data.length - o - total);
      }
      for (const s of sizes) { frames.push(data.subarray(o, o + s)); o += s; }
    }

    /* Read a Dolby track's configuration out of its first frame, then release the init segment. */
    if (track.needsFrameConfig && !track.ac3 && frames.length) {
      const cfg = track.kind === 'eac3' ? parseEac3(frames[0]) : parseAc3(frames[0]);
      if (cfg) {
        track.ac3 = cfg;
        track.sampleRate = cfg.sampleRate;
        track.channels = cfg.channels;
        this._emitInit();
      }
    }
    this._blocksSeen = (this._blocksSeen || 0) + 1;
    if (!this.initSent && this._blocksSeen > 60) { this._initForced = true; this._emitInit(); }
    /* Keep collecting while the init segment is still pending. A Dolby track is configured by its
       first audio frame, and in a real file the cluster opens with video — discarding those frames
       lost the opening seconds of every film. They are buffered here and flushed once init is out.
       A track dropped from the init (config never arrived) stops collecting, since no trak
       describes it. */
    if (!this.pending.has(track.id)) return;
    if (this.initSent && this.tracks.indexOf(track) < 0) return;

    const list = this.pending.get(track.id);

    if (track.type === 'video') {
      /* A decoder cannot start on a P/B frame, so a fragment must never begin on one. Drop
         anything before the first keyframe, and cut ONLY at keyframes thereafter.
         Arbitrary cuts were the bug behind "Buffer error on avc1...": timestamps are sorted
         within each fragment, so splitting mid-GOP made one fragment's decode range overlap the
         previous fragment's, and the browser rejected the stream. Whole GOPs cannot overlap. */
      if (!track._sawKey) {
        if (!key) return;
        track._sawKey = true;
      } else if (this.initSent && !track._firstOut && list.length >= FIRST_FRAGMENT_SAMPLES) {
        /* ── v21.7: SHOW A PICTURE WITHOUT WAITING FOR THE WHOLE FIRST GOP. ───────────────────
           Every cut here was made at a keyframe, so the first fragment could not close until the
           SECOND keyframe arrived — one whole GOP. A broadcast film runs 10-second GOPs at 5
           Mbit/s, so measured on exactly that: nothing was handed to the decoder until 6.1 MB and
           ten seconds of film had been downloaded and parsed. On a phone that is several seconds
           before the first frame on a fast connection and far longer on a slow one — past the
           twenty-second budget the player gives a route, so the in-app decoder was being dropped
           for "startup timeout" before it had ever been given the chance to draw anything. That is
           an MKV that "does not play" while being perfectly fine.
           The first fragment now closes after about a second of samples instead. It still STARTS
           at a keyframe, so the decoder always begins on a frame it can decode; only the fragment
           after it starts mid-GOP, which is exactly what every low-latency fMP4 stream does and is
           safe here because the decode timeline runs continuously across fragments (v21.0). Every
           later cut is at a keyframe as before. */
        this._flush(track, pts);
      } else if (this.initSent && key && list.length >= (this.firstEmitted ? 48 : 12)) {
        this._flush(track, pts);
      }
    }

    const step = frames.length > 1 ? Math.max(1, Math.round(track.defaultDuration)) : 0;
    frames.forEach((f, i) => {
      list.push({ pts: pts + i * step, data: new Uint8Array(f), key: key, duration: track.defaultDuration });
    });
    // Emit once we hold a comfortable run; keep the last sample so its real duration is known.
    // The FIRST fragment goes out far earlier so the picture appears while the rest is still
    // downloading — on a 4K file, waiting for a full 48-sample run before the first append is
    // most of the perceived "taking too long to load".
    /* Audio only: every frame is a sync sample, so it can be cut anywhere. Video is flushed above
       at keyframe boundaries. */
    if (this.initSent && track.type !== 'video' && list.length > (this.firstEmitted ? 96 : 24)) this._flush(track);
  };

  /* boundaryPts: cutting at a known keyframe, so the whole buffer goes and that keyframe's
     timestamp closes the last sample exactly.
     all: end of stream, emit whatever is left.
     neither: hold the final sample back so its duration can be measured against the next one. */
  MkvRemuxer.prototype._flush = function (track, boundaryPts, all) {
    const list = this.pending.get(track.id);
    if (!list || !list.length) return;
    let out, nextDts;
    if (boundaryPts != null) { out = list.splice(0, list.length); nextDts = boundaryPts; }
    else if (all) { out = list.splice(0, list.length); nextDts = null; }
    else {
      if (list.length < 2) return;
      out = list.splice(0, list.length - 1);
      nextDts = list.length ? list[0].pts : null;
    }
    if (!out.length) return;

    /* How far the presentation timeline must be delayed so that no sample in this fragment is
       displayed before it is decoded. It is the stream's reorder depth expressed in time, and it
       only ever grows — held on the remuxer so audio and video are delayed by the same amount and
       stay in sync. In practice it settles within the first GOP. */
    const ordered = out.map(s => s.pts).sort((a, b) => a - b);
    /* v21.0: include the overlap the fragment is about to be pushed forward by (see fragment()),
       otherwise the first leading B-frame of an open GOP lands with a negative offset. */
    const _overlap = (track._nextDts != null && track._nextDts > ordered[0]) ? (track._nextDts - ordered[0]) : 0;
    let need = _overlap;
    for (let i = 0; i < out.length; i++) need = Math.max(need, ordered[i] - out[i].pts + _overlap);
    if (need > (this.ctsShift || 0)) this.ctsShift = need;

    /* The boundary only closes the fragment correctly if it lies strictly after its last frame.
       When a keyframe carries a timestamp at or before that (overlapping GOPs, a re-timed
       cluster), the closing duration collapses toward zero and the next fragment then starts
       INSIDE this one. Overlapping fragments are rejected, so fall back to a normal frame
       duration in that case. */
    const lastPts = ordered[ordered.length - 1];
    if (nextDts != null && nextDts <= lastPts) nextDts = lastPts + (track.defaultDuration || 40);

    this.firstEmitted = true;
    /* Per TRACK, because firstEmitted is remuxer-wide: audio interleaves ahead of video and would
       otherwise mark the video track as "already started" before it had emitted anything at all,
       which is precisely what stopped the early first video fragment below from ever firing. */
    track._firstOut = true;
    if (this.onFragment) this.onFragment(fragment(track, out, this.seq++, nextDts, this.ctsShift || 0), track);
  };

  MkvRemuxer.prototype.flushAll = function () {
    if (!this.ready) this._finalizeTracks();
    /* Release the init even if a Dolby track never produced a readable frame — otherwise a short
       or unusual file would end with everything still buffered and nothing ever played. */
    if (!this.initSent) { this._initForced = true; this._emitInit(); }
    for (const t of this.tracks) this._flush(t, null, true);
  };

  MkvRemuxer.prototype.mimeFor = function (track) {
    return (track.type === 'video' ? 'video/mp4; codecs="' : 'audio/mp4; codecs="') + track.codec + '"';
  };

  /* ── playback: drive a <video> through MediaSource / ManagedMediaSource ───────────────────── */

  function supported() {
    return !!(global.ManagedMediaSource || global.MediaSource);
  }

  function playMkv(video, url, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      const MS = global.ManagedMediaSource || global.MediaSource;
      if (!MS) return reject(new Error('This browser has no MediaSource support'));

      const ms = new MS();
      const rx = new MkvRemuxer();
      let sourceBuffers = new Map(), queues = new Map(), controller = null, done = false, started = false;

      /* ManagedMediaSource (iOS 17.1+) is not a drop-in MediaSource. The element MUST have
         disableRemotePlayback set or attaching throws, and the browser drives fetching itself
         through startstreaming/endstreaming — that pair is the platform's own backpressure and is
         exactly what a 4K stream needs, since it tells us when to stop pulling instead of us
         guessing from buffered seconds. */
      const isManaged = !!(global.ManagedMediaSource && ms instanceof global.ManagedMediaSource);
      let streamingAllowed = !isManaged;
      if (isManaged) {
        try { video.disableRemotePlayback = true; } catch (_) {}
        ms.addEventListener('startstreaming', function () { streamingAllowed = true; });
        ms.addEventListener('endstreaming', function () { streamingAllowed = false; });
      }
      /* 4K is 20-80 Mbit/s, so "30 seconds buffered" can mean hundreds of megabytes — far past
         what Safari allows in a SourceBuffer, which showed up as constant quota errors and a
         stream that never settled. Hold a much shorter window for large frames and keep less of
         what has already played. */
      let aheadTarget = 30, evictKeep = 10;

      /* v21.8: an address that accepts the connection and then sends nothing used to hold the
         player on "Loading video" indefinitely — no bytes, no error, no verdict. Give it a
         deadline: if nothing has been handed to the decoder in this long, this route is dead and
         the player must be told so it can try the next one. */
      let firstDataAt = 0;
      const STALL_MS = 15000;
      const stallTimer = setTimeout(function () {
        if (!firstDataAt) fail(new Error('no data arrived from this address in ' + (STALL_MS / 1000) + 's'));
      }, STALL_MS);
      function fail(e) {
        if (done) return; done = true;
        try { clearTimeout(stallTimer); } catch (_) {}
        try { if (controller) controller.abort(); } catch (_) {}
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      // Drop what has already been watched so a long or high-bitrate title can keep appending.
      function evict(sb) {
        try {
          const ct = video.currentTime || 0;
          if (sb.buffered.length && sb.buffered.start(0) < ct - evictKeep) {
            sb.remove(sb.buffered.start(0), ct - evictKeep);
            return true;
          }
        } catch (_) {}
        return false;
      }
      function pump(trackId) {
        const sb = sourceBuffers.get(trackId), q = queues.get(trackId);
        if (!sb || !q || !q.length || sb.updating) return;
        try {
          sb.appendBuffer(q[0]);
          q.shift();
        } catch (e) {
          if (e && e.name === 'QuotaExceededError') {
            /* The buffer is full — a 4K stream fills it in seconds. Free the already-played part
               and retry the SAME fragment; the old code emptied the queue instead, throwing away
               video mid-file and leaving playback to stall on the resulting gap. */
            if (!evict(sb)) setTimeout(function () { pump(trackId); }, 250);
            return;
          }
          fail(e);
        }
      }

      rx.onInit = function (init, tracks, unsupportedAudio) {
        try {
          const big = tracks.some(function (t) { return t.type === 'video' && (t.width || 0) >= 2560; });
          if (big) { aheadTarget = 10; evictKeep = 4; }
          for (const t of tracks) {
            const mime = rx.mimeFor(t);
            if (!MS.isTypeSupported || !MS.isTypeSupported(mime)) {
              if (t.type === 'video') return fail(new Error('This device cannot decode ' + t.codec));
              continue; // skip an audio track the device cannot handle; video still plays
            }
            const sb = ms.addSourceBuffer(mime);
            sb.mode = 'segments';
            sb.addEventListener('updateend', function () {
              pump(t.id);
              /* Delaying presentation to keep composition offsets non-negative means the buffer
                 starts slightly after zero. currentTime sits at 0, so without a nudge the element
                 waits for data that will never exist there. Step onto the first buffered frame. */
              try {
                if (t.type === 'video' && video.readyState < 3 && sb.buffered.length &&
                    video.currentTime < sb.buffered.start(0)) {
                  video.currentTime = sb.buffered.start(0);
                }
              } catch (_) {}
            });
            /* A video-track failure is fatal; an audio one is not. Losing the soundtrack should
               never cost the film — before this, one rejected audio buffer failed the whole
               playback and sent a perfectly good file off to the transcoder. */
            sb.addEventListener('error', function () {
              /* Include whatever the browser actually said — its MediaError message names the
                 offending box or rule far better than the codec string alone. */
              if (t.type === 'video') {
                let why = '';
                try { if (video.error && video.error.message) why = ': ' + String(video.error.message).slice(0, 120); } catch (_) {}
                return fail(new Error('Buffer error on ' + t.codec + why));
              }
              try { sourceBuffers.delete(t.id); queues.delete(t.id); } catch (_) {}
              if (opts.onInfo) { try { opts.onInfo({ tracks: rx.tracks, audioDropped: t.codec }); } catch (_) {} }
            });
            sourceBuffers.set(t.id, sb);
            queues.set(t.id, []);
          }
          if (!sourceBuffers.size) return fail(new Error('No playable track in this file'));
          /* Each SourceBuffer must receive an init describing ONLY its own track. Handing a
             video buffer a moov that also declares an audio trak makes Safari reject the whole
             init, so both tracks died even though each was individually fine. */
          for (const t of tracks) {
            if (!sourceBuffers.has(t.id)) continue;
            queues.get(t.id).push(initSegment([t], rx.durationMs));
            pump(t.id);
          }
          if (opts.onInfo) opts.onInfo({ tracks: tracks, unsupportedAudio: unsupportedAudio });
        } catch (e) { fail(e); }
      };
      rx.onFragment = function (frag, track) {
        firstDataAt = firstDataAt || Date.now();
        if (!sourceBuffers.has(track.id)) return;
        queues.get(track.id).push(frag);
        pump(track.id);
        if (!started) { started = true; resolve({ tracks: rx.tracks, unsupportedAudio: rx.unsupported }); }
      };

      ms.addEventListener('sourceopen', async function () {
        try { if (rx.durationMs) ms.duration = rx.durationMs / 1000; } catch (_) {}
        try {
          controller = new AbortController();
          const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
          if (!res.ok) return fail(new Error('Source returned HTTP ' + res.status));
          if (!res.body) return fail(new Error('This browser cannot stream the source'));
          const reader = res.body.getReader();
          /* Backpressure. Without it the reader pulls the whole file as fast as the network allows
             and every fragment piles into the SourceBuffer — which on a 4K title means gigabytes
             of memory and constant quota errors. Once ~30s is buffered ahead of the playhead we
             stop pulling until it drains, so bandwidth goes to the part being watched. */
          /* ── v21.8: THE FIRST BYTES ARE NEVER GATED. ──────────────────────────────────────────
             streamingAllowed starts FALSE on iOS, because ManagedMediaSource is meant to tell us
             when it wants data — and this loop refused to read a single byte until it did. But
             WebKit only raises startstreaming when the element has media it is trying to play, and
             the element had nothing, because nothing had been read. No data, so no signal; no
             signal, so no data: the fetch sat still, no fragment was ever appended, nothing threw,
             and the player showed "Loading video" for as long as anyone was willing to watch it.
             That deadlock happens ONLY on iPhone — every other browser starts this flag true — so
             every decoder fix before this one was correct and invisible, because on the reported
             device the decoder was never fed at all.
             The managed signal is for steady state, not for the first fill. Read unconditionally
             until there is a real buffer to reason about, and only then let iOS's backpressure
             decide when to pull more; and never let an empty buffer wait on a signal that cannot
             come while it is empty. */
          const PRIME_AHEAD = 12;   /* seconds buffered before iOS's own signal takes over */
          let primed = false;
          const roomToRead = async function () {
            for (;;) {
              if (done) return false;
              let ahead = 0;
              try {
                const b = video.buffered;
                if (b.length) ahead = b.end(b.length - 1) - (video.currentTime || 0);
              } catch (_) {}
              if (!primed) {
                if (ahead < PRIME_AHEAD) return true;      /* fill first, ask questions later */
                primed = true;
              }
              // On iOS the browser's own signal wins; elsewhere fall back to the buffered window.
              if (streamingAllowed && ahead < aheadTarget) return true;
              /* A managed source that has gone quiet must never leave the element starving. */
              if (!streamingAllowed && ahead < PRIME_AHEAD) return true;
              await new Promise(function (r) { setTimeout(r, 250); });
            }
          };
          for (;;) {
            if (!(await roomToRead())) return;
            const { done: fin, value } = await reader.read();
            if (fin) break;
            if (done) return;
            rx.append(value);
            if (rx._notMatroska) return fail(new Error(rx._notMatroska));   /* v22.4: bail on an error page */
          }
          rx.flushAll();
          const close = () => { try { if (ms.readyState === 'open') ms.endOfStream(); } catch (_) {} };
          let waiting = 0;
          for (const sb of sourceBuffers.values()) if (sb.updating) waiting++;
          if (!waiting) close(); else setTimeout(close, 800);
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          fail(e);
        }
      });

      /* Safari attaches a ManagedMediaSource through srcObject; a blob URL from createObjectURL
         is not accepted for it, which is why nothing ever started on iPhone. Plain MediaSource
         keeps the blob URL, and srcObject failures fall back to it. */
      let attached = false;
      if (isManaged && 'srcObject' in video) {
        try { video.srcObject = ms; attached = true; } catch (_) {}
      }
      if (!attached) {
        try { video.src = URL.createObjectURL(ms); }
        catch (e) { return fail(new Error('Could not attach the media source')); }
      }
      video.__mkvStop = function () {
        done = true;
        try { if (controller) controller.abort(); } catch (_) {}
        try { if (video.srcObject) video.srcObject = null; } catch (_) {}
      };
    });
  }

  global.Media26Mkv = {
    supported: supported,
    play: playMkv,
    Remuxer: MkvRemuxer,
    _internals: { initSegment: initSegment, fragment: fragment, readId: readId, readSize: readSize,
                  avcCodecString: avcCodecString, hevcCodecString: hevcCodecString, aacCodecString: aacCodecString }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Media26Mkv;
})(typeof window !== 'undefined' ? window : globalThis);
