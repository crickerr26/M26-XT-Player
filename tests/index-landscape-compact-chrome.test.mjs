import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.13 (owner request: "landscape wise fonts and icons more tiny"). v25.12 only shrank the
   channel rows; the header, rail, categories and now-playing strip around them were still full
   size, so the compact rows now looked mismatched against everything surrounding them. This
   shrinks the header (logo/title/icon buttons), the rail buttons and their icons, the category
   column (search box/row/star/text), and the now-playing strip (title/favorite/guide button). */

function landscapeBlock() {
  const start = html.indexOf('@media (orientation:landscape) and (max-height:600px){');
  assert.notEqual(start, -1, 'the landscape media query must exist');
  let depth = 0, i = start;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const block = landscapeBlock();

for (const rule of [
  '.logo{width:26px;height:26px;border-radius:7px}',
  '.brand h1{font-size:12.5px}',
  '.iconbtn,.pillbtn{height:26px;border-radius:8px;padding:0 7px;font-size:10px}',
]) {
  assert.ok(block.includes(rule), `landscape block must shrink the header via: ${rule}`);
}

/* the rail/header icons carry an inline width/height on the <svg> itself (kept inline so they
   also render correctly outside this media query) — inline styles beat any external stylesheet
   rule regardless of selector specificity, so the landscape overrides for them MUST use
   !important or they silently do nothing. */
assert.match(block, /\.iconbtn svg\{width:14px!important;height:14px!important\}/, 'header icon svgs need an !important override to actually shrink');
assert.match(block, /\.landRailBtn svg\{width:14px!important;height:14px!important\}/, 'rail icon svgs need an !important override to actually shrink');
assert.match(block, /\.landNPBtn svg\{width:11px!important;height:11px!important\}/, 'the TV Guide button\'s svg needs an !important override to actually shrink');

for (const rule of [
  '.landRailBtn{width:28px;height:28px;border-radius:8px}',
  '.searchbox input{height:30px;border-radius:8px;padding:0 8px}',
  '.cat{min-height:26px;padding:4px 6px;margin-bottom:3px;border-radius:7px}',
  '.catStar{width:18px;height:18px;font-size:11px;border-radius:5px}',
  '.catName{font-size:10px}',
  '.landNPInfo b{font-size:11px}',
  '.landNPFav{width:22px;height:22px;border-radius:6px;font-size:11px}',
  '.landNPBtn{height:22px;padding:0 7px;font-size:9px;gap:4px}',
]) {
  assert.ok(block.includes(rule), `landscape block must shrink: ${rule}`);
}
