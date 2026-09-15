import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.06 withheld ROUTE MEMORY when a win was slow (>=6s) AND came through this app's own Cloudflare
   Worker /proxy, so a slow Worker hop could not calcify as "the proven route for this host" and
   crowd out Server Relay on the next new title.
   v25.14 REVERTED that (owner report: movies taking a long time to play, then not playing at all).
   On a line whose only working address IS a Worker-proxied one, withholding the memory means every
   single play re-walks the entire ladder from scratch and pays for every failing route ahead of the
   winner, every time — which is exactly the complaint it was meant to help. Remembering the winner
   is the biggest single lever on start time, and a memory that turns out to be wrong already
   self-corrects: noteRouteLost() drops it the moment that shape stops working. */

assert.match(
  html,
  /try\{\s*\n\s*if\(window\.YezPlayer&&YezPlayer\.noteRouteWon\)YezPlayer\.noteRouteWon\(p\.url,p\.kind,p\.label\);\s*\n\s*\}catch\(e\)\{\}/,
  'a route that reaches PLAYING must always be remembered, with no speed or proxy condition attached'
);

assert.doesNotMatch(
  html,
  /_wonViaWorkerProxy/,
  'the v25.06 slow-Worker-win guard must stay removed (v25.14)'
);
