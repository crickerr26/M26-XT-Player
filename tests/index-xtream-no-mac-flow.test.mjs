import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /if\(_portalKind==='xtream'&&\(!user\|\|!pass\)\)\{/,
  'Xtream login must require username and password without consulting the device MAC'
);

assert.doesNotMatch(
  html,
  /function openXtreamSheet\(\)[\s\S]*?showDeviceId\(false\)[\s\S]*?\$\('xtreamSheet'\)\.classList\.add\('show'\);/,
  'Opening the normal portal sheet must not show the MAC row for Xtream login'
);

assert.match(
  html,
  /function signInMsg\(text,kind,opts\)[\s\S]*?if\(opts&&opts\.deviceId\)showDeviceId\(true\);/,
  'Sign-in messages should reveal the MAC row only for explicit legacy MAG/MAC prompts'
);

assert.doesNotMatch(
  html,
  /vodExternalLine\(\)[\s\S]*?mode=ext/,
  'Automatic VOD/Series taps must not skip the inbuilt player because of a remembered VLC fallback'
);
