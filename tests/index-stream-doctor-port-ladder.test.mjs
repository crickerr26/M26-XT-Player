import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /function doctorVerdict\(p,viaFallback\)\{\s*if\(p\.ok\)return viaFallback[\s\S]*?The line answers on the default port\./,
  'The Stream Doctor verdict must be able to say the default-port twin is what actually answered'
);

assert.match(
  html,
  /if\(!viaRelay\.ok&&\/\^\(401\|403\|511\)\$\/\.test\(String\(viaRelay\.status\|\|''\)\)\)\{[\s\S]*?YezPlayer\.ladder[\s\S]*?altRelay=await doctorProbe\(proxyUrl\(alt\)\|\|alt\)/,
  'Stream Doctor must retry the panel default-port twin (the same host ladder yezRoutes()/externalStreamUrl() use) before concluding a gate-worthy status means the line is dead'
);

assert.match(
  html,
  /lines\.push\('3\. '\+\(altRelay&&altRelay\.ok\?doctorVerdict\(altRelay,true\):doctorVerdict\(viaRelay\)\)\)/,
  'The final verdict must prefer a working default-port fallback over a refused published-port address'
);
