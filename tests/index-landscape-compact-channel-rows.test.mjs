import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* v25.12 (owner report, with a screenshot: the channel rows in the landscape layout's 220px-wide
   list column were still full desktop size — 52px logos, 14px bold titles, 20px number badges —
   so only 2-3 rows fit at once. Shrunk further than even the mobile-portrait breakpoint, since
   this column is narrower than a phone's full width. */

function landscapeBlock() {
  const start = html.indexOf('@media (orientation:landscape) and (max-height:600px){');
  assert.notEqual(start, -1, 'the landscape media query must exist');
  let depth = 0, i = start;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const block = landscapeBlock();

for (const rule of [
  '.card{min-height:38px;border-radius:9px;grid-template-columns:28px 1fr auto;gap:6px;padding:4px 6px}',
  '.poster{width:28px;height:28px;border-radius:7px;font-size:9px}',
  '.chNum{min-width:14px;height:14px;padding:0 3px;font-size:8px;border-radius:4px}',
  '.ctitle{font-size:10.5px;line-height:1.15;-webkit-line-clamp:1}',
  '.cmeta{font-size:8.5px;margin-top:1px}',
  '.qp{height:22px;min-width:24px;padding:0 4px;font-size:8px}',
  '.qpico{width:12px;height:12px}',
  '.rowActions .star{width:20px;height:20px;font-size:11px}',
]) {
  assert.ok(block.includes(rule), `landscape block must shrink channel rows via: ${rule}`);
}
