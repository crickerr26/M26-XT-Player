import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.09 (owner report, with screenshots: a download repeatedly interrupting and resuming —
   "Download interrupted — resuming Gandhari (2026) (Tamil)…" firing every stall, 28%->36%->43%
   over more than a minute, never finishing). v24.86 always routed a download through this app's
   own Cloudflare Worker /proxy unless something else was actively streaming (in which case it
   used the separate, non-Cloudflare Server Relay, purely to keep the two connections on different
   IPs on a 1-connection-limited panel). v25.06/v25.07 later found hard evidence, for this exact
   class of line (an http panel needing Worker-proxying at all), that Cloudflare's own /proxy is
   the SLOWER, less reliable path there — a download is the same kind of connection, just far
   longer-lived, so it is at least as exposed. The two paths now swap priority specifically when
   needsWorkerRelay is true: Server Relay leads when nothing else is streaming, Cloudflare's /proxy
   is used only when something else is (keeping the two apart exactly as v24.86 intended). An https
   panel (needsWorkerRelay false) is untouched. */
assert.match(
  html,
  /const cfProxyUrl=\(SAME_ORIGIN_PROXY\|\|PROXY\)\+encodeURIComponent\(raw\);\s*\n\s*const relayUrl=\(\)=>streamRelayUrl\(raw,x\)\|\|cfProxyUrl;/,
  'startDownload() must define both the Cloudflare-Worker and Server-Relay URL candidates before choosing between them'
);

assert.match(
  html,
  /const needsWorkerRelay=blocked\(raw\);\s*\n\s*let url=needsWorkerRelay\?\(hasActiveStream\?cfProxyUrl:relayUrl\(\)\):\(hasActiveStream\?relayUrl\(\):cfProxyUrl\);/,
  'startDownload() must lead with Server Relay when the panel needs Worker-proxying and nothing else is streaming, and fall back to Cloudflare\'s /proxy only when something else is (or when the panel never needed Worker-proxying at all, where the original v24.86 order is unchanged)'
);
