/** Executable checks for dependency boundaries that plain npm audit cannot prove. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const version = name => require(`${name}/package.json`).version;
assert.equal(version('vite'), '6.4.5', 'Revalidate the explicit Vite peer exception before upgrading.');
assert.equal(version('esbuild'), '0.25.12');
assert.equal(version('@babel/core'), '7.29.7');
assert.equal(version('vue'), '3.4.21', 'Keep the Vue version used by uni-app 503 compilers.');
assert.equal(version('@vue/compiler-dom'), '3.4.21');
assert.equal(version('@vue/compiler-sfc'), '3.4.21');
assert.equal(version('@vue/server-renderer'), '3.5.42');
assert.equal(version('vue-i18n'), '9.14.5');
for (const name of ['@dcloudio/uni-app', '@dcloudio/uni-app-plus', '@dcloudio/uni-components', '@dcloudio/uni-h5', '@dcloudio/uni-mp-weixin', '@dcloudio/uni-mp-toutiao', '@dcloudio/uni-cli-shared', '@dcloudio/vite-plugin-uni']) {
  assert.equal(version(name), '3.0.0-5030320261023001');
}

// This is the exact read(Buffer).bitmap API used by uni-mp-weixin's QR automator.
const Jimp = require('jimp');
const source = new Jimp(2, 2, 0x336699ff);
for (const mime of [Jimp.MIME_PNG, Jimp.MIME_JPEG]) {
  const bytes = await source.getBufferAsync(mime);
  const decoded = await Jimp.read(bytes);
  assert.equal(decoded.bitmap.width, 2);
  assert.equal(decoded.bitmap.height, 2);
  assert.equal(decoded.bitmap.data.length, 16);
  if (mime === Jimp.MIME_PNG) assert.equal(decoded.getPixelColor(0, 0), 0x336699ff);
}
await assert.rejects(Jimp.read(Buffer.from('not an image')));

// No SSR target is supported by the Vite config. Still verify the isolated,
// patched renderer can safely consume a Vue 3.4 VNode without upgrading compilers.
const { createSSRApp, h } = require('vue');
const { renderToString, ssrRenderAttrs } = require('@vue/server-renderer');
const rendered = await renderToString(createSSRApp({ render: () => h('div', { title: '<safe>' }, '田园 & 日常') }));
assert.match(rendered, /title="&lt;safe&gt;"/);
assert.match(rendered, /田园 &amp; 日常/);
const warn = console.warn;
const error = console.error;
try {
  // The renderer intentionally warns when rejecting this malicious name.
  console.warn = () => {};
  console.error = () => {};
  assert.equal(ssrRenderAttrs({ 'data-bad\ronmouseover': 'alert(1)' }), '');
} finally {
  console.warn = warn;
  console.error = error;
}
console.log('Dependency boundaries passed: uni/Vue pins, patched i18n, PNG/JPEG decoding and renderer escaping.');
