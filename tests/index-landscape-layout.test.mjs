import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.11 (owner request, approved from a published mockup first): landscape mode was a cramped
   two-pane layout (video + channel list, categories hidden behind the menu drawer). The owner
   asked for a four-pane layout instead — icon rail, categories, channel/title list, player —
   with categories and top-level navigation always visible, matching a reference screenshot of a
   competing app. */

assert.match(
  html,
  /<nav class="landRail" id="landRail">[\s\S]*?<\/nav>\s*\n\s*<aside class="panel side" id="side">/,
  'the icon rail must sit as the first child of .layout, immediately before the categories aside'
);

assert.match(
  html,
  /<button class="landRailBtn" id="landHome"/,
  'the rail must have a Home button'
);
for (const tab of ['live', 'vod', 'series']) {
  assert.match(
    html,
    new RegExp(`<button class="landRailBtn" data-tab="${tab}"`),
    `the rail must have a ${tab} tab button sharing the .tab system's data-tab`
  );
}
assert.match(html, /<button class="landRailBtn" id="landDownloads"/, 'the rail must have a Downloads button');
assert.match(html, /<button class="landRailBtn" id="landSettings"/, 'the rail must have a Settings button');

assert.match(
  html,
  /<\/section>\s*\n\s*<!-- v25\.11:[\s\S]*?<div class="landNowPlaying" id="landNowPlaying">[\s\S]*?<\/div>\s*\n\s*<section class="now">/,
  'the now-playing strip must sit right after the player section and before the .now section'
);
assert.match(html, /<b id="landNPTitle">Choose a channel<\/b>/, 'the strip needs a title element with the idle placeholder');
assert.match(
  html,
  /<button class="landNPFav hidden" id="landNPFav" type="button" data-fav="" title="Favorite"/,
  'the favorite button must reuse the data-fav delegation and start hidden until something is playing'
);
assert.match(
  html,
  /<button class="landNPBtn hidden" id="landNPGuide" type="button" data-epg="" title="TV Guide"/,
  'the guide button must reuse the data-epg delegation and start hidden until a live channel is playing'
);

/* Both the star (data-fav) and the guide (data-epg) buttons are handled entirely by the
   document-level delegated handlers already wired for row buttons and the EPG chip — no new
   click logic should be needed for either, only keeping their dataset attributes in sync. */
assert.match(
  html,
  /function paintLandNowPlaying\(\)\{[\s\S]*?title\.textContent=x\?nameOf\(x\):'Choose a channel';[\s\S]*?fav\.dataset\.fav=k;[\s\S]*?guide\.dataset\.epg=isLive\?keyOf\(x\):'';[\s\S]*?\}/,
  'paintLandNowPlaying() must sync the title, favorite state and EPG availability from S.current'
);

assert.match(
  html,
  /function paintNowPlayingChip\(\)\{\s*\n\s*paintLandNowPlaying\(\);/,
  'paintNowPlayingChip() must also drive paintLandNowPlaying() so every existing S.current call site stays in sync automatically'
);

/* Rail tabs must share the exact same click handler as the drawer's own .tab buttons, and
   active/loading state must be reflected on both, or the two navigation surfaces would drift. */
assert.match(
  html,
  /document\.querySelectorAll\('\.tab,\.landRailBtn\[data-tab\]'\)\.forEach\(b=>b\.onclick=/,
  'rail tab buttons must be wired through the same .tab click-handler loop'
);
assert.match(
  html,
  /function renderAll\(\)\{[\s\S]*?document\.querySelectorAll\('\.tab,\.landRailBtn\[data-tab\]'\)\.forEach\(b=>b\.classList\.toggle\('active',b\.dataset\.tab===S\.tab\)\);/,
  'renderAll() must keep the rail\'s active tab in sync alongside the drawer tabs'
);
assert.match(
  html,
  /if\(\$\('landHome'\)\)\$\('landHome'\)\.onclick=\(\)=>showHome\(\);/,
  'Home rail button must reuse showHome()'
);
assert.match(
  html,
  /if\(\$\('landDownloads'\)\)\$\('landDownloads'\)\.onclick=openDownloadsSheet;/,
  'Downloads rail button must reuse openDownloadsSheet()'
);
assert.match(
  html,
  /if\(\$\('landSettings'\)\)\$\('landSettings'\)\.onclick=openNativePlayer;/,
  'Settings rail button must reuse openNativePlayer()'
);

/* The CSS must key the four-pane layout on the same height-based landscape breakpoint as before
   (v60's fix for the width-based media query never matching in landscape), and must actually
   reveal the rail/strip that are hidden by default. */
assert.match(
  html,
  /@media \(orientation:landscape\) and \(max-height:600px\)\{[\s\S]*?\.landRail\{display:flex\}[\s\S]*?\.landNowPlaying\{grid-column:2;grid-row:3;display:flex\}[\s\S]*?\}/,
  'the landscape breakpoint must switch the rail and now-playing strip to visible'
);
assert.match(
  html,
  /\.side\{position:static;transform:none;width:auto;z-index:auto;background:transparent;padding:0;box-shadow:none;grid-template-rows:minmax\(0,1fr\)\}/,
  'in landscape, .side (categories) must become a normal static grid column instead of the off-canvas drawer'
);
assert.match(
  html,
  /\.side \.tabs\{display:none\}/,
  'the drawer\'s own Live\\/Movies\\/Series tab row must be hidden in landscape now that the rail provides the same navigation'
);
