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

const context = {};
vm.createContext(context);
vm.runInContext(extractFunction('function normalizeStylizedDigits'), context);

/* v25.08 (owner-supplied live diagnostic: a channel named "CRIC || SKY SPORTS CRIC ⁴ᵏ" never
   triggered 4K handling — its mpegts route burned a guaranteed 7.3s "startup timeout" instead of
   leading with native HLS, which is what nativeFirst exists for). Providers stylize "4K"/"HD"
   with Unicode superscript digits/letters rather than plain ASCII, and a plain /\b4k\b/i test
   never matches those code points. */
assert.equal(
  context.normalizeStylizedDigits('CRIC || SKY SPORTS CRIC ⁴ᵏ'),
  'CRIC || SKY SPORTS CRIC 4k',
  'normalizeStylizedDigits() must turn superscript "⁴ᵏ" into plain "4k"'
);

assert.match(
  context.normalizeStylizedDigits('Some Channel ᴴᴰ'),
  /HD/,
  'normalizeStylizedDigits() must turn superscript "ᴴᴰ" into plain "HD"'
);

assert.match(
  html,
  /const is4k=\/\\b\(4k\|uhd\)\\b\/i\.test\(normalizeStylizedDigits\(nameOf\(x\)\)\);/,
  'plan()\'s is4k (drives nativeFirst, which puts native/HLS ahead of the mpegts route that cannot work on some devices) must normalize stylized digits before testing'
);

assert.match(
  html,
  /function looks4k\(x\)\{try\{return \/\(\^\|\[\^a-z0-9\]\)\(4k\|uhd\|2160p\?\)\(\[\^a-z0-9\]\|\$\)\/i\.test\(normalizeStylizedDigits\(nameOf\(x\)\)\)\}catch\(e\)\{return false\}\}/,
  'looks4k() (the shared 4K badge/detection helper) must also normalize stylized digits before testing'
);
