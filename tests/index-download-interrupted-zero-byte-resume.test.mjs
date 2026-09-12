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

let stored = null;
const toasts = [];
const context = {
  AbortController,
  Blob,
  URL,
  clearTimeout,
  setTimeout,
  S: { dlProgress: {}, viewingDownloads: false },
  SAME_ORIGIN_PROXY: '',
  PROXY: 'https://proxy.example/?u=',
  window: {},
  navigator: { storage: { persist: async () => true } },
  yezProbeOriginal: () => {},
  $: id => (id === 'video' ? { currentSrc: '', readyState: 0 } : null),
  typeOf: x => x._type || 'vod',
  keyOf: x => `${x._type || 'vod'}:${x.stream_id || x.id}`,
  nameOf: x => x.name || 'Movie',
  logoOf: () => '',
  externalStreamUrl: x => x.direct_source,
  streamRelayUrl: () => '',
  mimeForFile: () => 'video/x-matroska',
  dlGet: async () => null,
  dlPut: async rec => { stored = rec; },
  dlPutSegment: async () => {},
  dlDelete: async () => {},
  dlDeleteSegments: async () => {},
  updateDownloadsBadge: async () => {},
  renderDownloadsSheet: () => {},
  renderGrid: () => {},
  tryMakeSeekable: async () => 'ok',
  mkvLike: () => false,
  fetchDlWithTimeout: async () => { throw new Error('stalled - no response within 20s'); },
  toast: msg => { toasts.push(msg); },
};

vm.createContext(context);
vm.runInContext(extractFunction('async function startDownload'), context);

await context.startDownload({
  _type: 'vod',
  stream_id: '123',
  name: 'Interrupted Movie',
  container_extension: 'mkv',
  direct_source: 'https://media.example/movie.mkv',
});

assert.equal(stored?.partial, true, 'A network interruption before first bytes should still create a resumable partial row');
assert.equal(stored?.received, 0);
assert.equal(stored?.numSegments, 0);
assert.equal(stored?.sourceUrl, 'https://proxy.example/?u=' + encodeURIComponent('https://media.example/movie.mkv'));
assert.ok(toasts.some(msg => /resume/i.test(msg)), 'The interruption toast should tell the user to resume from Downloads');
