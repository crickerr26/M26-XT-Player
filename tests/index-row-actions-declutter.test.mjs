import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.05 (owner report, with a screenshot: the Movies row's icon cluster — Play/VLC/Download/star —
   overlapping the title text on a narrow phone). Two changes:
   1. rowPlayerButtons() no longer draws the row's own blue "Play here" button. Tapping the row
      itself already plays the title in the built-in player (see the plain `.card` branch of the
      grid's click handler), so the button was a second, crowded way to do that — removing it
      matches epPlayerButtons() below, which never drew one for episode rows either.
   2. listCardHtml() draws the star BEFORE rowPlayerButtons()'s output, so it leads the row instead
      of trailing after VLC/Download. */
assert.doesNotMatch(
  html,
  /function rowPlayerButtons\(key,type\)\{[\s\S]*?playerBtn\('basic'/,
  'rowPlayerButtons() must not draw the row\'s own Play button — tapping the row already plays it'
);

assert.match(
  html,
  /return guideBtn\+rowExternals\(\)\.map\(m=>playerBtn\(m,'data-play="'\+m\+'" data-key="'\+key\+'"'\)\)\.join\(''\)\+saveBtn;/,
  'rowPlayerButtons() must lead with the Guide button (live only), then external players, then Save'
);

assert.match(
  html,
  /<div class="rowActions"><button class="star" type="button" aria-label="Favorite" data-fav="\$\{esc\(keyOf\(x\)\)\}">\$\{S\.favs\.has\(keyOf\(x\)\)\?'★':'☆'\}<\/button>\$\{rowPlayerButtons\(esc\(keyOf\(x\)\),typeOf\(x\)\)\}<\/div>/,
  'The star must render before rowPlayerButtons() output so it leads the row\'s action cluster'
);

assert.match(
  html,
  /@media\(max-width:760px\)\{[\s\S]*?\.qp\{height:27px;min-width:30px;padding:0 6px;font-size:9px\}\.qpico\{width:15px;height:15px\}\s*\n\s*\.rowActions \.star\{width:24px;height:24px;font-size:13px\}/,
  'Mobile row-action icons (VLC/Download/star) must be shrunk so two buttons plus the star fit next to a long title'
);
