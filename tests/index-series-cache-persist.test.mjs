import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.16 (owner report, after v25.15: "Movies and live TVs loaded the previously loaded contents,
   but Series loaded again after a force close and reopen").

   Root cause: every path that enriches a tab AFTER sign-in funnels through adoptIntoPlaylist() and
   updated S.m3u in memory only. The device library cache had been written earlier during sign-in
   and was never written again. On a line whose Series exist ONLY via the Xtream API fallback
   (v24.7 — some panels never put Series in get.php's M3U at all), every launch therefore restored
   a model with an empty series list, which made loadType()'s "is this tab empty?" check true,
   which re-ran the whole fallback. Live and Movies never showed it because both come straight out
   of the M3U the cache already held — which is exactly the split the owner reported. */

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

const writes = [];
const context = {
  S: {
    source: 'm3u',
    rawUrl: 'http://panel.example:8080',
    user: 'bob',
    playlistUrl: 'http://panel.example:8080/get.php',
    m3u: { live: [{ a: 1 }, { a: 2 }], vod: [{ b: 1 }], series: [], total: 3 },
  },
  libWrite: (base, user, model, src) => { writes.push({ base, user, model, src }); },
};
vm.createContext(context);
vm.runInContext(extractFunction('function adoptIntoPlaylist'), context);

/* The Xtream fallback's own call: series arrive from player_api.php and must be persisted. */
const seriesCats = [{ category_id: 'xts1', category_name: 'Drama' }];
const seriesArr = [{ series_id: 'xts9', name: 'A Show', _xtreamSeriesId: 9 }, { series_id: 'xts10', name: 'B Show' }];
context.adoptIntoPlaylist('series', seriesCats, seriesArr);

assert.equal(context.S.m3u.series.length, 2, 'the in-memory model must carry the fetched series');
assert.equal(writes.length, 1, 'adopting an enriched tab must write the device cache');
assert.equal(writes[0].base, 'http://panel.example:8080', 'the cache must be keyed by the same line base the launch path reads');
assert.equal(writes[0].user, 'bob');
assert.equal(writes[0].model.series.length, 2, 'the SAVED model must contain the series, or the next launch refetches them');

/* total must be recomputed: libRead and libWrite both refuse a model without one, and the
   launch-time background refresh compares against it to decide whether to swap what is on screen.
   Leaving it at the sign-in figure would make a library that just grew look unchanged. */
assert.equal(context.S.m3u.total, 5, 'total must count live + vod + series after the adopt, not stay at the sign-in figure');
assert.equal(writes[0].model.total, 5, 'the saved model must carry the corrected total');

/* The vod path (the full-catalogue top-up) persists the same way. */
context.adoptIntoPlaylist('vod', [], [{ b: 1 }, { b: 2 }, { b: 3 }]);
assert.equal(writes.length, 2, 'a Movies top-up must persist too');
assert.equal(context.S.m3u.total, 7, 'total must follow the Movies growth as well');

/* An unknown type changes nothing and must not write. */
context.adoptIntoPlaylist('live', [], [{ z: 1 }]);
assert.equal(writes.length, 2, 'an unhandled type must not touch the model or the cache');

/* A non-m3u source (a MAG portal) has no parsed playlist model to persist. */
const stalker = { S: { source: 'stalker', m3u: null }, libWrite: () => { throw new Error('must not write'); } };
vm.createContext(stalker);
vm.runInContext(extractFunction('function adoptIntoPlaylist'), stalker);
assert.doesNotThrow(() => stalker.adoptIntoPlaylist('series', [], [{ n: 1 }]), 'a non-m3u source must bail before writing');
