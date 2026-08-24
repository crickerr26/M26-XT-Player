import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /id="resumeChoiceSheet"[\s\S]*?id="resumeBegin"[\s\S]*?id="resumeContinue"/,
  'Movie/series replay should show a beginning-or-continue choice sheet'
);

assert.match(
  html,
  /function resumeChoiceFor\(x\)[\s\S]*?typeOf\(x\)==='live'[\s\S]*?RESUME_MIN_SECONDS/,
  'Resume choices should apply to movies/series only after meaningful watch time'
);

assert.match(
  html,
  /async function choosePlaybackStart\(x\)[\s\S]*?resumeChoiceFor\(x\)[\s\S]*?showResumeChoice/,
  'Opening a watched item should ask which start position to use'
);

assert.match(
  html,
  /S\.resumeOverride\[keyOf\(x\)\]=startAt/,
  'The chosen start position should be passed into the playback resume system'
);

assert.match(
  html,
  /getResume:x=>\(S\.resumeOverride&&Object\.prototype\.hasOwnProperty\.call\(S\.resumeOverride,keyOf\(x\)\)\)\?S\.resumeOverride\[keyOf\(x\)\]:\(\(S\.resume&&S\.resume\[keyOf\(x\)\]\)\|\|0\)/,
  'The inbuilt player should honor a one-shot start-from-beginning override'
);

assert.match(
  html,
  /delete S\.resume\[keyOf\(S\.current\)\]/,
  'Saved resume progress should clear near the end of a finished movie/episode'
);
