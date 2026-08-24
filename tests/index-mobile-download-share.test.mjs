import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /async function shareVideoFile\(url,fname\)/,
  'Mobile downloads should have a native share/save-file path'
);

assert.match(
  html,
  /navigator\.canShare\(\{files:\[file\]\}\)/,
  'The mobile path must check whether the browser can share a video file'
);

assert.match(
  html,
  /await navigator\.share\(\{files:\[file\],title:[^}]+text:/,
  'The mobile path must open the native share sheet with the video file'
);

assert.match(
  html,
  /function downloadViaAnchor\(url,fname\)[\s\S]*?a\.download=fname/,
  'The old browser download must remain as fallback'
);

assert.match(
  html,
  /async function downloadCurrent\(\)[\s\S]*?if\(mobile\(\)&&await shareVideoFile\(url,fname\)\)return/,
  'On mobile, the download button should try native file sharing before anchor download'
);
