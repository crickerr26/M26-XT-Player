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

const context = {
  typeOf: x => x._type,
};

vm.createContext(context);
for (const name of [
  'function isTranscodedRoute',
  'function keepLiveTranscodedLast',
]) {
  assert.ok(html.includes(name), `${name} should be implemented`);
  vm.runInContext(extractFunction(name), context);
}

const routes = [
  { kind: 'hls', label: 'Live Transcoded', url: 'https://app.example/transcoder/hls?url=http%3A%2F%2Fpanel%2Flive%2F1.ts' },
  { kind: 'mpegts', label: 'Direct TS', url: 'http://panel/live/1.ts' },
  { kind: 'hls', label: 'Proxy HLS', url: 'https://app.example/proxy?url=http%3A%2F%2Fpanel%2Flive%2F1.m3u8' },
  { kind: 'hls', label: 'Panel Transcoded', url: 'https://app.example/transcoder/hls?url=http%3A%2F%2Fpanel%2Flive%2F1.ts' },
];

const ordered = context.keepLiveTranscodedLast({ _type: 'live' }, routes);

assert.deepEqual(
  Array.from(ordered.map(r => r.label)),
  ['Direct TS', 'Proxy HLS', 'Live Transcoded', 'Panel Transcoded'],
  'Live TV should try direct/proxy routes before remembered or expanded transcoded routes'
);

assert.strictEqual(
  context.keepLiveTranscodedLast({ _type: 'vod' }, routes),
  routes,
  'Movie/series route order should not be rewritten by the live-only guard'
);
