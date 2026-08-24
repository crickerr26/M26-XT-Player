import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /function toggleInlinePip\(force\)[\s\S]*?\$\('playerBox'\)\.classList\.toggle\('pipFloat',on\)/,
  'PiP must have an in-page floating-player fallback for browsers without native PiP APIs'
);

assert.match(
  html,
  /function pip\(\)[\s\S]*?return toggleInlinePip\(true\)/,
  'The PiP button must use the in-page fallback when standard and WebKit PiP are unavailable'
);

assert.match(
  html,
  /requestPictureInPicture\(\)\.catch\(\(\)=>toggleInlinePip\(true\)\)/,
  'If a browser advertises native PiP but rejects it, the PiP button should fall back to the in-page mini-player'
);

assert.match(
  html,
  /const hideBar=\(\)=>\{[\s\S]*?classList\.contains\('pipFloat'\)[\s\S]*?return[\s\S]*?classList\.remove\('showbar'\)/,
  'The floating PiP controls must stay clickable so the button can exit mini-player mode'
);

assert.match(
  html,
  /setTimeout\(\(\)=>\{[\s\S]*?!pb\.classList\.contains\('pipFloat'\)[\s\S]*?classList\.remove\('showbar'\)/,
  'The auto-hide timer must not hide controls while the in-page PiP fallback is active'
);

assert.match(
  html,
  /function cleanup\(\)[\s\S]*?toggleInlinePip\(false\)/,
  'Cleanup should exit the in-page PiP fallback when playback stops or changes'
);

assert.match(
  html,
  /\.player\.pipFloat/,
  'The floating fallback needs CSS so it is visible as a mini-player'
);
