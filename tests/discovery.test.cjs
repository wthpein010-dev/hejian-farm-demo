const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Systems = require('../prototype/systems.js');

const file = path.join(__dirname, '../prototype/discovery.js');
let Discovery = {};
try { Discovery = require(file); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const now = Date.parse('2026-10-27T04:00:00Z');
const catalog = () => Systems.getCatalog();
const system = () => Systems.createState(now);
const wallet = points => ({ points, feed: 6, receipts: [], adToday: 0, inviteCount: 0, welcomeClaimed: false });
const ids = items => items.map(item => item.id);
function call(method, ...args) {
  assert.equal(typeof Discovery[method], 'function', `${method} must exist`);
  return Discovery[method](...args);
}

test('availability separates purchased daily stock from quantities already in the cart', () => {
  const item = catalog().find(item => item.id === 'feed-pack'), state = system();
  state.daily.bought['feed-pack'] = 2;
  state.cart['feed-pack'] = 1;
  const before = JSON.stringify(state);
  assert.deepEqual(call('availability', item, state), { remaining: 3, inCart: 1, canAdd: 2, unavailable: '' });
  state.cart['feed-pack'] = 3;
  assert.deepEqual(call('availability', item, state), { remaining: 3, inCart: 3, canAdd: 0, unavailable: '购物车达限' });
  state.cart['feed-pack'] = 1;
  assert.equal(JSON.stringify(state), before);
});

test('availability caps cart additions at five and explains daily sold out first', () => {
  const state = system(), item = { id: 'test-stock', limit: 8 };
  state.cart[item.id] = 4;
  assert.deepEqual(call('availability', item, state), { remaining: 8, inCart: 4, canAdd: 1, unavailable: '' });
  const gift = catalog().find(item => item.id === 'garden-sign');
  state.daily.bought[gift.id] = 3;
  assert.deepEqual(call('availability', gift, state), { remaining: 0, inCart: 0, canAdd: 0, unavailable: '今日兑完' });
});

test('affordable and available filters describe different eligibility without applying coupons', () => {
  const products = catalog(), state = system(), purse = wallet(30);
  state.daily.bought['fertilizer'] = 5;
  state.cart['care-tools'] = 5;
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'supplies', filter: 'affordable' })), ['feed-pack', 'fertilizer', 'care-tools']);
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'supplies', filter: 'available' })), ['feed-pack', 'seed-box', 'care-bundle']);
  assert.deepEqual(ids(call('select', products, state, wallet(45), { category: 'supplies', query: '日常照料组合', filter: 'affordable' })), [], 'a coupon does not make a 65-point item affordable at its single-item price');
});

test('search combines category and literal query with resource keywords from bundle grants', () => {
  const products = catalog(), state = system(), purse = wallet(500);
  const cases = [
    ['饲料', ['feed-pack', 'care-bundle', 'season-gift']],
    ['肥料', ['fertilizer', 'care-bundle', 'season-gift']],
    ['工具', ['care-tools', 'care-bundle']],
    ['种子', ['seed-box']],
    ['装扮', ['garden-sign', 'harvest-frame']]
  ];
  for (const [query, expected] of cases) assert.deepEqual(ids(call('select', products, state, purse, { query })), expected);
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'gifts', query: '饲料' })), ['season-gift']);
  assert.deepEqual(ids(call('select', products, state, purse, { query: '按需使用' })), ['season-gift'], 'the saved product description is searchable');
});

test('search, wishlist, category and sorting compose without sorting or changing economic inputs', () => {
  const products = catalog(), state = system(), purse = wallet(500), wishes = ['care-bundle', 'fertilizer', 'season-gift'];
  const before = JSON.stringify({ products, state, purse, wishes });
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'supplies', query: '肥料', filter: 'wishlist', sort: 'cost-desc', wishlist: wishes })), ['care-bundle', 'fertilizer']);
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'supplies', sort: 'cost-asc' })), ['fertilizer', 'care-tools', 'feed-pack', 'seed-box', 'care-bundle']);
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'supplies', sort: 'recommended' })), ['feed-pack', 'fertilizer', 'care-tools', 'seed-box', 'care-bundle']);
  assert.equal(JSON.stringify({ products, state, purse, wishes }), before);
});

test('empty and whitespace queries keep all category items and unmatched text returns an empty result', () => {
  const products = catalog(), state = system(), purse = wallet(0);
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'gifts', query: '' })), ['garden-sign', 'harvest-frame', 'season-gift']);
  assert.deepEqual(ids(call('select', products, state, purse, { category: 'gifts', query: '   ' })), ['garden-sign', 'harvest-frame', 'season-gift']);
  assert.deepEqual(call('select', products, state, purse, { query: '不存在的物资' }), []);
});

test('query markup and regular-expression syntax are only literal search text', () => {
  const products = catalog(), state = system(), purse = wallet(100);
  const before = JSON.stringify({ products, state, purse });
  for (const query of ['<script>globalThis.discoveryInjected=true</script>', '.*', '[', '__proto__']) {
    assert.deepEqual(call('select', products, state, purse, { query }), []);
  }
  assert.equal(globalThis.discoveryInjected, undefined);
  assert.equal(JSON.stringify({ products, state, purse }), before);
});

test('wishlist toggles return independent known unique IDs without changing assets or input IDs', () => {
  const products = catalog(), state = system(), purse = wallet(80), wishes = ['feed-pack', 'feed-pack', 'unknown', 'fertilizer'];
  const before = JSON.stringify({ products, state, purse, wishes });
  const removed = call('toggleWishlist', products, wishes, 'feed-pack');
  assert.deepEqual(removed, ['fertilizer']);
  const added = call('toggleWishlist', products, wishes, 'care-bundle');
  assert.deepEqual(added, ['feed-pack', 'fertilizer', 'care-bundle']);
  const unknown = call('toggleWishlist', products, wishes, '__proto__');
  assert.deepEqual(unknown, ['feed-pack', 'fertilizer']);
  assert.notEqual(unknown, wishes);
  assert.equal(JSON.stringify({ products, state, purse, wishes }), before);
  assert.deepEqual(ids(call('select', products, state, purse, { filter: 'wishlist', wishlist: removed })), ['fertilizer']);
  assert.deepEqual(call('select', products, state, purse, { filter: 'wishlist', wishlist: [] }), []);
});

test('goal reports single-item progress at zero, partial, exact and excess points without spending', () => {
  const products = catalog(), item = products.find(item => item.id === 'feed-pack');
  for (const [points, shortfall, percent] of [[0, 30, 0], [10, 20, 33], [30, 0, 100], [300, 0, 100]]) {
    const purse = wallet(points), before = JSON.stringify(purse);
    assert.deepEqual(call('goal', products, purse, 'feed-pack'), { item, points, shortfall, percent });
    assert.equal(JSON.stringify(purse), before);
  }
});

test('goal returns null for unknown products and clamps defensive negative balances for display', () => {
  const products = catalog(), purse = wallet(-5), before = JSON.stringify(purse);
  assert.equal(call('goal', products, purse, 'missing'), null);
  assert.deepEqual(call('goal', products, purse, 'feed-pack'), { item: products[0], points: 0, shortfall: 30, percent: 0 });
  assert.equal(JSON.stringify(purse), before);
  assert.deepEqual(call('select', products, system(), purse, { filter: 'affordable' }), []);
});

test('browser UMD exposes the same resource discovery behavior without a platform dependency', () => {
  assert.ok(fs.existsSync(file), 'FarmDiscovery browser script must exist');
  const browser = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), browser, { filename: file });
  const products = catalog(), state = system();
  const selected = browser.window.FarmDiscovery.select(products, state, wallet(30), { query: '肥料', filter: 'affordable' });
  assert.equal(JSON.stringify(ids(selected)), '["fertilizer"]');
  assert.equal(browser.window.localStorage, undefined);
});
