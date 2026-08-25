import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const fallbackStart = html.indexOf('async function xtreamApiLoginFallback()');
const lazyStart = html.indexOf('async function xtreamApiLoadType(type)');
assert.notEqual(fallbackStart, -1, 'xtreamApiLoginFallback should exist');
assert.ok(lazyStart > fallbackStart, 'xtreamApiLoadType should be defined after the login fallback');
const fallbackBody = html.slice(fallbackStart, lazyStart);

assert.match(
  fallbackBody,
  /get_live_categories[\s\S]*get_live_streams/,
  'API-only login should fetch live categories and streams immediately'
);

assert.doesNotMatch(
  fallbackBody,
  /get_vod_streams|get_series/,
  'API-only login must not wait for movies or series before entering the app'
);

assert.match(
  html,
  /async function xtreamApiLoadType\(type\)[\s\S]*?get_vod_streams[\s\S]*?get_series/,
  'Movies and series should have a lazy Xtream API loader after live login'
);

assert.match(
  html,
  /serverInfo:S\.xtreamApiServerInfo/,
  'Lazy movies and series should use the same server_info stream host as live channels'
);

assert.match(
  html,
  /if\(S\.xtreamApiOnly&&type!=='live'\)await xtreamApiLoadType\(type\)/,
  'The normal tab loader should call the lazy API loader for API-only Xtream playlists'
);
