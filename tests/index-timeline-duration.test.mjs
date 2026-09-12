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

function extractSeekIife() {
  const marker = 'Seek/progress bar for VOD & Series';
  const markerAt = html.indexOf(marker);
  assert.notEqual(markerAt, -1, 'Seek bar block should exist');
  const start = html.indexOf('(function(){', markerAt);
  assert.notEqual(start, -1, 'Seek bar IIFE should exist');
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        const end = html.indexOf(')();', i);
        assert.notEqual(end, -1, 'Seek bar IIFE should close');
        return html.slice(start, end + 4);
      }
    }
  }
  throw new Error('Could not extract seek bar IIFE');
}

function el(extra = {}) {
  return {
    style: {},
    textContent: '',
    listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    ...extra,
  };
}

const elements = {
  video: el({
    currentTime: 600,
    duration: 1800,
    seekable: { length: 0 },
    buffered: { length: 0 },
  }),
  seekTrack: el(),
  seekFill: el(),
  seekHandle: el(),
  curTime: el(),
  durTime: el(),
};

const context = {
  S: { current: { _type: 'vod', duration: '02:00:00' } },
  typeOf: x => x._type,
  $: id => elements[id],
};

vm.createContext(context);
for (const name of [
  'function parseDurationSeconds',
  'function durationSecondsOf',
  'function effectiveVideoDuration',
  'function formatMediaTime',
]) {
  if (html.includes(name)) vm.runInContext(extractFunction(name), context);
}
vm.runInContext(extractSeekIife(), context);

elements.video.listeners.timeupdate();

assert.equal(elements.curTime.textContent, '10:00');
assert.equal(elements.durTime.textContent, '2:00:00', 'Timeline should show the full declared movie runtime, not the partial parsed duration');
