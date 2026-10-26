const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const modulePath = path.join(__dirname, '../prototype/domain.js');
let domain = {};
try { domain = require(modulePath); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function call(name, ...args) {
  assert.equal(typeof domain[name], 'function', `${name} must be implemented`);
  return domain[name](...args);
}
const at = Date.parse('2026-10-27T04:00:00Z');
const freshWallet = () => ({ points: 0, feed: 0, receipts: [], adToday: 0, inviteCount: 0, welcomeClaimed: false });
const product = (overrides = {}) => ({ id: 'radish', name: '萝卜', type: 'crop', seasons: ['autumn'], days: 28, cost: 6, yieldKg: [2, 3], pricePerKg: [4, 6], ...overrides });
const shipping = (overrides = {}) => ({ name: '李小禾', phone: '13800138000', address: '上海市浦东新区禾间路12号', email: '', method: 'delivery', ...overrides });

test('season changes at March, June, September and December boundaries', () => {
  const expected = ['winter','winter','spring','spring','spring','summer','summer','summer','autumn','autumn','autumn','winter'];
  expected.forEach((key, index) => assert.equal(call('getSeason', index + 1).key, key));
  assert.equal(call('getSeason', 10).name, '秋季');
  for (const value of [0, 13, 1.5, '10', NaN, Infinity, undefined]) assert.throws(() => call('getSeason', value));
});

test('China day rolls over at Shanghai midnight rather than UTC midnight', () => {
  assert.equal(call('chinaDayKey', Date.parse('2026-10-27T15:59:59Z')), '2026-10-27');
  assert.equal(call('chinaDayKey', Date.parse('2026-10-27T16:00:00Z')), '2026-10-28');
  assert.equal(call('chinaDayKey', Date.parse('2026-12-31T16:00:00Z')), '2027-01-01');
  for (const value of ['1', NaN, Infinity, -1]) assert.throws(() => call('chinaDayKey', value));
});

test('season suitability outranks a short but out-of-season product without mutating inputs', () => {
  const input = [product({ id: 'summer', seasons: ['summer'], days: 1, cost: 0 }), product()];
  const before = JSON.stringify(input);
  const ranked = call('rankProducts', input, 10);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(ranked.map(item => item.id), ['radish', 'summer']);
  assert.equal(ranked[0].recommended, true);
  assert.equal(ranked[1].recommended, false);
  assert.equal(Number.isFinite(ranked[0].score), true);
  assert.match(ranked[0].recommendationReason, /秋季/);
  ranked[0].seasons.push('winter');
  ranked[0].yieldKg[0] = 99;
  assert.deepEqual(input[1].seasons, ['autumn']);
  assert.deepEqual(input[1].yieldKg, [2, 3]);
});

test('recommendations prefer faster maturity then sample net value, with deterministic ties', () => {
  const ranked = call('rankProducts', [product({ id: 'slow', days: 60 }), product({ id: 'low', days: 28, cost: 7 }), product({ id: 'high', days: 28, cost: 2 })], 10);
  assert.deepEqual(ranked.map(item => item.id), ['high', 'low', 'slow']);
  assert.deepEqual(ranked.find(item => item.id === 'high').estimatedValue, { min: 8, max: 18 });
  assert.equal(ranked[0].harvestMonth, 11);
  assert.equal(call('rankProducts', [product({ days: 45, seasons: ['winter'] })], 12)[0].harvestMonth, 2);
  assert.deepEqual(call('rankProducts', [], 1), []);
});

test('malformed product numbers cannot create infinite or negative recommendation values', () => {
  assert.equal(typeof domain.rankProducts, 'function');
  for (const input of [{ days: '28' }, { days: -1 }, { cost: Infinity }, { yieldKg: [3, 2] }, { yieldKg: [-1, 2] }, { pricePerKg: [1, NaN] }, { yieldKg: [Number.MAX_VALUE, Number.MAX_VALUE] }]) {
    assert.throws(() => call('rankProducts', [product(input)], 10));
  }
});

test('large finite costs retain a finite recommendation score', () => {
  const result = call('rankProducts', [product({ cost: Number.MAX_VALUE, days: 1000, seasons: ['summer'] })], 10)[0];
  assert.equal(Number.isFinite(result.score), true);
  assert.equal(result.score >= 0, true);
});

test('watering checks growth, wet soil, six hour boundary and daily cap', () => {
  const care = { kind: 'water', usedToday: 0, lastAt: null, now: at, moisture: 32, growing: true };
  assert.equal(call('careEligibility', care).allowed, true);
  assert.equal(call('careEligibility', { ...care, growing: false }).allowed, false);
  assert.equal(call('careEligibility', { ...care, moisture: 65 }).allowed, false);
  const waiting = call('careEligibility', { ...care, usedToday: 1, lastAt: at - 6 * 3600000 + 1 });
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.remaining, 1);
  assert.equal(waiting.nextAt, at + 1);
  assert.equal(call('careEligibility', { ...care, usedToday: 1, lastAt: at - 6 * 3600000 }).allowed, true);
  const capped = call('careEligibility', { ...care, usedToday: 2 });
  assert.equal(capped.allowed, false);
  assert.equal(capped.remaining, 0);
  assert.equal(capped.nextAt, Date.parse('2026-10-27T16:00:00Z'));
});

test('feeding consumes neither extra allowance nor missing inventory through eligibility checks', () => {
  const care = { kind: 'feed', usedToday: 1, lastAt: at - 4 * 3600000, now: at, inventory: 1 };
  assert.equal(call('careEligibility', care).allowed, true);
  assert.equal(call('careEligibility', { ...care, inventory: 0 }).allowed, false);
  assert.equal(call('careEligibility', { ...care, lastAt: at - 4 * 3600000 + 1 }).allowed, false);
  assert.equal(call('careEligibility', { ...care, usedToday: 2 }).allowed, false);
  const before = JSON.stringify(care);
  call('careEligibility', care);
  assert.equal(JSON.stringify(care), before);
});

test('care eligibility fails closed for malformed numbers and future timestamps', () => {
  const care = { kind: 'water', usedToday: 0, lastAt: null, now: at, moisture: 32, growing: true };
  for (const change of [{ usedToday: -1 }, { usedToday: '0' }, { usedToday: NaN }, { now: Infinity }, { lastAt: at + 1 }, { moisture: -1 }, { moisture: '32' }]) {
    const result = call('careEligibility', { ...care, ...change });
    assert.equal(result.allowed, false);
    assert.equal(Number.isFinite(result.remaining), true);
  }
});

test('care quota follows caller-owned state across screen reconstruction and the next China day', () => {
  const state = { kind: 'water', usedToday: 2, lastAt: at - 7 * 3600000, now: at, moisture: 32, growing: true };
  assert.equal(call('careEligibility', JSON.parse(JSON.stringify(state))).allowed, false);
  assert.equal(call('careEligibility', { ...state, usedToday: 0, now: Date.parse('2026-10-27T16:00:00Z') }).allowed, true);
});

test('shipping requires real delivery fields, mainland mobile and bounded optional email', () => {
  assert.deepEqual(call('validateShipping', shipping()), { valid: true, errors: {} });
  assert.equal(call('validateShipping', shipping({ email: 'li@example.com' })).valid, true);
  const missing = call('validateShipping', shipping({ name: '', phone: '', address: '' }));
  assert.equal(missing.valid, false);
  assert.deepEqual(Object.keys(missing.errors).sort(), ['address','name','phone']);
  for (const phone of ['12800138000', '1380013800', '+8613800138000', 13800138000]) assert.equal(call('validateShipping', shipping({ phone })).valid, false);
  assert.equal(call('validateShipping', shipping({ method: 'pickup', address: '' })).valid, true);
  assert.equal(call('validateShipping', shipping({ method: 'pickup', phone: '' })).valid, false);
});

test('injection and overlong shipping inputs are rejected without being echoed', () => {
  const attack = '<img src=x onerror=alert(1)>';
  for (const field of ['name','address','email']) {
    const result = call('validateShipping', shipping({ [field]: attack }));
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes(attack), false);
  }
  for (const [field, length] of [['name',31],['address',161],['email',121]]) assert.equal(call('validateShipping', shipping({ [field]: 'a'.repeat(length) })).valid, false);
  assert.equal(call('validateShipping', shipping({ address: '上海\n<script>bad</script>' })).valid, false);
});

test('shipping summaries never expose complete personal fields or unsafe source strings', () => {
  const input = shipping({ email: 'private@example.com' });
  const before = JSON.stringify(input);
  const summary = call('maskShipping', input);
  assert.deepEqual(Object.keys(summary).sort(), ['address','email','name','phone']);
  for (const field of ['name','phone','address','email']) assert.notEqual(summary[field], input[field]);
  assert.equal(summary.phone, '138****8000');
  assert.equal(JSON.stringify(input), before);
  const unsafe = call('maskShipping', { name: '<script>', phone: 'x'.repeat(10000), address: '<img src=x>', email: '<svg>' });
  assert.equal(/[<>]/.test(JSON.stringify(unsafe)), false);
  assert.equal(JSON.stringify(unsafe).length < 180, true);
});

test('cancelled ads and unqualified invites grant nothing or consume a receipt', () => {
  const wallet = freshWallet();
  const ad = call('grantReward', wallet, { kind: 'ad', receiptId: 'ad-1', completed: false });
  const invite = call('grantReward', wallet, { kind: 'invite', receiptId: 'friend-1', qualified: false });
  assert.equal(ad.granted, false);
  assert.equal(invite.granted, false);
  assert.deepEqual(ad.wallet, wallet);
  assert.deepEqual(invite.wallet, wallet);
  assert.equal(call('grantReward', ad.wallet, { kind: 'ad', receiptId: 'ad-1', completed: true }).granted, true);
  assert.equal(call('grantReward', wallet, { kind: 'ad', receiptId: 'ad-2', completed: 'true' }).granted, false);
});

test('ad receipt is idempotent across screens, up to three completed ads per caller-owned day', () => {
  const original = freshWallet();
  let result = call('grantReward', original, { kind: 'ad', receiptId: 'ad-1', completed: true });
  assert.equal(result.granted, true);
  assert.equal(result.wallet.points, 20);
  assert.equal(result.wallet.feed, 1);
  assert.deepEqual(original, freshWallet());
  let wallet = JSON.parse(JSON.stringify(result.wallet));
  result = call('grantReward', wallet, { kind: 'ad', receiptId: 'ad-1', completed: true });
  assert.equal(result.granted, false);
  assert.equal(result.wallet.points, 20);
  for (const id of ['ad-2','ad-3']) wallet = call('grantReward', wallet, { kind: 'ad', receiptId: id, completed: true }).wallet;
  result = call('grantReward', wallet, { kind: 'ad', receiptId: 'ad-4', completed: true });
  assert.equal(result.granted, false);
  assert.equal(result.wallet.points, 60);
  assert.equal(result.wallet.adToday, 3);
  const nextDay = { ...wallet, adToday: 0 };
  assert.equal(call('grantReward', nextDay, { kind: 'ad', receiptId: 'ad-1', completed: true }).granted, false);
  assert.equal(call('grantReward', nextDay, { kind: 'ad', receiptId: 'ad-4', completed: true }).granted, true);
});

test('qualified invite receipt cannot be replayed and welcome can only be granted once', () => {
  let result = call('grantReward', freshWallet(), { kind: 'invite', receiptId: 'friend-1', qualified: true });
  assert.equal(result.wallet.points, 50);
  assert.equal(result.wallet.feed, 2);
  assert.equal(result.wallet.inviteCount, 1);
  assert.equal(call('grantReward', result.wallet, { kind: 'invite', receiptId: 'friend-1', qualified: true }).granted, false);
  result = call('grantReward', result.wallet, { kind: 'welcome', receiptId: 'welcome-1' });
  assert.equal(result.wallet.points, 80);
  assert.equal(result.wallet.feed, 4);
  assert.equal(result.wallet.welcomeClaimed, true);
  assert.equal(call('grantReward', result.wallet, { kind: 'welcome', receiptId: 'welcome-2' }).granted, false);
});

test('malformed wallets and unsafe receipt ids cannot grant rewards or reset counters', () => {
  for (const field of ['points','feed','adToday','inviteCount']) for (const value of [-1,NaN,Infinity,'0',1.5]) {
    const wallet = { ...freshWallet(), [field]: value };
    assert.throws(() => call('grantReward', wallet, { kind: 'ad', receiptId: 'ad-1', completed: true }));
  }
  for (const receiptId of ['', '<script>', 'a'.repeat(129), 123]) assert.equal(call('grantReward', freshWallet(), { kind: 'ad', receiptId, completed: true }).granted, false);
  const overflow = call('grantReward', { ...freshWallet(), points: Number.MAX_SAFE_INTEGER }, { kind: 'welcome', receiptId: 'welcome' });
  assert.equal(overflow.granted, false);
  assert.equal(overflow.wallet.points, Number.MAX_SAFE_INTEGER);
});

test('same source runs as a browser global without CommonJS or external dependencies', () => {
  assert.equal(fs.existsSync(modulePath), true, 'domain module must exist');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(modulePath, 'utf8'), context);
  assert.equal(context.window.FarmDomain.getSeason(12).key, 'winter');
  assert.equal(context.window.FarmDomain.careEligibility({ kind: 'feed', usedToday: 2, lastAt: null, now: at, inventory: 3 }).allowed, false);
});
