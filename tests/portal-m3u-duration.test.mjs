import assert from 'node:assert/strict';
import '../portal.js';

const portal = globalThis.Media26Portal;

const parsed = portal.parseM3U(`#EXTM3U
#EXTINF:7200 tvg-name="Two Hour Movie" group-title="Tamil Movies",Two Hour Movie
http://media.example/movie/user/pass/99.mkv
`);

assert.equal(parsed.vod.length, 1);
assert.equal(parsed.vod[0].duration_secs, 7200, 'Movie runtime from EXTINF should be kept for the player timeline');
