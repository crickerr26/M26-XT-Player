import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.07 (owner, with hard evidence across three different movies on v25.06: "Direct" still won
   route 1 in 14-21s every time, and Server Relay never even got tried — proving this line answers
   https, so v25.06's Cloudflare-Worker theory doesn't explain it here. VLC still opened the same
   titles in under 2s). The one real difference: playItemExternal() (the VLC launch) already calls
   YezPlayer.verifyPort() PROACTIVELY, before building VLC's URL, to settle whether the panel's
   published port truly serves media — the in-app tap-to-play path never did this, so it only ever
   learned a bad port REACTIVELY, from an actual failure, and this line's slow port never fails
   outright (it "succeeds", just slowly), so the walk had no reason to ever try the faster
   alternate port sitting right behind it. playItemBasic() must run the same proactive probe VLC
   already gets, for VOD/series (not live, which has its own separately-tuned instant-tap budget),
   before the actual play attempt starts. */
assert.match(
  html,
  /if\(_playTok!==S\.playAttempt\)return;\s*\/\* a later tap already won while this one was resolving \*\/\s*\n\s*\/\* v25\.07[\s\S]*?if\(typeOf\(x\)!=='live'\)\{\s*\n\s*try\{\s*\n\s*const raw=String\(x\.direct_source\|\|x\.stream_url\|\|''\)\.trim\(\);\s*\n\s*if\(raw&&window\.YezPlayer&&YezPlayer\.verifyPort\)await YezPlayer\.verifyPort\(raw,yezProbeOriginal\);\s*\n\s*\}catch\(e\)\{\}\s*\n\s*if\(_playTok!==S\.playAttempt\)return;/,
  'playItemBasic() must proactively verifyPort() for VOD/series before playing, the same way playItemExternal() already does for VLC — and must re-check the tap-order token afterward'
);

/* The probe must be gated on typeOf(x)!=='live' specifically — a live channel tap keeps its own,
   separately-tuned instant-response budget untouched. */
const basicFnStart = html.indexOf('async function playItemBasic');
const basicFnBody = html.slice(basicFnStart, html.indexOf('async function playItemPreview', basicFnStart));
assert.match(
  basicFnBody,
  /if\(typeOf\(x\)!=='live'\)\{[\s\S]*?YezPlayer\.verifyPort\(raw,yezProbeOriginal\);[\s\S]*?\}/,
  'the proactive verifyPort() probe must live inside an if(typeOf(x)!==\'live\') guard'
);
