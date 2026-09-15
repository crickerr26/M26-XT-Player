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

/* v25.09 (owner request: a settings panel in the Subtitles/Captions menu to control caption
   position left/centre/right, font size, font colour and background transparency). Built as
   preset rows in the same shape every other player-menu setting already uses (Colour Mode,
   Equalizer), persisted the same way applyColour()/savedColour() persists colour mode. */

let store = {};
const context = {
  store: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
};
vm.createContext(context);
const constLine = html.match(/const SUB_STYLE_KEY=.*?;\s*\nconst SUB_STYLE_DEFAULTS=.*?;/);
assert.ok(constLine, 'SUB_STYLE_KEY/SUB_STYLE_DEFAULTS constants should exist');
vm.runInContext(constLine[0], context);
vm.runInContext(extractFunction('function savedSubStyle'), context);

/* JSON round-trip: an object built inside the vm context is a different realm's Object, and
   assert.deepEqual (deepStrictEqual under node:assert/strict) checks prototype identity too, so
   comparing it directly against a plain literal here would fail even with identical contents. */
assert.deepEqual(
  JSON.parse(JSON.stringify(context.savedSubStyle())),
  { pos: 'center', size: 'medium', color: 'white', bg: 'medium' },
  'savedSubStyle() must default to center/medium/white/medium when nothing is stored yet'
);

store['media26-sub-style-v1'] = JSON.stringify({ pos: 'left', size: 'xlarge' });
assert.deepEqual(
  JSON.parse(JSON.stringify(context.savedSubStyle())),
  { pos: 'left', size: 'xlarge', color: 'white', bg: 'medium' },
  'savedSubStyle() must merge a partial saved record over the defaults, not replace them wholesale'
);

/* Position has no CSS answer (::cue cannot reposition the cue box in any browser) — it must be
   set on each cue's own align/position properties instead of being folded into the ::cue rule
   applySubtitleStyle() writes for size/colour/background. */
assert.match(
  html,
  /function applySubtitleStyle\(\)\{[\s\S]{0,600}video::cue\{font-size:'\+pct\+'%;color:'\+color\+';background-color:'\+bg\+';\}[\s\S]{0,100}applySubtitlePositions\(\);/,
  'applySubtitleStyle() must write font-size/color/background-color via a ::cue rule and then apply position separately'
);

assert.match(
  html,
  /function applySubtitlePositions\(\)\{[\s\S]*?if\('align'in c\)c\.align=cfg\.align;if\('position'in c\)c\.position=cfg\.position;/,
  "applySubtitlePositions() must set each cue's own align/position, since CSS cannot reposition the cue box"
);

assert.match(
  html,
  /function wireSubtitleStyleTracking\(\)\{[\s\S]*?v\._subStyleWired=true;[\s\S]*?addEventListener\('cuechange',applySubtitlePositions\)[\s\S]*?addtrack'[\s\S]*?applySubtitlePositions\(\);/,
  'wireSubtitleStyleTracking() must re-apply the position setting on cuechange/addtrack so newly-arriving cues (live captions, or a track that attaches after playback starts) get styled too'
);

/* The menu now nests two levels deep for the first time (Subtitles -> Style -> Position/Size/
   Colour/Background) — pmRender's back button must go to the immediate parent panel, not always
   jump to the menu root, or the four new leaf panels would be unreachable-feeling dead ends. */
assert.match(
  html,
  /function pmRender\(rows,title,onBack\)\{[\s\S]{0,300}h\.querySelector\('button'\)\.onclick=onBack\|\|pmRoot;/,
  'pmRender() must accept an optional onBack target defaulting to pmRoot, so nested panels can return to their actual parent'
);

for (const [fn, parent] of [
  ['pmSubStyle', 'pmSubs'],
  ['pmSubPosition', 'pmSubStyle'],
  ['pmSubSize', 'pmSubStyle'],
  ['pmSubColor', 'pmSubStyle'],
  ['pmSubBg', 'pmSubStyle'],
]) {
  assert.match(
    html,
    new RegExp(`function ${fn}\\([^)]*\\)\\{[\\s\\S]*?pmRender\\([\\s\\S]*?,${parent}\\);`),
    `${fn}() must pass ${parent} as its back target`
  );
}

assert.match(
  html,
  /rows\.push\(\{label:'Style',chev:true,onClick:pmSubStyle\}\);pmRender\(rows,'Subtitles'\);/,
  'The Subtitles menu must offer a Style row leading into the new subtitle style panel'
);

assert.match(
  html,
  /applyColour\(savedColour\(\)\);updateVolPct\(\);\s*\napplySubtitleStyle\(\);wireSubtitleStyleTracking\(\);/,
  'Subtitle styling must be applied and wired up on startup, the same way colour mode already is'
);
