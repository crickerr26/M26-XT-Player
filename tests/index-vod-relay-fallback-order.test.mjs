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
   v25.06 hoisted Server Relay ahead of everything for a Worker-proxied panel, on evidence that it
   was then the fastest address on the owner's line.
   v25.14 TOOK THAT BACK OUT (owner report: movies stopped playing at all; diagnostics showed Server
   Relay failing with "media element src not supported" — an HTML error page under a 200 — while
   leading, so every play burned ~17s on it before Direct even started). Server Relay is LAST again
   for every panel, http or https. If it starts working again ROUTE MEMORY promotes it on its own
   the first time it actually wins, which needs no ordering rule here. */
assert.match(
  html,
  /if\(direct\)add\(direct\.includes\('\.m3u8'\)\?'hls':'native','Direct',W\(direct\)\);\s*\n\s*add\('native','MP4',W\(rawMp4\)\);\s*\n\s*add\('native','MP4 Proxy',proxyUrl\(rawMp4\)\);/,
  'Mobile VOD must lead with Direct, then the same-format MP4 and MP4 Proxy retries'
);

assert.match(
  html,
  /add\('hls','HLS',W\(rawM3u8\)\);\s*\n\s*add\('hls','HLS Proxy',proxyUrl\(rawM3u8\)\);[\s\S]*?addRelay\('Server Relay',direct\|\|rawMp4\);/,
  'Server Relay must sit LAST, behind every native/proxy and HLS attempt'
);

/* The v25.06 hoist must not creep back in: no Server Relay ahead of Direct, and no blocked()-keyed
   branch deciding where it sits. */
assert.doesNotMatch(
  html,
  /if\(needsWorkerRelay\)addRelay\('Server Relay'/,
  'Server Relay must not be hoisted ahead of Direct for a Worker-proxied panel again (v25.14)'
);
assert.doesNotMatch(
  html,
  /if\(!needsWorkerRelay\)addRelay\('Server Relay'/,
  'Server Relay placement must no longer be conditional on blocked() (v25.14)'
);
