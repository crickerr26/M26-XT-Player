import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.20 (owner report, second fullscreen screenshot: filling the screen still left a band top and
   bottom). Measured off that screenshot: the picture reached both side edges, and the band was
   51px. That band is not the app letterboxing anything — it is the movie. These files carry a
   2.39:1 picture inside a 16:9 frame with the bars burned in, and object-fit:cover only crops the
   frame to the screen's shape; whatever bar survives inside the frame stays.
   Predicting the leftover from the file's geometry gave 54.7px against 51px measured, which is
   what confirmed the model — so the extra zoom that clears it exactly is computable. */

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

/* The owner's actual screen and a 16:9 file carrying 2.39:1 content. */
const SCREEN_W = 2622, SCREEN_H = 1206;
const video = { clientWidth: SCREEN_W, clientHeight: SCREEN_H, videoWidth: 1920, videoHeight: 1080 };
let scan = { tries: 6, maxF: 803 / 1080 };

const context = { $: () => video, get _barScan() { return scan; }, Math };
vm.createContext(context);
vm.runInContext(extractFunction('function barZoomFactor'), context);

const k = context.barZoomFactor();
assert.ok(Math.abs(k - 1.0998) < 0.002, `the zoom must clear exactly the measured band, got ${k}`);
/* Cross-check it end to end: at that zoom the baked content must reach the full screen height. */
const cover = Math.max(SCREEN_W / 1920, SCREEN_H / 1080);
const contentAfter = cover * 1080 * (803 / 1080) * k;
assert.ok(Math.abs(contentAfter - SCREEN_H) < 1, 'after zooming, the picture itself fills the screen height');

/* A true 16:9 title bakes no bars at all and must not be cropped for nothing. */
scan = { tries: 6, maxF: 1 };
assert.equal(context.barZoomFactor(), 1, 'a file with no baked bars must not be zoomed');
scan = { tries: 6, maxF: 0.99 };
assert.equal(context.barZoomFactor(), 1, 'a sliver too small to be a real bar must not trigger a crop');

/* Nothing measured yet — plain cover, which is what v25.19 already did. */
scan = { tries: 0, maxF: 0 };
assert.equal(context.barZoomFactor(), 1, 'with no measurement the zoom stays at 1');

/* A pathological reading must never eat the picture. */
scan = { tries: 6, maxF: 0.5 };
assert.ok(context.barZoomFactor() <= 1.35, 'the zoom is clamped so a bad reading cannot crop half the frame away');
assert.ok(context.barZoomFactor() >= 1, 'the zoom never shrinks the picture below cover');

/* The scanner itself: the largest picture seen wins, so a fade-to-black can only under-crop; a
   frame with almost nothing lit is ignored; and a canvas the browser refuses to read stops it. */
const scanSrc = extractFunction('function scanBars');
assert.match(scanSrc, /if\(f>_barScan\.maxF\)_barScan\.maxF=f;/, 'the largest content region seen must win');
assert.match(scanSrc, /if\(first<0\|\|lit<H\*0\.3\)return;/, 'a frame too dark to conclude from must be ignored');
assert.match(scanSrc, /if\(f<0\.5\)return;/, 'an implausible reading must be discarded, not acted on');
assert.match(scanSrc, /catch\(e\)\{_barScan\.tries=99\}/, 'a cross-origin frame the canvas cannot read must stop the scan, not throw');
assert.match(scanSrc, /_barScan\.tries>=6/, 'the scan must be bounded');

/* Rotation for a locked phone. */
assert.match(
  html,
  /\.player\.cssFull\.rot90\{width:100dvh;height:100vw;transform-origin:top left;transform:rotate\(90deg\) translateY\(-100%\)\}/,
  'the quarter-turn must size the box to the swapped viewport and pivot about its top-left corner'
);
assert.match(
  html,
  /const want=cssFullscreenOn\(\)&&window\.innerHeight>window\.innerWidth;/,
  'the turn applies only in the in-page fullscreen, and only when the viewport is actually portrait'
);
assert.match(
  html,
  /if\(had!==want\)applyZoom\(\);/,
  'turning the box changes its shape, so the crop must be recomputed with it'
);
