import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.06 (owner, with hard evidence: Direct won in 14.8s through this app's own Cloudflare Worker
   while VLC played the identical title in under 2s by going straight to the origin). Once ANY
   title on a host wins via a route, yezplayer.js's ROUTE MEMORY promotes that same shape ahead of
   everything else on every OTHER title on that host too (see expand()'s penalty()) — so a slow
   Worker-proxied win would keep leading new titles to the same slow path, permanently crowding out
   the now-leading Server Relay route (see plan()'s v25.06 note) before it ever gets tried. This
   locks in that a route is only remembered as "proven" when it was fast, or wasn't a Worker hop at
   all (a route that IS Server Relay, or a direct/unproxied connection). */
assert.match(
  html,
  /const _wonMs=Date\.now\(\)-attachAt;\s*\n\s*const _wonViaWorkerProxy=typeof PROXY==='string'&&!!PROXY&&String\(p\.url\|\|''\)\.indexOf\(PROXY\)===0;\s*\n\s*if\(window\.YezPlayer&&YezPlayer\.noteRouteWon&&!\(_wonViaWorkerProxy&&_wonMs>=6000\)\)YezPlayer\.noteRouteWon\(p\.url,p\.kind,p\.label\);/,
  'A route win must not be promoted to "proven for this host" when it was both slow (>=6s) and reached through this app\'s own Cloudflare Worker /proxy'
);

/* The "already played" per-title dot/lead (markPlayed/leadWithPlayed) is a separate, narrower
   mechanism than host-level ROUTE MEMORY and must stay unconditional — a slow win should still be
   remembered for THAT exact title (a replay can still find it), it just must not spread to every
   other title on the host via the host-level promotion tested above. */
assert.match(
  html,
  /if\(_x&&!hasPlayed\(_x\)\)\{markPlayed\(_x,p\.url,p\.kind,p\.label\);paintPlayedDot\(_x\);\}/,
  'markPlayed() (the per-title "already played" memory) must remain unconditional on win speed'
);
