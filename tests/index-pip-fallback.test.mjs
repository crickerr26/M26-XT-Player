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
  /function nativePipFailed\(\)[\s\S]*?if\(mobile\(\)\)return toggleInlinePip\(true\)/,
  'Mobile PiP should fall back to the in-page mini-player whenever native PiP fails'
);

assert.match(
  html,
  /requestPictureInPicture\(\)\.catch\(\(\)=>nativePipFailed\(\)\)/,
  'If a browser advertises native PiP but rejects it, the PiP button should use the shared fallback path'
);

assert.match(
  html,
  /webkitSetPresentationMode\('picture-in-picture'\);return\}catch\(e\)\{return nativePipFailed\(\)\}/,
  'If WebKit PiP rejects on mobile, the button should not fail silently'
);

assert.match(
  html,
  /@media\(max-width:760px\)\{[\s\S]*?\.player\.pipFloat\{left:12px;right:12px;[^}]*width:auto;max-width:none;[^}]*z-index:180/,
  'The mobile mini-player should be wide, stable, and above the bottom controls'
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
