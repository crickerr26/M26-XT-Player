import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /const existing=await dlGet\(key\);[\s\S]*?if\(existing&&existing\.partial\)\{[\s\S]*?prog\.received=existing\.received\|\|0[\s\S]*?segIndex=existing\.numSegments\|\|0[\s\S]*?headers:\{Range:'bytes='\+prog\.received\+'\-'\}/,
  'Offline save should resume a partial download from the bytes already stored on the device'
);

assert.match(
  html,
  /await dlPutSegment\(key,segIndex,new Blob\(chunks\)\);[\s\S]*?await dlPut\(\{key,name:nameOf\(x\),ext,mime,size:prog\.received,numSegments:segIndex,poster:logoOf\(x\)\|\|'',type:typeOf\(x\),addedAt:[^,]+,watched:false,partial:true,received:prog\.received,sourceUrl:url\}\)/,
  'Each flushed segment should update a partial metadata record so an iPhone page suspension can resume later'
);

assert.match(
  html,
  /if\(ctl\.signal\.aborted\)\{[\s\S]*?if\(segIndex>0\)await dlDeleteSegments\(key\)[\s\S]*?toast\('Download canceled'\)[\s\S]*?return[\s\S]*?\}[\s\S]*?if\(prog\.received>0&&segIndex>0\)\{[\s\S]*?partial:true[\s\S]*?toast\('Download interrupted — tap Save Offline again to resume'\)/,
  'A non-cancel interruption should keep partial segments instead of deleting the iPhone download progress'
);

assert.match(
  html,
  /await dlPut\(\{key,name:nameOf\(x\),ext,mime,size:prog\.received,numSegments:segIndex,poster:logoOf\(x\)\|\|'',type:typeOf\(x\),addedAt:Date\.now\(\),watched:false,partial:false\}\)/,
  'A completed resumed download should replace the partial marker with a normal playable record'
);

assert.match(
  html,
  /const finished=saved\.filter\(r=>!r\.partial\);[\s\S]*?S\.dlKeys=new Set\(finished\.map\(r=>r\.key\)\)/,
  'Partial records should not make catalog rows behave like playable offline downloads'
);

assert.match(
  html,
  /if\(rec\.partial\)continue;[\s\S]*?if\(rec\.seekable\|\|rec\.seekableUnsupported\)continue;/,
  'Interrupted downloads should not be sent to finished-file seek preprocessing'
);

assert.match(
  html,
  /if\(rec\.partial\)\{resumeDownloadByKey\(key\);return\}[\s\S]*?async function resumeDownloadByKey\(key\)/,
  'Tapping an interrupted download should resume it instead of trying to play a partial file'
);
