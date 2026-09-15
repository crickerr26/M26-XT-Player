import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.03 (owner report, with a screenshot: "Server Relay — 7s" on a plain mp4 movie, "movies are
   taking tooooo long to play"): mobile VOD used to try the third-party transcoder-box relay 2nd —
   right after Direct and BEFORE every plain native/proxy attempt — so an ordinary browser-safe mp4
   paid a hop through a separate, sometimes-cold service before the app ever tried the fast path
   that was going to work anyway.
   v25.04 (same report, continued): HLS/HLS Proxy — a totally different container format that the
   vast majority of Xtream VOD panels never serve for movies — used to sit BETWEEN MP4 and MP4
   Proxy, ahead of the same-format fallback far more likely to actually work. Moved behind it.
   v25.06 (same report, continued — now with hard evidence from "Copy Last Play Timing": route 1
   "Direct" won in 14.8s with NOTHING tried before it, while VLC played the identical title in
   under 2s by never touching this app's Cloudflare Worker at all): the v25.03 reasoning assumed a
   Cloudflare-averse panel always fails native/proxy FAST, which this account disproves — the panel
   slow-walked a real success instead of rejecting it. So Server Relay (the one route that reaches
   the origin from a non-Cloudflare IP) now leads ahead of every Worker-proxied route (Direct/MP4/
   MP4 Proxy/HLS/HLS Proxy) specifically when the panel needs Worker-proxying at all (blocked()),
   and only stays last for the rarer same-origin/https panel that never needed proxying to begin
   with. This locks in both shapes so neither can silently regress. */
assert.match(
  html,
  /const needsWorkerRelay=blocked\(direct\|\|rawMp4\);\s*\n\s*if\(needsWorkerRelay\)addRelay\('Server Relay',direct\|\|rawMp4\);\s*\n\s*if\(direct\)add\(direct\.includes\('\.m3u8'\)\?'hls':'native','Direct',W\(direct\)\);\s*\n\s*add\('native','MP4',W\(rawMp4\)\);\s*\n\s*add\('native','MP4 Proxy',proxyUrl\(rawMp4\)\);/,
  'Mobile VOD must try Server Relay BEFORE Direct/MP4/MP4 Proxy when the panel needs Worker-proxying (an http panel on this https app)'
);

assert.match(
  html,
  /add\('hls','HLS',W\(rawM3u8\)\);\s*\n\s*add\('hls','HLS Proxy',proxyUrl\(rawM3u8\)\);[\s\S]*?if\(!needsWorkerRelay\)addRelay\('Server Relay',direct\|\|rawMp4\);/,
  'Server Relay must stay LAST when the panel does not need Worker-proxying at all (a same-origin/https panel)'
);
