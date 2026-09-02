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
  /function nativePipFailed\(opts\)[\s\S]*?!\(opts&&opts\.background\)&&mobile\(\)&&!document\.hidden[\s\S]*?return toggleInlinePip\(true\)/,
  'Manual mobile PiP failures should use the in-page mini-player only while the app is visible'
);

assert.match(
  html,
  /function iosLike\(\)[\s\S]*?iphone\|ipad\|ipod[\s\S]*?macintosh[\s\S]*?ontouchend/,
  'The player should detect iPhone/iPad style Safari so native video fullscreen and WebKit PiP are preferred'
);

assert.match(
  html,
  /function nativePipSupported\(v\)[\s\S]*?webkitSupportsPresentationMode\('picture-in-picture'\)[\s\S]*?if\(iosLike\(\)\)return false[\s\S]*?document\.pictureInPictureEnabled&&v\.requestPictureInPicture/,
  'iOS/PWA PiP support should trust WebKit source-level support instead of the standard API alone'
);

assert.match(
  html,
  /function enterNativePip\(v,opts\)[\s\S]*?nativePipSupported\(v\)[\s\S]*?webkitSetPresentationMode\('picture-in-picture'\)[\s\S]*?if\(!iosLike\(\)&&document\.pictureInPictureEnabled&&v\.requestPictureInPicture\)/,
  'PiP entry should use one helper that prefers WebKit PiP and avoids standard PiP on iOS-like browsers'
);

assert.match(
  html,
  /requestPictureInPicture\(\)\.catch\(\(\)=>nativePipFailed\(opts\)\)/,
  'If a browser advertises native PiP but rejects it, the PiP helper should preserve the manual/background fallback path'
);

assert.match(
  html,
  /visibilitychange[\s\S]*?if\(document\.hidden\)[\s\S]*?enterNativePip\(v,\{background:true,silent:true\}\)/,
  'When the app is hidden, background playback should try true OS PiP instead of an in-page fake mini-player'
);

assert.match(
  html,
  /function fs\(\)[\s\S]*?if\(iosLike\(\)&&v&&v\.webkitEnterFullscreen\)[\s\S]*?v\.webkitEnterFullscreen\(\);return/,
  'On iPhone/iPad, fullscreen should use the native video fullscreen path before container fullscreen'
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
