import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.03 (owner report, with a screenshot: "Server Relay — 7s" on a plain mp4 movie, "movies are
   taking tooooo long to play"): mobile VOD used to try the third-party transcoder-box relay 2nd —
   right after Direct and BEFORE every plain native/proxy attempt — so an ordinary browser-safe mp4
   paid a hop through a separate, sometimes-cold service before the app ever tried the fast path
   that was going to work anyway. That relay exists only to rescue the narrow case where a
   provider's stream node blocks Cloudflare's egress IPs outright (v21.4); native/proxy routes fail
   FAST (an edge-level refusal) when that's genuinely the problem, so they belong first. This locks
   the corrected order in so it can't silently regress back to "relay before native/proxy". */
assert.match(
  html,
  /if\(direct\)add\(direct\.includes\('\.m3u8'\)\?'hls':'native','Direct',W\(direct\)\);\s*\n\s*add\('native','MP4',W\(rawMp4\)\);\s*\n\s*add\('hls','HLS',W\(rawM3u8\)\);\s*\n\s*add\('native','MP4 Proxy',proxyUrl\(rawMp4\)\);\s*\n\s*add\('hls','HLS Proxy',proxyUrl\(rawM3u8\)\);[\s\S]*?addRelay\('Server Relay',direct\|\|rawMp4\);/,
  'Mobile VOD must try Direct and every plain native/proxy route before paying the third-party Server Relay hop'
);
