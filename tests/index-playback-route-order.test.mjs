import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /if\(type==='live'&&x\.direct_source\)[\s\S]*?if\(magRelay\)[\s\S]*?addTrans\('Live Browser',raw,false,'browser'\)[\s\S]*?addTrans\('Live',raw\)[\s\S]*?return p;/,
  'MAG/Stalker live channels must try the plain Railway stream relay before transcoded HLS'
);

assert.doesNotMatch(
  html,
  /Desktop VOD[\s\S]*?if\(transcoderBase\(\)\)addTrans\('Preview',rawFirst,true\)/,
  'Desktop VOD must not put generated transcoded HLS ahead of direct/relay movie playback'
);

assert.match(
  html,
  /Desktop VOD[\s\S]*?const W=u=>blocked\(u\)\?proxyUrl\(u\):u;[\s\S]*?if\(direct\)\{[\s\S]*?add\(direct\.includes\('\.m3u8'\)\?'hls':'native','Direct',W\(direct\)\)[\s\S]*?if\(browserSafeExt\(preferred\)\)addTrans\('Preview',rawFirst\);/,
  'Desktop browser-safe movies must lead with byte-range direct/proxy routes and keep transcoding as fallback'
);

assert.match(
  html,
  /if\(S\.hls\)\{S\.hls\.stopLoad\(\);S\.hls\.startLoad\(pos>0\?pos:-1\)\}/,
  'VOD HLS reconnect must resume loading at the current movie position instead of restarting at zero'
);
