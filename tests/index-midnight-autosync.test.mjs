import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.15 (owner request: "automatic refresh of all the playlists should happen every midnight 12",
   and "when I force close and restart the app it should not load the categories again"). Auto-sync
   was a ROLLING 24 hours from the last sync, which drifts later every day; it is anchored to local
   midnight now, so it is due exactly once per calendar day. The same predicate also gates the
   launch-time background re-read that used to run on EVERY app start. */

function extractFunction(name) {
  const start = html.indexOf(name);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`Could not extract ${name}`);
}

let stamp = 0;
const context = { lastSyncedAt: () => stamp, Date };
vm.createContext(context);
vm.runInContext(extractFunction('function lastMidnight'), context);
vm.runInContext(extractFunction('function midnightSyncDue'), context);

const midnight = context.lastMidnight();
const asDate = new Date(midnight);
assert.equal(asDate.getHours(), 0, 'lastMidnight() must be local midnight, not UTC');
assert.equal(asDate.getMinutes(), 0);
assert.equal(asDate.getSeconds(), 0);
assert.equal(asDate.getMilliseconds(), 0);
assert.ok(midnight <= Date.now(), 'lastMidnight() must be the midnight that already passed, not the next one');

stamp = 0;
assert.equal(
  context.midnightSyncDue(), false,
  'a device that has never synced is NOT due — there is nothing stale to refresh, and autoSyncDue() starts the clock on its next check'
);

stamp = midnight - 60 * 60 * 1000;   /* 11pm yesterday */
assert.equal(context.midnightSyncDue(), true, 'a sync from before today\'s midnight is due');

stamp = midnight + 30 * 60 * 1000;   /* 00:30 today */
assert.equal(context.midnightSyncDue(), false, 'a sync from after midnight today is not due again until tomorrow');

stamp = Date.now();
assert.equal(context.midnightSyncDue(), false, 'a sync from just now is never due');

/* The rolling-24h window must be gone: with it, a sync at 23:00 would not be due again until 23:00
   the next day, i.e. it would sit there un-refreshed for the whole of that day. */
assert.doesNotMatch(html, /AUTO_SYNC_MS/, 'the rolling 24-hour window must be gone (v25.15)');
assert.match(
  html,
  /function autoSyncDue\(\)\{[\s\S]*?return last<lastMidnight\(\);/,
  'autoSyncDue() must compare against local midnight rather than a rolling interval'
);

/* Launch must not re-read the provider unless a refresh is genuinely due — that re-read is what put
   Movies and Series back on "loading…" every time the app was opened. */
assert.match(
  html,
  /if\(!midnightSyncDue\(\)\)return true;\s*\n\s*setTimeout\(\(\)=>\{/,
  'the cache-hit launch path must skip its background re-read unless a sync is due'
);
assert.match(
  html,
  /if\(res&&res\.parsed&&res\.parsed\.total\)markSynced\(\);/,
  'the background re-read must stamp the day once it succeeds, or it fires again on the next launch'
);

/* An app left open across midnight should refresh at midnight, not up to 30 minutes later. */
assert.match(
  html,
  /function scheduleMidnightSync\(\)\{[\s\S]*?next\.setHours\(24,0,0,0\);[\s\S]*?_midnightTimer=setTimeout\([\s\S]*?maybeAutoSync\(\);scheduleMidnightSync\(\);/,
  'a timer must fire at the next midnight and re-arm itself for the following night'
);
