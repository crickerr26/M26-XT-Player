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

/* v25.16 moved the call into a shared leaving() so pagehide and blur can reach it too — they land
   EARLIER than visibilitychange on iOS, while the element is still live, which is the difference
   between WebKit honouring the PiP request and ignoring it. The guarantee under test is unchanged:
   going to the background asks for real OS PiP, never the in-page fake mini-player. */
assert.match(
  html,
  /const leaving=\(\)=>\{[\s\S]*?enterNativePip\(v,\{background:true,silent:true\}\);/,
  'Backgrounding should try true OS PiP instead of an in-page fake mini-player'
);
assert.match(
  html,
  /document\.addEventListener\('visibilitychange',\(\)=>\{document\.hidden\?\(stopRetry\(\),leaving\(\)\):returning\(\)\}\);[\s\S]{0,200}?window\.addEventListener\('pagehide',[\s\S]{0,60}?leaving\(\)\}\);\s*\n\s*window\.addEventListener\('blur',leaving\);/,
  'visibilitychange, pagehide and blur must all reach the same guarded PiP attempt'
);

/* When the OS suspends playback anyway (it will, on iOS, whenever PiP does not engage), coming
   back should not leave the customer staring at a frozen frame.

   v25.18 makes this a RETRY rather than a single check. v25.16 read v.paused once, the instant the
   app came back, and gave up if it was false — but iOS very often has not applied its own pause yet
   at that moment, so that one check landed in the gap and the flag was already spent. */
assert.match(
  html,
  /resumeTimer=setInterval\(\(\)=>\{[\s\S]*?if\(tries>8\|\|document\.hidden\|\|!S\.current\|\|v\.ended\|\|!v\.paused\)\{stopRetry\(\);return\}/,
  'the resume must retry for a window and stop as soon as it is playing, hidden again, or the title changed'
);
assert.match(
  html,
  /if\(Date\.now\(\)-_lastManualPauseAt<1200\)\{stopRetry\(\);return\}/,
  'a pause the user pressed themselves must never be undone by the auto-resume'
);
assert.match(
  html,
  /const returning=\(\)=>\{\s*\n\s*try\{\s*\n\s*eqResume\(\);/,
  'returning must resume the Web Audio graph — iOS suspends it with the app, which silently flattens the equalizer'
);

/* v25.18 REVERSED this (owner report: "the colour profile and equalizer are not working when the
   video changed to full screen"). Fullscreen used to hand the stream to the video element's own
   webkitEnterFullscreen on anything iOS-like — the OS player, which is not a DOM node. The colour
   profile is a CSS filter on the <video> and cannot reach it, the Web Audio graph the equalizer and
   volume boost run through is bypassed, and every HTML overlay including the watermark disappears,
   which the v31 note in fs() had already warned about. Neither setting was broken; fullscreen was
   putting the video somewhere they could not apply.

   Now: real element fullscreen where the browser has it (iPad, Android, desktop — the DOM survives
   there), and an in-page fullscreen where it does not (iPhone has no Element.requestFullscreen at
   all). webkitEnterFullscreen is not used anywhere: it is the one mode in which these cannot work. */
assert.doesNotMatch(
  html,
  /\bv?\.?webkitEnterFullscreen\s*\(/,
  'the OS video-fullscreen path must stay gone — it is what put the video beyond reach of the colour filter and the equalizer'
);
assert.match(
  html,
  /function fs\(\)\{[\s\S]*?if\(box\.requestFullscreen\)\{box\.requestFullscreen\(\)\.catch\(\(\)=>setCssFullscreen\(true\)\);return\}[\s\S]*?setCssFullscreen\(true\);/,
  'fullscreen must prefer real element fullscreen and fall back to the in-page one, never to the OS player'
);
assert.match(
  html,
  /\.player\.cssFull\{position:fixed!important;inset:0;[^}]*z-index:300/,
  'the in-page fullscreen must actually fill the viewport'
);
/* showBar() refuses to draw the control bar once S.current is gone, so a cssFull box left up with
   no stream would be a black sheet over the whole screen with no X to dismiss it. */
assert.match(
  html,
  /function cleanup\(\)\{[\s\S]{0,400}?if\(typeof cssFullscreenOn==='function'&&cssFullscreenOn\(\)\)setCssFullscreen\(false\)/,
  'tearing down playback must leave the in-page fullscreen, or the user is stranded on a black screen'
);
assert.match(
  html,
  /if\(cssFullscreenOn\(\)\)setCssFullscreen\(false\);\};\}/,
  'the close button must also be a way out of the in-page fullscreen'
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
