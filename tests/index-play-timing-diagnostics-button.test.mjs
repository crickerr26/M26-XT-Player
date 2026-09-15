import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.04 (owner report: a movie plays but takes 14-16s, "I want it ultra fast"): the route walk
   already records which candidate won and how long every route before it took
   (S.playWonAt/S.playWonLabel/S.routeLog, surfaced by buildDiagnostics()/copyDiagnostics()), but
   the only button that ever called copyDiagnostics() lived in the loading/failure overlay, which
   disappears the moment a title starts PLAYING — so a "it's slow but it does play" report had no
   way to be captured with real numbers. Stream Tools (reachable at any time, including right after
   a slow-but-successful play) now has its own button wired to the same existing function. */
assert.match(
  html,
  /<button class="pillbtn primary" id="nativeDoctor">Connection Test<\/button><button class="pillbtn" id="nativeLastLog">Copy Last Play Timing<\/button>/,
  'Stream Tools must offer a "Copy Last Play Timing" button next to the Connection Test button'
);

assert.match(
  html,
  /if\(\$\('nativeLastLog'\)\)\$\('nativeLastLog'\)\.onclick=\(\)=>\{copyDiagnostics\(\)\};/,
  'The Copy Last Play Timing button must call the existing copyDiagnostics() — no new diagnostics logic, just a reachable trigger'
);
