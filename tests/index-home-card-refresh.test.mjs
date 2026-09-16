import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.15 (owner request: "replace the arrow button on each category to have a refresh button, so if
   that clicked the contents should be refreshed"). The three catalogue cards carry a refresh control
   where the → used to be. Downloads keeps its arrow — it is a destination, not a catalogue, and has
   nothing to re-read. */

for (const [tab, label] of [['live', 'Live TV'], ['vod', 'Movies'], ['series', 'Series']]) {
  assert.match(
    html,
    new RegExp(`<span class="hc-arrow hc-refresh" data-refresh="${tab}" role="button" tabindex="0" title="Refresh ${label}"`),
    `the ${label} card must carry a refresh control in place of its arrow`
  );
}

assert.doesNotMatch(
  html,
  /<span class="hc-txt"><b>(Live TV|Movies|Series)<\/b>[\s\S]{0,200}?<\/span>\s*\n\s*<span class="hc-arrow">→<\/span>/,
  'no catalogue card should still render the plain → arrow'
);
assert.match(
  html,
  /<b>Downloads<\/b>[\s\S]*?<span class="hc-arrow">→<\/span>/,
  'the Downloads card keeps its arrow — there is no catalogue behind it to refresh'
);

/* The control reuses .hc-arrow so every existing responsive rule that POSITIONS the arrow (the
   two-column breakpoint pins it absolutely, the compact one shrinks it) keeps applying — otherwise
   the refresh button would need all of that duplicated, and would drift out of step with it. */
assert.match(
  html,
  /\.hc-refresh\{width:38px;height:38px;[^}]*place-items:center/,
  'the refresh control needs its own appearance on top of the inherited .hc-arrow positioning'
);
assert.match(
  html,
  /@media\(hover:hover\)\{\.home-card:hover \.hc-refresh\{transform:none\}/,
  "the arrow's slide-right-on-hover must be cancelled for the refresh control"
);
assert.match(html, /\.hc-refresh\.spinning svg\{animation:hcSpin \.9s linear infinite\}/, 'the icon must spin while a refresh is running');
assert.match(html, /\.hc-refresh\.spinning\{pointer-events:none/, 'a refresh already in flight must not be re-tappable');

/* The control sits INSIDE the card's own button, so it has to be claimed before the card's
   open-this-category branch — and in the SAME listener, because a second listener bound to #home
   would still run: stopPropagation() does not stop a sibling listener on the element the event has
   already reached. */
assert.match(
  html,
  /\$\('home'\)\.addEventListener\('click',e=>\{\s*\n\s*const r=e\.target\.closest\('\[data-refresh\]'\);\s*\n\s*if\(r\)\{e\.preventDefault\(\);e\.stopPropagation\(\);homeCardRefresh\(r\);return\}\s*\n\s*const c=e\.target\.closest\('\[data-go\]'\);if\(c\)goCategory\(c\.dataset\.go\)/,
  'the refresh target must be claimed ahead of the card-opens-category branch, in the one #home listener'
);

/* refreshTab() already existed for the per-tab buttons and does the whole job (resync + reload that
   one tab + report what changed), so the card button must reuse it rather than grow a second path. */
assert.match(
  html,
  /async function homeCardRefresh\(el\)\{[\s\S]*?await refreshTab\(tab\);/,
  'the card refresh must go through the existing refreshTab(), not a parallel implementation'
);
assert.match(
  html,
  /async function homeCardRefresh\(el\)\{[\s\S]*?if\(_resyncing\)\{toast\('Already refreshing…'\);return\}/,
  'tapping refresh while one is already running must be refused, as the footer button does'
);
