import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.07 ran YezPlayer.verifyPort() on the IN-APP player path (playItemBasic) — the same proactive
   ranged probe the VLC handoff uses — to settle the panel's published port before the route walk
   started.
   v25.14 REMOVED it: movies stopped playing altogether (owner diagnostics: every route failing, two
   with "media element src not supported"). The probe gave the in-app walk a way to be wrong that it
   does not have on its own — ONE failed probe, for any reason, writes that host:port into GATE
   MEMORY permanently, which demotes every route on the panel's real port behind untested "(default
   port)" variants that serve nothing. The panel answers those with an HTML error page under a 200,
   which IS "src not supported", and gate memory learns from that verdict too — so the wrong verdict
   re-confirms itself on every play and the line never recovers on its own.
   VLC still needs it (it is handed one address and nothing it does is observable from here), so the
   external handoff keeps the call. This test pins both halves. */

/* The removed block was the only non-live-gated probe in the file: a `typeOf(x)!=='live'` wrapper
   around a verifyPort() call, sitting in playItemBasic just before playItemPreview(). Asserting on
   that exact shape is more reliable than trying to brace-match playItemBasic's body out of the
   file — the body contains regex and template literals with unbalanced braces, which walks a naive
   matcher straight past the end of the function and into the VLC path that legitimately keeps its
   own call. */
assert.doesNotMatch(
  html,
  /typeOf\(x\)!=='live'\)\{[\s\S]{0,400}?YezPlayer\.verifyPort/,
  'the in-app player path must NOT run the proactive port probe — it learns a bad port by failing on it, which self-corrects'
);

/* The probe legitimately stays on the two paths that are handed ONE address and cannot observe the
   result: the VLC handoff (asserted below) and startDownload(), which the owner confirmed working
   at v25.10 and which v25.14 deliberately does not touch. */
assert.match(
  html,
  /if\(window\.YezPlayer&&window\.YezPlayer\.verifyPort\)raw=await window\.YezPlayer\.verifyPort\(raw,yezProbeOriginal\)/,
  'startDownload() keeps its own port check — downloads were confirmed working and are out of scope here'
);

/* The external (VLC) handoff must keep it — that is the case the probe was written for. */
assert.match(
  html,
  /playItemExternal[\s\S]*?YezPlayer\.verifyPort\(raw,yezProbeOriginal\)/,
  'playItemExternal() must still verify the port before handing an address to VLC'
);

/* A device that already ran v25.07-v25.13 has the bad verdict in localStorage, where it survives
   every reload — so the fix has to actively clear it once, or an already-broken phone stays broken
   on a build that is itself fixed. */
assert.match(
  html,
  /const K='media26-gatereset-v25\.14';/,
  'there must be a one-time reset marker so the wipe runs exactly once per device'
);
assert.match(
  html,
  /if\(YezPlayer\.forgetGates\)YezPlayer\.forgetGates\(\);\s*\n\s*if\(YezPlayer\.forgetSlow\)YezPlayer\.forgetSlow\(\);/,
  'the one-time reset must clear both gate memory and slow memory'
);
assert.match(
  html,
  /localStorage\.removeItem\('yez\.wonRoute\.v1'\);localStorage\.removeItem\('yez\.wonRoute\.v1\.global'\);/,
  'the one-time reset must also clear route memory, which may have learned a winner that no longer works'
);
