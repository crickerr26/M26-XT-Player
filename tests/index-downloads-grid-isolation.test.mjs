import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
globalThis.__setGridState = token => { _gridChunkToken = token; _gridSig = 'live|list|live:old'; };
globalThis.__appendIfToken = token => {
  if (token === _gridChunkToken) $('grid').innerHTML += '<div class="card liveLeak">Leaked live row</div>';
};
`, context);

context.__setGridState(41);
await context.__renderDownloadsSheet();
context.__appendIfToken(41);

assert.match(grid.innerHTML, /class="card dlRow"/, 'Downloads should render saved offline rows');
assert.doesNotMatch(
  grid.innerHTML,
  /liveLeak/,
  'Downloads should cancel stale catalog chunking so live/movie rows cannot append underneath'
);
assert.equal(sectionSub.textContent, '1 saved offline');
