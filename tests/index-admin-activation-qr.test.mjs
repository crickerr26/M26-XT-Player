import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

assert.doesNotMatch(
  html,
  /<div class="idBlock hidden" id="actMacBlock">/,
  'The admin registration QR block must be visible on the login card'
);

assert.match(
  html,
  /<div[^>]+id="actQrBox"[^>]*class="[^"]*\bshareQr\b/,
  'The login card must include the seller-scannable activation QR container'
);

assert.match(
  html,
  /function adminActivationLink\(code,_macIgnored\)[\s\S]*?admin\.html\?code=/,
  'The activation QR must target admin.html so it opens on local/static hosting'
);

assert.match(
  html,
  /const DEFAULT_LICENSE_HOME='https:\/\/media26\.gz-inzi84\.workers\.dev'/,
  'Activation should have one browser-reachable canonical license home'
);

assert.match(
  html,
  /function licenseBase\(\)[\s\S]*?return DEFAULT_LICENSE_HOME\+'\/transcoder'/,
  'The app must call the canonical license home directly instead of a secondary Worker forwarding hop'
);

assert.match(
  html,
  /function adminActivationLink\(code,_macIgnored\)[\s\S]*?return DEFAULT_LICENSE_HOME\+'\/admin\.html\?code='\+encodeURIComponent\(code\);[\s\S]*?}/,
  'The activation QR must open the canonical admin page with only the activation code'
);

assert.match(
  admin,
  /var DEFAULT_LICENSE_HOME='https:\/\/media26\.gz-inzi84\.workers\.dev'/,
  'Admin activation should default to the canonical license home'
);

assert.match(
  admin,
  /var DEFAULT_BASE = \([\s\S]*?DEFAULT_LICENSE_HOME \+ '\/transcoder'[\s\S]*?media26-transcoder\.onrender\.com/,
  'Admin activation API calls should default to the canonical license home'
);

assert.ok(
  admin.includes('/\\.workers\\.dev$/i.test(_old.hostname)') && admin.includes('_old.origin!==DEFAULT_LICENSE_HOME'),
  'Admin should migrate stale secondary workers.dev activation bases to the canonical home'
);

assert.match(
  admin,
  /var mac='';/,
  'Admin activation must ignore old mac= query parameters'
);

assert.match(
  admin,
  /<input id="a_user"[\s\S]*?<input id="a_pass"/,
  'Admin activation must let the seller enter the IPTV username and password'
);

assert.match(
  admin,
  /<select id="a_days">[\s\S]*?<option value="30" selected>1 month<\/option>[\s\S]*?<option value="360">12 months<\/option>/,
  'Admin activation must let the seller choose the IPTV playlist subscription period'
);
