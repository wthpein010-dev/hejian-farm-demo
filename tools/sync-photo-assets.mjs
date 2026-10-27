import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source=new URL('../prototype/assets/photos/',import.meta.url);
const destination=new URL('../apps/mobile/src/static/photos/',import.meta.url);
const required=['farm-estate','livestock','pig-pov','shop-banner','feed','fertilizer','tools','seed','sign','frame','bundle','gift'];
const check=process.argv.includes('--check');
const manifest=JSON.parse(await readFile(new URL('manifest.json',source),'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!check)await mkdir(destination,{recursive:true});
let total=0;
for(const key of required){
 const item=manifest.assets.find(item=>item.key===key);
 if(!item||item.file!==key+'.webp')throw Error('Missing canonical photo: '+key);
 const from=new URL(item.file,source),to=new URL(item.file,destination),bytes=await readFile(from);
 if(digest(bytes)!==item.sha256)throw Error('Canonical photo digest mismatch: '+key);
 if(check){if(digest(await readFile(to))!==item.sha256)throw Error('Mobile photo drift: '+key);}else await copyFile(from,to);
 total+=bytes.length;
}
console.log(`${check?'Verified':'Synced'} ${required.length} mobile photos (${total} bytes) from canonical prototype/assets/photos.`);
