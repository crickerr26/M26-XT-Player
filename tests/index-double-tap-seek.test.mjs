import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.16 (owner request, with a screenshot marking the left and right edges of the video):
   double-tap the left or right side to jump 10 seconds back or forward, the way VLC does. */

/* The middle third is deliberately NOT a seek zone — that is where a tap to show/hide the
   controls naturally lands, and a stray double-tap there jumping the movie would be worse than
   having no gesture at all. */
const zoneSrc = html.match(/const zoneOf=x=>\{[\s\S]*?\};/);
assert.ok(zoneSrc, 'the zone helper must exist');

const context = {
  box: { getBoundingClientRect: () => ({ left: 0, width: 400 }) },
};
vm.createContext(context);
vm.runInContext(zoneSrc[0].replace('const zoneOf=', 'globalThis.zoneOf='), context);

assert.equal(context.zoneOf(10), 'l', 'the far left is a rewind zone');
assert.equal(context.zoneOf(139), 'l', 'just inside the left third is still rewind');
assert.equal(context.zoneOf(200), '', 'the middle is neutral — that is where tap-to-toggle-controls lives');
assert.equal(context.zoneOf(141), '', 'past the left third is neutral');
assert.equal(context.zoneOf(261), 'r', 'past the right third is forward');
assert.equal(context.zoneOf(399), 'r', 'the far right is a forward zone');

/* Measured against the box's own rect, not the window, so it stays correct in landscape, in
   fullscreen and in the floating PiP — all of which move the player away from the viewport edge. */
assert.match(zoneSrc[0], /box\.getBoundingClientRect\(\)/, 'zones must be measured from the player box, not the window');
assert.match(zoneSrc[0], /if\(!r\.width\)return ''/, 'a zero-width box must yield no zone rather than dividing by zero');

/* The SECOND tap seeks; the first is only remembered, so an ordinary single tap still falls
   through to the existing tap-to-unmute / toggle-controls handler. */
assert.match(
  html,
  /if\(!moved&&isVod\(\)\)\{[\s\S]*?if\(z&&z===lastTapZone&&now-lastTapAt<DOUBLE_TAP_MS\)\{[\s\S]*?seekBy\(z==='l'\?-10:10\);/,
  'a second tap in the same side zone within the window must seek by 10 seconds'
);
assert.match(html, /const DOUBLE_TAP_MS=320;/, 'the double-tap window must be an explicit constant');
assert.match(
  html,
  /if\(!moved&&isVod\(\)\)/,
  'the gesture must be limited to Movies/Series — a live channel has nothing to seek'
);

/* A drag or a long-press must not be mistaken for a tap. */
assert.match(html, /if\(longActive\)\{[\s\S]*?return\}\s*\n\s*if\(mode==='vol'\)\{[\s\S]*?return\}/, 'the long-press and volume gestures must return before the tap check');

/* The element's own click handler fires AFTER touchend and would otherwise toggle the control bar
   on top of every seek. */
assert.match(html, /S\.tapSeekAt=now;/, 'a double-tap seek must record its timestamp for the click handler to see');
assert.match(
  html,
  /if\(S\.tapSeekAt&&Date\.now\(\)-S\.tapSeekAt<500\)return;/,
  "the video's click handler must sit out the click that follows a double-tap seek"
);
