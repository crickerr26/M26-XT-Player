import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const bannerText = 'Testing mode - feature coming soon';

const homeStart = html.indexOf('<button class="home-card hc-downloads"');
assert.notEqual(homeStart, -1, 'Downloads home tile should exist');
const homeEnd = html.indexOf('</button>', homeStart);
assert.notEqual(homeEnd, -1, 'Downloads home tile should close');
const homeDownloadsMarkup = html.slice(homeStart, homeEnd);
assert.match(
  homeDownloadsMarkup,
  new RegExp(bannerText),
  'Downloads home tile should show the testing-mode banner'
);

function extractFunction(name) {
  const start = html.indexOf(name);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const grid = { innerHTML: '' };
const sectionSub = { textContent: '' };
const context = {
  S: { viewingDownloads: true, dlProgress: {} },
  dlAll: async () => [{ key: 'vod:saved', name: 'Saved Movie', addedAt: 1, partial: false }],
  dlRowHtml: rec => `<div class="card dlRow" data-dlkey="${rec.key}">${rec.name}</div>`,
  $: id => (id === 'grid' ? grid : id === 'sectionSub' ? sectionSub : null),
};

vm.createContext(context);
vm.runInContext(`
let _gridChunkToken = 0;
let _gridSig = '';
${extractFunction('async function renderDownloadsSheet')}
globalThis.__renderDownloadsSheet = renderDownloadsSheet;
`, context);

await context.__renderDownloadsSheet();

assert.match(grid.innerHTML, /downloadsNotice/, 'Downloads page should render a small banner');
assert.match(grid.innerHTML, new RegExp(bannerText), 'Downloads page should show the testing-mode banner');
assert.ok(
  grid.innerHTML.indexOf(bannerText) < grid.innerHTML.indexOf('Saved Movie'),
  'Downloads page banner should sit above downloaded videos'
);
