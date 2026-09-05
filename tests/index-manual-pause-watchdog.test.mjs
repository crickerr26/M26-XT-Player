import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /let _lastManualPauseAt=0,_manualPauseHeld=false;[\s\S]*?function markManualPause\(\)\{_lastManualPauseAt=Date\.now\(\);_manualPauseHeld=true\}[\s\S]*?function clearManualPause\(\)\{_manualPauseHeld=false\}[\s\S]*?function manualPauseActive\(v\)\{return _manualPauseHeld&&v&&v\.paused&&!v\.ended\}/,
  'Manual pause state should persist until the user resumes or starts another title'
);

assert.match(
  html,
  /function cleanup\(\)\{[\s\S]*?clearManualPause\(\);[\s\S]*?v\.pause\(\);v\.removeAttribute\('src'\)/,
  'Starting or cleaning up a stream should clear a previous manual pause hold'
);

assert.match(
  html,
  /const now=Date\.now\(\),t=v\.currentTime\|\|0,be=bufEnd\(\);[\s\S]*?if\(E\.started&&manualPauseActive\(v\)\)\{[\s\S]*?E\.lastProgress=now;E\.frozenAt=0;E\.progressStreak=0;[\s\S]*?S\.timer=setTimeout\(beat,1000\);return[\s\S]*?\}[\s\S]*?const stalled=now-E\.lastProgress;/,
  'Playback watchdog should not treat a deliberate pause as a stalled stream that needs play() recovery'
);

assert.match(
  html,
  /set\('pause',\(\)=>\{markManualPause\(\);v\.pause\(\)\}\)/,
  'Pausing from OS media controls should also hold the watchdog paused'
);
