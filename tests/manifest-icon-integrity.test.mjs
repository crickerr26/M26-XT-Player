import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* v25.02 (owner report: an Android customer tapped "Install" and no icon ever appeared on his home
   screen): manifest.json declared image_482ee8.png as a 512x512 icon for both 'any' and 'maskable'
   purpose, but the actual file is 528x502 — not 512x512, and not even square. Android's home-screen
   install (WebAPK) fetches and validates each manifest icon before it will mint a real launcher
   icon; a source that lies about its own dimensions (and isn't square, which every mask shape a
   launcher can apply assumes) is exactly the kind of manifest defect that lets that mint fail
   silently — Chrome reports "Installed" instantly, but nothing lands on the launcher.
   This test decodes the PNG IHDR chunk directly (no image library — matching this repo's
   node:assert-only test style) so a future icon swap can never drift from the manifest's own
   claims about it again. */

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));

function pngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', filePath + ' must be a real PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.json must declare at least one icon');

for (const icon of manifest.icons) {
  const filePath = path.join(path.dirname(new URL('manifest.json', root).pathname), icon.src);
  assert.ok(fs.existsSync(filePath), 'manifest.json icon "' + icon.src + '" must exist on disk');
  const { width, height } = pngDimensions(filePath);
  const [declaredW, declaredH] = String(icon.sizes).split('x').map(Number);
  assert.equal(width, declaredW, icon.src + ' is ' + width + 'px wide but manifest.json declares ' + declaredW + ' — Android validates this before minting a home-screen icon');
  assert.equal(height, declaredH, icon.src + ' is ' + height + 'px tall but manifest.json declares ' + declaredH + ' — Android validates this before minting a home-screen icon');
  assert.equal(width, height, icon.src + ' must be square (' + width + 'x' + height + ') — a non-square icon breaks the adaptive-icon mask every Android launcher applies');
}

assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'manifest.json must declare a maskable icon for Android adaptive-icon shaping');
assert.ok(manifest.icons.some(i => i.purpose !== 'maskable' && Number(String(i.sizes).split('x')[0]) >= 512), 'manifest.json must declare a non-maskable icon at 512x512 or larger');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /<link rel="apple-touch-icon" href="apple-touch-icon\.png">/,
  'apple-touch-icon must point at the square, flattened icon render, not the raw non-square logo asset'
);
assert.match(
  html,
  /<link rel="icon" type="image\/png" sizes="192x192" href="icon-192\.png">/,
  'the favicon link must point at a real 192x192 file, not a mis-declared logo asset'
);
assert.match(
  html,
  /<img src="icon-192\.png" alt="Media26 icon">/,
  'the in-app "Save to home screen" prompt must reference an icon file that actually exists'
);

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const buildCmd = pkg.scripts && pkg.scripts['app:build'];
assert.ok(buildCmd, 'package.json must define an app:build script');
for (const f of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
  assert.ok(buildCmd.includes(f), 'app:build must copy ' + f + ' into dist/ so the Capacitor/native build ships the same fixed icons as the web app');
}
