import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as exchanges from '../shared/exchanges.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const sourceFile = path => new URL(`../apps/mobile/src/${path}`, import.meta.url);
const receiptId = n => `shop-api-${n.toString(16).padStart(64, '0')}`;
function receipt(n = 1) {
  return { exchangeFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: 1793044800000,
    exchange: { id: receiptId(n), day: '2026-10-27', items: [{ sku: 'feed-pack', title: `历史饲料${n}`, art: 'feed', quantity: 1, unitPoints: 30, linePoints: 30, grant: { feed: 3 } }], count: 1, subtotal: 30, discount: 0, total: 30, couponId: null, received: { feed: 3 } } };
}
function state(overrides = {}) {
  return vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), busy: false, pending: false, message: '', error: '',
    exchangeHistory: null, exchangeRecord: null, exchangeHistoryBusy: false, exchangeHistoryError: '', exchangeRecordBusy: false,
    exchangeRecordError: '', confirmedCheckout: false, ...overrides });
}
function evaluate(source, imports, globals = {}) {
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  return new Function('require', 'exports', ...Object.keys(globals), `${code}\nreturn exports;`)(name => {
    assert.ok(imports[name], `explicit import ${name}`); return name.endsWith('.vue') ? { default: imports[name] } : imports[name];
  }, {}, ...Object.values(globals));
}
async function setup(path, farmState, extra = {}, exposed = '') {
  const source = (await readFile(sourceFile(path), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const loads = [], shows = [], routeLoads = [];
  const farm = { farmState, loadExchangeHistory: (...args) => loads.push(args), loadExchangeRecord: async (...args) => { loads.push(args); return true; }, ...extra };
  const module = evaluate(source + `\nexports.page = { ${exposed} };`, {
    vue: { ...vue, onMounted() {} }, '@dcloudio/uni-app': { onShow: fn => shows.push(fn), onLoad: fn => routeLoads.push(fn) },
    '../../core/farm': farm, '../../../../../shared/exchanges.mjs': exchanges
  }, { defineOptions() {}, ...extra.globals });
  return { page: module.page, loads, shows, routeLoads };
}

test('history return retains all 23 loaded receipts and only an explicit refresh requests start', async () => {
  const records = Array.from({ length: 23 }, (_, i) => receipt(i + 1).exchange);
  const current = state({ exchangeHistory: { items: records, nextCursor: null } });
  const h = await setup('pages/exchanges/index.vue', current, {}, 'load');
  h.shows[0](); h.shows[0]();
  assert.equal(h.loads.length, 0); assert.equal(current.exchangeHistory.items.length, 23);
  h.page.load(receiptId(4)); assert.deepEqual(h.loads, [[receiptId(4)]]);
  h.page.load(); assert.deepEqual(h.loads.at(-1), ['start']);
  assert.equal(current.exchangeHistory.items.length, 23, 'request initiation does not erase a valid view');
});

test('history starts once data is absent and makes no private request for a guest', async () => {
  const current = state({ authenticated: false });
  const h = await setup('pages/exchanges/index.vue', current, {}, 'load');
  h.shows[0](); assert.deepEqual(h.loads, []);
  current.authenticated = true; h.shows[0](); assert.deepEqual(h.loads, [['start']]);
});

async function historyFocusHarness({ keyboard = true, succeeds = true, final = true, movedFocus = false } = {}) {
  class Element {
    isConnected = true;
    focus() { document.activeElement = this; this.focused = true; }
    scrollIntoView() {}
  }
  const trigger = new Element(), result = new Element(), elsewhere = new Element();
  const document = { body: {}, activeElement: trigger, getElementById: id => id === 'exchange-history-result' ? result : null };
  const current = state({ exchangeHistory: { items: Array.from({ length: 20 }, (_, index) => receipt(index + 1).exchange), nextCursor: receiptId(1) } });
  const h = await setup('pages/exchanges/index.vue', current, {
    globals: { document, HTMLElement: Element },
    loadExchangeHistory: async () => {
      if (succeeds && final) {
        current.exchangeHistory.items.push(...[21, 22, 23].map(n => receipt(n).exchange)); current.exchangeHistory.nextCursor = null;
        trigger.isConnected = false; document.activeElement = movedFocus ? elsewhere : document.body;
      }
      return succeeds;
    }
  }, 'load');
  await h.page.load(receiptId(1), { detail: keyboard ? 0 : 1, currentTarget: trigger });
  return { document, result, elsewhere, current };
}

test('keyboard loading the final history page transfers removed-button focus to the result status', async () => {
  const h = await historyFocusHarness();
  assert.equal(h.current.exchangeHistory.items.length, 23); assert.equal(h.document.activeElement, h.result); assert.equal(h.result.focused, true);
});

test('pointer loading, failed reads, nonfinal pages and a deliberate focus move never steal result focus', async () => {
  for (const options of [{ keyboard: false }, { succeeds: false }, { final: false }, { movedFocus: true }]) {
    const h = await historyFocusHarness(options); assert.notEqual(h.document.activeElement, h.result); assert.notEqual(h.result.focused, true);
  }
});

test('receipt route whitelist rejects invalid or ambiguous selection without dispatching a read', async () => {
  for (const query of [undefined, {}, { id: '../other' }, { id: receiptId(1).toUpperCase() }, { operation: 'anything' }, { id: receiptId(1), operation: 'last' }, { id: [receiptId(1)] }]) {
    const h = await setup('pages/exchange/index.vue', state({ exchangeRecord: receipt(2) }), {}, 'routeError, detail');
    h.routeLoads[0](query); h.shows[0]();
    assert.match(h.page.routeError.value, /收据位置无效/); assert.equal(h.page.detail.value, null); assert.deepEqual(h.loads, []);
  }
});

test('a selected receipt never displays a different ordinary receipt while awaiting its read', async () => {
  const current = state({ exchangeRecord: receipt(2) });
  const h = await setup('pages/exchange/index.vue', current, {}, 'detail, received');
  h.routeLoads[0]({ id: receiptId(1) }); h.shows[0]();
  assert.deepEqual(h.loads, [[receiptId(1)]]); assert.equal(h.page.detail.value, null);
  current.exchangeRecord = receipt(1); assert.equal(h.page.detail.value.exchange.id, receiptId(1));
  assert.deepEqual(h.page.received.value.map(item => [item.key, item.quantity]), [['feed', 3]]);
});

test('last-operation receipt cannot display a previous ordinary receipt before its own read succeeds', async () => {
  const current = state({ exchangeRecord: receipt(2) }); let finish;
  const h = await setup('pages/exchange/index.vue', current, { loadExchangeRecord: () => new Promise(resolve => { finish = resolve; }) }, 'detail, load');
  h.routeLoads[0]({ operation: 'last' });
  assert.equal(h.page.detail.value, null, 'route selection alone must not relabel a cached ordinary receipt');
  const loading = h.page.load(); assert.equal(h.page.detail.value, null);
  current.exchangeRecord = receipt(1); finish(true); await loading;
  assert.equal(h.page.detail.value.exchange.id, receiptId(1));
  current.exchangeRecord = receipt(2); assert.equal(h.page.detail.value, null, 'a sibling receipt cannot replace the confirmed original while this page is in the stack');
  const retry = h.page.load(); assert.equal(h.page.detail.value, null);
  current.exchangeRecord = receipt(2); finish(false); await retry;
  assert.equal(h.page.detail.value, null, 'failed lookup cannot reveal a leftover ordinary receipt');
});

test('a late last-operation read cannot hide the newer successful receipt', async () => {
  const current = state({ exchangeRecord: receipt(2) }), pending = [];
  const h = await setup('pages/exchange/index.vue', current, { loadExchangeRecord: () => new Promise(resolve => pending.push(resolve)) }, 'detail, load');
  h.routeLoads[0]({ operation: 'last' }); const first = h.page.load(), second = h.page.load();
  current.exchangeRecord = receipt(1); pending[1](true); await second;
  assert.equal(h.page.detail.value.exchange.id, receiptId(1));
  pending[0](false); await first;
  assert.equal(h.page.detail.value.exchange.id, receiptId(1));
});

test('warehouse reads current feed from the wallet and reacts to the latest snapshot', async () => {
  const snapshot = mobileSnapshot(); snapshot.wallet.feed = 6; snapshot.system.inventory.feed = 999; snapshot.system.inventory.fertilizer = 4;
  const current = state({ snapshot }), h = await setup('pages/inventory/index.vue', current, { onFarmPageShow() {} }, 'resources');
  assert.equal(h.page.resources.value.find(item => item.key === 'feed').quantity, 6);
  assert.equal(h.page.resources.value.find(item => item.key === 'fertilizer').quantity, 4);
  current.snapshot.wallet.feed = 10; assert.equal(h.page.resources.value.find(item => item.key === 'feed').quantity, 10);
});

test('exchange history, receipt and warehouse navigation select My while cart and farm detail keep their owners', async () => {
  const source = (await readFile(sourceFile('components/FarmNavigation.vue'), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  let route = 'pages/exchanges/index';
  const navigation = evaluate(source + '\nexports.navigation = { selected, syncRoute };', { vue: { ...vue, onMounted() {} }, '@dcloudio/uni-app': { onShow() {} } }, { getCurrentPages: () => [{ route }], uni: {} }).navigation;
  for (const page of ['exchanges', 'exchange', 'inventory']) {
    route = `pages/${page}/index`; navigation.syncRoute(); assert.equal(navigation.selected.value, 'pages/profile/index');
  }
  route = 'pages/cart/index'; navigation.syncRoute(); assert.equal(navigation.selected.value, 'pages/shop/index');
  route = 'pages/farm-record/index'; navigation.syncRoute(); assert.equal(navigation.selected.value, 'pages/farm/index');
});

async function component(path, imports) {
  const descriptor = parse(await readFile(sourceFile(path), 'utf8')).descriptor;
  return evaluate(compileScript(descriptor, { id: path, inlineTemplate: true }).content, { vue, ...imports }).default;
}
const buttonStub = vue.defineComponent({ setup(_, { slots }) { return () => vue.h('button', {}, slots.default?.()); } });
const invisibleStub = vue.defineComponent({ setup() { return () => null; } });
function renderInMemory(component, props = {}, warnings) {
  // Use this app's actual Vue renderer. The overridden server-renderer package
  // targets a different Vue patch; a tiny host avoids mixing runtime instances.
  const renderer = vue.createRenderer({
    createElement: type => ({ type, props: {}, children: [] }), createText: text => ({ type: '#text', text }), createComment: text => ({ type: '#comment', text: '' }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, name, oldValue, value) => { node.props[name] = value; },
    remove: node => { const index = node.parent?.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); },
    insert(node, parent, anchor) {
      if (node.parent) { const index = node.parent.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); }
      node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    }
  });
  const root = { type: 'root', children: [] }, app = renderer.createApp(component, props);
  if (warnings) app.config.warnHandler = message => warnings.push(message);
  app.mount(root);
  const content = node => (node.type === '#comment' ? '' : node.text || '') + (node.children || []).map(content).join('');
  const result = content(root); app.unmount(); return result;
}
test('the actual receipt template suppresses its own confirmed-receipt entry while the shared screen still offers it elsewhere', async () => {
  const current = state({ confirmedCheckout: true, exchangeRecord: receipt(2) });
  const farm = { farmState: current, openProfile() {}, refreshFarm() {}, retryFarmOperation() {}, openConfirmedCheckout() {}, loadExchangeRecord: async () => false };
  const screen = await component('components/FarmScreen.vue', { '../core/farm': farm, './FarmButton.vue': buttonStub, './FarmNavigation.vue': invisibleStub });
  const regular = renderInMemory(screen, { title: '商城', allowGuest: true });
  assert.match(regular, /查看最近确认的兑换收据/);
  const detail = await component('pages/exchange/index.vue', {
    '@dcloudio/uni-app': { onLoad: fn => fn({ operation: 'last' }), onShow: fn => fn() }, '../../core/farm': farm,
    '../../../../../shared/exchanges.mjs': exchanges, '../../components/FarmScreen.vue': screen, '../../components/FarmButton.vue': buttonStub,
    '../../components/EmptyPanel.vue': invisibleStub, '../../components/FarmGoodsPhoto.vue': invisibleStub
  });
  const html = renderInMemory(detail);
  assert.doesNotMatch(html, /查看最近确认的兑换收据/); assert.doesNotMatch(html, /历史饲料2/);
});

test('uni route query attrs are consumed by the receipt page rather than falling through to the fragment screen', async () => {
  const current = state(), warnings = [];
  const farm = { farmState: current, openProfile() {}, refreshFarm() {}, retryFarmOperation() {}, openConfirmedCheckout() {}, loadExchangeRecord: async () => false };
  const screen = await component('components/FarmScreen.vue', { '../core/farm': farm, './FarmButton.vue': buttonStub, './FarmNavigation.vue': invisibleStub });
  const detail = await component('pages/exchange/index.vue', {
    '@dcloudio/uni-app': { onLoad: fn => fn({ operation: 'last' }), onShow: fn => fn() }, '../../core/farm': farm,
    '../../../../../shared/exchanges.mjs': exchanges, '../../components/FarmScreen.vue': screen, '../../components/FarmButton.vue': buttonStub,
    '../../components/EmptyPanel.vue': invisibleStub, '../../components/FarmGoodsPhoto.vue': invisibleStub
  });
  renderInMemory(detail, { operation: 'last' }, warnings);
  assert.deepEqual(warnings, []);
});
