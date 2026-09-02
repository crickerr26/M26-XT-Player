import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /viewModes:\{live:'list',vod:'list',series:'list'\}/,
  'Catalog defaults must be list-only for Live TV, Movies, and Series'
);

assert.match(
  html,
  /S\.viewModes=\{live:'list',vod:'list',series:'list'\}/,
  'Saved grid preferences must be ignored and reset to list-only'
);

assert.doesNotMatch(
  html,
  /id="viewToggle"|toggleViewMode|updateViewToggle|gridview|gridCardHtml|\.gcard|\.gposter|\.gtitle|\.gmeta|\.gstar|\.ginfo|\.gph|\.gchNum|data-info|\.gcard/,
  'The grid/list toggle and gridview rendering path must be removed'
);
