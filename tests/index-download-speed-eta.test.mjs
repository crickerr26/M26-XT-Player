import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(name);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

/* v25.10 (owner report: downloads now finish reliably after v25.09, but "taking too long" with no
   way to tell whether that means "slow right now" or "large file, actually on pace"). A rolling
   bytes/sec estimate is computed on the same 250ms tick that already repaints the progress bar
   (see startDownload's UI-throttle block), smoothed 70/30 so it reads as a trend rather than
   jumping every tick, and shown as speed + ETA next to the percentage. */

const context = {};
vm.createContext(context);
for (const name of ['function humanSize', 'function humanSpeed', 'function humanEta', 'function dlProgressText']) {
  vm.runInContext(extractFunction(name), context);
}

assert.equal(context.humanSpeed(0), '', 'no speed sample yet must show nothing, not a misleading 0 B/s');
assert.equal(context.humanSpeed(2 * 1048576), '2.0 MB/s', 'humanSpeed() must reuse humanSize()\'s own units');

assert.equal(context.humanEta({ bps: 0, total: 1000, received: 0 }), '', 'no speed sample yet must show no ETA');
assert.equal(context.humanEta({ bps: 1048576, total: 0, received: 0 }), '', 'an unknown total (no content-length/range) must show no ETA rather than a wrong one');
assert.equal(
  context.humanEta({ bps: 1048576, total: 130 * 1048576, received: 10 * 1048576 }),
  '2m 0s left',
  'humanEta() must compute remaining time from (total-received)/bps'
);
assert.equal(
  context.humanEta({ bps: 1048576, total: 10 * 1048576, received: 5 * 1048576 }),
  '5s left',
  'humanEta() must format under a minute as seconds only, not "0m Ns"'
);

assert.equal(
  context.dlProgressText({ pct: 43, bps: 0, total: 0, received: 0 }),
  'Downloading… 43%',
  'dlProgressText() must degrade to just the percentage before a speed sample exists'
);
assert.equal(
  context.dlProgressText({ pct: 43, bps: 1048576, total: 100 * 1048576, received: 43 * 1048576 }),
  'Downloading… 43% · 1.0 MB/s · 57s left',
  'dlProgressText() must append speed and ETA once both are known'
);

/* dlRowHtml (the row's initial render) and updateDlRowProgress (every live tick) must share this
   exact same function, so the two can never drift into showing different text for the same
   download — a duplicated formatter is exactly the kind of thing that quietly goes out of sync. */
assert.match(
  html,
  /\?`<div class="dlMeta" id="dlmeta-\$\{esc\(rec\.key\)\}">\$\{esc\(dlProgressText\(inFlight\)\)\}<\/div>/,
  'dlRowHtml() must render the in-flight row text via dlProgressText()'
);
assert.match(
  html,
  /function updateDlRowProgress\(key,prog\)\{[\s\S]*?if\(meta\)meta\.textContent=dlProgressText\(prog\);/,
  'updateDlRowProgress() must update the row text via the same dlProgressText()'
);
