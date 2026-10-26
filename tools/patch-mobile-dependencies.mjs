/** Narrow, hash-guarded API bridge for uni-app's Node-only QR decoder. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
try {
  require.resolve('jimp');
} catch (error) {
  if (process.argv.includes('--if-installed') && error.code === 'MODULE_NOT_FOUND') {
    console.log('Mobile dependency adapter skipped: mobile workspace is not installed.');
    process.exit(0);
  }
  throw error;
}
const coreRoot = dirname(require.resolve('@jimp/core/package.json'));
const core = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8'));
const jimp = require('jimp/package.json');
const fromCore = createRequire(join(coreRoot, 'package.json'));
const detectorPath = fromCore.resolve('file-type');
const detector = JSON.parse(await readFile(join(dirname(detectorPath), 'package.json'), 'utf8'));
if (core.version !== '0.22.12' || jimp.version !== '0.22.12' || detector.version !== '21.3.2') {
  throw new Error('Jimp/file-type versions changed. Review the API adapter before patching.');
}

const patches = [
  {
    file: 'dist/utils/image-bitmap.js',
    before: '05b60c76db68f742e451f0a92389d706fdf9d23573732463dcc9a7d5bcb4eb54',
    after: '081fa9dbd9d1ff81231909d40858f48b416c18a22b3d2cbeb44e80a7beef72ae',
    replace: [[
      'var _fileType = _interopRequireDefault(require("file-type"));',
      'var _fileType = { default: { fromBuffer: (...args) => import("file-type").then(module => module.fileTypeFromBuffer(...args)) } };'
    ]]
  },
  {
    file: 'es/utils/image-bitmap.js',
    before: '7ae55bbff030c5246a271a5cc925951cac00fc918a478a0932c04d3b8e11f904',
    after: '6e6f48b2f0c0eeb4f1ef21708ab7a01eb6a0fa26b5871269922f50e65cb76de0',
    replace: [
      ['import FileType from "file-type";', 'import { fileTypeFromBuffer as detectFileTypeFromBuffer } from "file-type";'],
      ['await FileType.fromBuffer(buffer)', 'await detectFileTypeFromBuffer(buffer)']
    ]
  }
];
const hash = value => createHash('sha256').update(value).digest('hex');
for (const patch of patches) {
  const path = join(coreRoot, patch.file);
  let source = await readFile(path, 'utf8');
  const current = hash(source);
  if (current === patch.after) continue;
  if (current !== patch.before) throw new Error(`Unexpected Jimp source: ${patch.file}`);
  for (const [before, after] of patch.replace) {
    if (source.split(before).length !== 2) throw new Error(`Jimp adapter target changed: ${patch.file}`);
    source = source.replace(before, after);
  }
  if (hash(source) !== patch.after) throw new Error(`Jimp adapter hash mismatch: ${patch.file}`);
  await writeFile(path, source, 'utf8');
}
console.log('Verified Jimp 0.22.12 adapter for patched file-type 21.3.2.');
