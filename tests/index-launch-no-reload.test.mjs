import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.15 (owner report, with a screenshot of the home screen right after a force-close and
   restart: Movies and Series both sitting on "loading…" while Live TV read "✓ load completed",
   with a complete 64,543-title library already restored from the device cache).

   Two separate things re-read the provider on EVERY launch, and both had to be gated:
     1. loadPlaylistSource()'s cache-hit path kicked off a full background re-fetch 1.5s in.
     2. loadType() re-fetched the full get.php document to "top up" Movies and Series — which is
        what actually put those two cards back into a loading state, since Live TV has no top-up.
   Neither bought anything visible: both are merges into a library already on screen. */

/* The top-up still runs unconditionally in the two cases it was written for — an EMPTY tab (the
   v13.3 live-only-playlist case) and an explicit refresh — and otherwise waits for the day's
   midnight sync. */
assert.match(
  html,
  /const _haveTab=type==='vod'\?\(S\.vod&&S\.vod\.length\):\(S\.series&&S\.series\.length\);\s*\n\s*const _topUpDue=!_haveTab\|\|S\._forceTopUp\|\|midnightSyncDue\(\);\s*\n\s*if\(type!=='live'&&\(S\.user\|\|stalkerMac\(\)\)&&_topUpDue\)\{/,
  'the Movies/Series top-up must be gated on an empty tab, an explicit refresh, or a due midnight sync'
);

/* An explicit refresh must still do the full top-up — going and asking the provider is the entire
   point of tapping refresh. */
assert.match(
  html,
  /_resyncing=true;[\s\S]{0,400}?S\._forceTopUp=true;/,
  'resyncSource() must force the top-up on for the duration of an explicit refresh'
);

/* The subtle part: refreshAll() fires the Movies/Series loads WITHOUT awaiting them (v7.7 — the app
   opens on Live TV rather than waiting for all three). So clearing the flag in resyncSource's
   finally would win the race against the very loads it is meant to cover, turning an explicit
   refresh into the same no-op an ordinary launch now performs. The flag is held open until those
   loads settle instead. */
assert.match(
  html,
  /_bgTabLoads=Promise\.all\(\[loadType\('vod'\),loadType\('series'\)\]\)\.catch\(\(\)=>\{\}\);/,
  'refreshAll() must expose its un-awaited background tab loads so a caller can wait for them'
);
assert.match(
  html,
  /const _pending=_bgTabLoads;\s*\n\s*if\(_pending&&_pending\.then\)_pending\.then\(\(\)=>\{S\._forceTopUp=false\},\(\)=>\{S\._forceTopUp=false\}\);/,
  'the force-top-up flag must survive until the background tab loads have run their check'
);
assert.doesNotMatch(
  html,
  /_resyncing=false;S\._forceTopUp=false;/,
  'the flag must not be cleared synchronously in the finally — that is the race this guards against'
);

/* The on-device library must outlive a day, or "load the last loaded playlists" still ends in a
   full foreground re-download for anyone who skips a day. */
assert.match(
  html,
  /LIB_TTL_MS=7\*24\*60\*60\*1000/,
  'the device library cache must not expire after a single day'
);
