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
assert.equal(context.zoneOf(200), 'c', 'the middle third is its own zone');
assert.equal(context.zoneOf(141), 'c', 'past the left third is the middle');
assert.equal(context.zoneOf(261), 'r', 'past the right third is forward');
assert.equal(context.zoneOf(399), 'r', 'the far right is a forward zone');

/* v25.19 gave the middle third a job — fill-vs-fit — but only in fullscreen, and never a seek.
   Switching zoom is instant, visible and undone by repeating the gesture, so a stray double-tap
   costs nothing; a stray seek would have cost the viewer their place, which is why the middle was
   left inert in v25.16. */
assert.match(
  html,
  /const seekZone=\(z==='l'\|\|z==='r'\)&&isVod\(\);\s*\n\s*const zoomZone=z==='c'&&anyFullscreen\(\);/,
  'seeking needs a timeline and zoom needs fullscreen — each zone is armed only where its action means something'
);
assert.match(
  html,
  /if\(zoomZone\)\{toggleZoom\(\);\}/,
  'a middle double-tap in fullscreen must toggle the zoom mode'
);
/* A zone that is not armed must record nothing, or a tap there could pair with a later tap
   elsewhere and fire an action the viewer never asked for. */
assert.match(
  html,
  /if\(seekZone\|\|zoomZone\)\{lastTapAt=now;lastTapZone=z\}\s*\n\s*else\{lastTapAt=0;lastTapZone=''\}/,
  'an unarmed zone must not record a first tap'
);

/* Fill only ever applies in fullscreen: inline the box is already close to the video's own shape,
   so cropping there would be loss for nothing. */
assert.match(
  html,
  /box\.classList\.toggle\('zoomFill',anyFullscreen\(\)&&savedZoom\(\)==='fill'\);/,
  'the fill crop must be conditional on being fullscreen'
);
assert.match(html, /\.player\.zoomFill video\{object-fit:cover\}/, 'filling is object-fit:cover on the video');
assert.equal(
  /function savedZoom\(\)\{[^}]*==='fit'\?'fit':'fill'/.test(html),
  true,
  'zoom must default to filling the screen, which is what was asked for'
);

/* Measured against the box's own rect, not the window, so it stays correct in landscape, in
   fullscreen and in the floating PiP — all of which move the player away from the viewport edge. */
assert.match(zoneSrc[0], /box\.getBoundingClientRect\(\)/, 'zones must be measured from the player box, not the window');
assert.match(zoneSrc[0], /if\(!r\.width\)return ''/, 'a zero-width box must yield no zone rather than dividing by zero');

/* The SECOND tap acts; the first is only remembered, so an ordinary single tap still falls
   through to the existing tap-to-unmute / toggle-controls handler. */
assert.match(
  html,
  /if\(\(seekZone\|\|zoomZone\)&&z===lastTapZone&&now-lastTapAt<DOUBLE_TAP_MS\)\{[\s\S]*?seekBy\(z==='l'\?-10:10\);/,
  'a second tap in the same armed zone within the window must fire that zone’s action'
);
assert.match(html, /const DOUBLE_TAP_MS=320;/, 'the double-tap window must be an explicit constant');
/* Seeking specifically stays limited to Movies/Series — a live channel has no timeline to move
   along. (The zoom zone is not: a live channel can be pillarboxed just the same.) */
assert.match(
  html,
  /const seekZone=\(z==='l'\|\|z==='r'\)&&isVod\(\);/,
  'the seek zones must stay limited to Movies/Series'
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
