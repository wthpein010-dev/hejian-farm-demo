/// <reference types="node" />
import { createRequire } from 'node:module';
import { defineConfig, normalizePath, type Plugin, type PluginOption } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

const require = createRequire(import.meta.url);
// The published CJS plugin has a nested default when Vite loads this ESM config.
const uniFactory: () => PluginOption = typeof uni === 'function' ? uni
  : (uni as unknown as { default: () => PluginOption }).default;
const i18nRuntime = normalizePath(require.resolve('vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'));

// Classic uni-app 503 aliases to its bundled vue-i18n 9.1.9. Replace the whole
// runtime together with its patched intlify packages, not only the old core.
function patchedI18nRuntime(): Plugin {
  return {
    name: 'hejian:patched-i18n-runtime',
    enforce: 'post',
    config() {
      if (require('vue-i18n/package.json').version !== '9.14.5') {
        throw new Error('vue-i18n version changed; review the uni-app runtime alias before building.');
      }
      return { resolve: { alias: [
        { find: /^vue-i18n\/runtime$/, replacement: i18nRuntime },
        { find: /^vue-i18n$/, replacement: i18nRuntime }
      ] } };
    },
    configResolved(config) {
      if (config.build.ssr) {
        throw new Error('This mobile client supports client rendering only; SSR needs a separate compatibility review.');
      }
      for (const target of ['vue-i18n', 'vue-i18n/runtime']) {
        const first = config.resolve.alias.find(entry => typeof entry.find === 'string'
          ? target === entry.find || target.startsWith(entry.find + '/')
          : entry.find.test(target));
        if (!first || normalizePath(first.replacement) !== i18nRuntime) {
          throw new Error(`The patched i18n runtime alias is not first for ${target}.`);
        }
      }
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [uniFactory(), patchedI18nRuntime()],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { sourcemap: false }
});
