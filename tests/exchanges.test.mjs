import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Systems = require('../prototype/systems.js');
const contract = await import('../shared/exchanges.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const OWNER = 'account_A-1';
const scope = { ownerId: OWNER, environment: 'development', serverTime: 1_800_000_000_000 };
const exchangeId = number => `shop-api-${number.toString(16).padStart(64, '0')}`;
const raw = (number = 1, overrides = {}) => ({
  id: exchangeId(number), receiptId: exchangeId(number).slice(5), day: '2026-10-27',
  items: [
    { id: 'historic-feed', title: '旧季饲料组合', description: '曾经的商品说明', category: 'supplies',
      art: 'bundle', cost: 17, quantity: 2, lineTotal: 34, limit: 9, grant: { feed: 4, fertilizer: 1 } },
    { id: 'historic-sign', title: '旧季纪念木牌', art: 'sign', cost: 11, quantity: 1,
      lineTotal: 11, grant: { decorations: 1 } },
  ],
  count: 3, subtotal: 45, discount: 5, total: 40, couponId: 'old-coupon', ...overrides,
});
function required(name) {
  assert.equal(typeof contract[name], 'function', `Missing exchange contract export: ${name}`);
  return contract[name];
}
function invalid(value) {
  assert.throws(() => required('toExchange')(value), required('ExchangeValidationError'));
}
const projected = () => ({
  id: exchangeId(1), day: '2026-10-27',
  items: [
    { sku: 'historic-feed', title: '旧季饲料组合', art: 'bundle', quantity: 2, unitPoints: 17,
      linePoints: 34, grant: { feed: 4, fertilizer: 1 } },
    { sku: 'historic-sign', title: '旧季纪念木牌', art: 'sign', quantity: 1, unitPoints: 11,
      linePoints: 11, grant: { decorations: 1 } },
  ], count: 3, subtotal: 45, discount: 5, total: 40, couponId: 'old-coupon',
  received: { feed: 8, fertilizer: 2, decorations: 1 },
});
const wirePage = overrides => ({ exchangeFormat: 1, ...scope, items: [projected()], nextCursor: null, ...overrides });
const wireDetail = overrides => ({ exchangeFormat: 1, ...scope, exchange: projected(), ...overrides });

test('historical checkout projection keeps original prices and grants without consulting the current catalog', () => {
  const input = raw();
  const result = required('toExchange')(input);
  assert.deepEqual(result, projected());
  input.items[0].title = 'changed'; input.items[0].grant.feed = 99;
  assert.equal(result.items[0].title, '旧季饲料组合');
  assert.deepEqual(result.received, { feed: 8, fertilizer: 2, decorations: 1 });
  assert.equal(result.items[0].grant.feed, 4);
  assert.equal(JSON.stringify(result).includes('receiptId'), false);
  assert.equal(JSON.stringify(result).includes('description'), false);
});

test('the projection accepts an actual Systems.checkout receipt and all five supported grant resources', () => {
  const now = scope.serverTime;
  let system = Systems.createState(now);
  for (const sku of ['feed-pack', 'fertilizer', 'care-tools', 'seed-box', 'garden-sign']) {
    system = Systems.addCart(system, sku, 1, now).system;
  }
  const wallet = { points: 500, feed: 6, adToday: 0, inviteCount: 0, welcomeClaimed: false, receipts: [] };
  const result = Systems.checkout(system, wallet, { now, receiptId: raw().receiptId, couponId: 'welcome-20' });
  assert.equal(result.ok, true);
  const exchange = required('toExchange')(result.purchase);
  assert.deepEqual(exchange.received, { feed: 3, fertilizer: 1, tools: 1, seedPacks: 1, decorations: 1 });
  assert.equal(exchange.subtotal, 195);
  assert.equal(exchange.discount, 20);
  assert.equal(exchange.total, 175);
  const metadata = contract.RESOURCE_INFO;
  assert.ok(Array.isArray(metadata));
  assert.deepEqual(metadata.map(item => item.key), ['feed', 'fertilizer', 'tools', 'seedPacks', 'decorations']);
  for (const item of metadata) {
    assert.equal(typeof item.title, 'string'); assert.ok(item.title.length > 0);
    assert.equal(typeof item.unit, 'string'); assert.ok(item.unit.length > 0);
    assert.match(item.art, /^[a-z][a-z-]*$/);
    assert.equal(Object.isFrozen(item), true);
  }
  assert.equal(Object.isFrozen(metadata), true);
});

test('purchase and receipt identities must agree exactly and reject unsafe route identifiers', () => {
  const isId = required('isExchangeId');
  assert.equal(isId(exchangeId(1)), true);
  for (const id of [null, 1, 'shop-test', exchangeId(1) + '\n', exchangeId(1).toUpperCase(),
    exchangeId(1).slice(0, -1), exchangeId(1) + '0', '../' + exchangeId(1)]) {
    assert.equal(isId(id), false);
    invalid(raw(1, { id }));
  }
  for (const receiptId of [undefined, '', 'api-other', raw(2).receiptId, raw().receiptId + '\n']) invalid(raw(1, { receiptId }));
});

test('receipt dates are real fixed-width Gregorian days with no invented clock precision', () => {
  const project = required('toExchange');
  for (const day of ['2000-02-29', '2024-02-29', '2026-01-01', '9999-12-31']) {
    assert.equal(project(raw(1, { day })).day, day);
  }
  for (const day of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-13-01',
    '2026-10-00', '2026-10-32', '2026-1-01', '2026-10-27\n', '0000-01-01', 20261027, null]) invalid(raw(1, { day }));
});

test('historical item quantities, subtotals and totals must reconcile instead of being silently corrected', () => {
  for (const override of [{ count: 2 }, { subtotal: 44 }, { discount: 46 }, { total: 39 },
    { discount: -1 }, { total: NaN }, { subtotal: Infinity }, { count: 3.5 }, { total: '40' }]) invalid(raw(1, override));
  const input = raw(); input.items[0].lineTotal = 33; invalid(input);
  for (const changes of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { cost: -1 }, { cost: Infinity }]) {
    const value = raw(); Object.assign(value.items[0], changes); invalid(value);
  }
  invalid(raw(1, { items: [] }));
  const duplicate = raw(); duplicate.items[1].id = duplicate.items[0].id; invalid(duplicate);
});

test('coupon identity and the historical discount must agree, including a fully discounted receipt', () => {
  assert.equal(required('toExchange')(raw(1, { discount: 0, total: 45, couponId: null })).couponId, null);
  assert.equal(required('toExchange')(raw(1, { discount: 45, total: 0 })).total, 0);
  for (const changes of [{ couponId: null }, { couponId: '' }, { couponId: 'bad/coupon' },
    { couponId: 'old-coupon\n' }, { discount: 0, total: 45 }, { couponId: undefined }]) invalid(raw(1, changes));
});

test('safe-integer checks cover multiplication, accumulation and resource grants rather than only inputs', () => {
  const single = (item, overrides = {}) => raw(1, { items: [item], count: item.quantity,
    subtotal: item.lineTotal, discount: 0, total: item.lineTotal, couponId: null, ...overrides });
  const base = { ...raw().items[0], quantity: 1, cost: Number.MAX_SAFE_INTEGER,
    lineTotal: Number.MAX_SAFE_INTEGER, grant: { feed: 1 } };
  assert.equal(required('toExchange')(single(base)).total, Number.MAX_SAFE_INTEGER);
  invalid(single({ ...base, quantity: 2, lineTotal: Number.MAX_SAFE_INTEGER * 2 }));
  invalid(single({ ...base, quantity: 2, cost: 1, lineTotal: 2, grant: { feed: Number.MAX_SAFE_INTEGER } }));
  const sum = raw(1, { items: [base, { ...base, id: 'second', cost: 1, lineTotal: 1 }], count: 2,
    subtotal: Number.MAX_SAFE_INTEGER + 1, discount: 0, total: Number.MAX_SAFE_INTEGER + 1, couponId: null });
  invalid(sum);
  const received = raw(); received.items[0].grant.feed = Number.MAX_SAFE_INTEGER;
  received.items[0].quantity = 1; received.items[0].lineTotal = 17;
  received.items[1].grant.feed = 1; received.count = 2; received.subtotal = 28; received.total = 23;
  invalid(received);
});

test('only known positive resource grants can become received inventory', () => {
  for (const grant of [{ points: 20 }, { eggs: 1 }, { feed: -1 }, { feed: 0 }, { feed: 0.5 },
    { feed: Number.MAX_SAFE_INTEGER + 1 }, { feed: NaN }, { feed: '3' }, {}, [], null,
    JSON.parse('{"__proto__":3}')]) {
    const input = raw(); input.items[0].grant = grant; invalid(input);
  }
});

test('historical text and photo tokens cannot carry empty labels, control text or external image paths', () => {
  for (const changes of [{ id: '' }, { id: 'bad/sku' }, { id: 'sku\n' }, { title: '' }, { title: '   ' },
    { title: 'private\naddress' }, { art: '' }, { art: '../feed' }, { art: 'https://example.com/feed' }]) {
    const input = raw(); Object.assign(input.items[0], changes); invalid(input);
  }
  const input = raw(); input.items[0].art = 'archived-product';
  assert.equal(required('toExchange')(input).items[0].art, 'archived-product');
});

test('raw data rejects hidden, symbol, inherited and accessor fields without evaluating getters', () => {
  let reads = 0;
  const accessor = raw(); Object.defineProperty(accessor.items[0], 'title', { enumerable: true, get() { reads++; return 'private'; } });
  const ignoredAccessor = raw(); Object.defineProperty(ignoredAccessor.items[0], 'description', { enumerable: true, get() { reads++; return 'private'; } });
  const hidden = raw(); Object.defineProperty(hidden, 'private', { value: 'secret' });
  const symbol = raw(); symbol.items[0][Symbol('secret')] = true;
  const inherited = Object.assign(Object.create({ private: true }), raw());
  const extra = raw(); extra.items[0].customerAddress = 'private';
  for (const value of [accessor, ignoredAccessor, hidden, symbol, inherited, extra]) invalid(value);
  assert.equal(reads, 0);
});

test('sparse or decorated item arrays and throwing reflection cannot masquerade as JSON receipts', () => {
  const sparse = raw(); sparse.items = Array(2);
  const decorated = raw(); decorated.items.secret = true;
  const getterArray = raw(); let reads = 0;
  Object.defineProperty(getterArray.items, '0', { enumerable: true, get() { reads++; return raw().items[0]; } });
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('private payload'); } });
  for (const value of [sparse, decorated, getterArray, hostile]) invalid(value);
  assert.equal(reads, 0);
});

test('history exposes the newest twenty records and continues to older records in source append order', () => {
  const history = Array.from({ length: 23 }, (_, index) => raw(index + 1));
  const page = required('createExchangePage')(history, scope);
  assert.equal(page.exchangeFormat, 1);
  assert.equal(page.items.length, 20);
  assert.deepEqual(page.items.map(item => item.id), Array.from({ length: 20 }, (_, index) => exchangeId(23 - index)));
  assert.equal(page.nextCursor, exchangeId(4));
  const tail = required('createExchangePage')(history, { ...scope, cursor: page.nextCursor });
  assert.deepEqual(tail.items.map(item => item.id), [exchangeId(3), exchangeId(2), exchangeId(1)]);
  assert.equal(tail.nextCursor, null);
  assert.deepEqual(history.map(item => item.id), Array.from({ length: 23 }, (_, index) => exchangeId(index + 1)));
});

test('a newly appended checkout cannot shift an older continuation or make its records repeat', () => {
  const history = Array.from({ length: 21 }, (_, index) => raw(index + 1));
  const first = required('createExchangePage')(history, scope);
  history.push(raw(100));
  const older = required('createExchangePage')(history, { ...scope, cursor: first.nextCursor });
  assert.deepEqual(older.items.map(item => item.id), [exchangeId(1)]);
  assert.equal(required('createExchangePage')(history, scope).items[0].id, exchangeId(100));
});

test('empty, exact-page and exhausted histories have no fabricated continuation', () => {
  const createPage = required('createExchangePage');
  assert.deepEqual(createPage([], scope), { exchangeFormat: 1, ...scope, items: [], nextCursor: null });
  const exact = Array.from({ length: 20 }, (_, index) => raw(index + 1));
  assert.equal(createPage(exact, scope).nextCursor, null);
  assert.deepEqual(createPage(exact, { ...scope, cursor: exchangeId(1) }).items, []);
});

test('malformed and unknown cursors fail explicitly instead of returning the first page', () => {
  const createPage = required('createExchangePage');
  for (const cursor of [null, '', 'unknown', exchangeId(99), exchangeId(1) + '\n', 3]) {
    assert.throws(() => createPage([raw()], { ...scope, cursor }), required('ExchangeCursorError'));
  }
});

test('pages reject duplicate identities and corrupt off-page history rather than hiding inconsistent stored receipts', () => {
  assert.throws(() => required('createExchangePage')([raw(), raw()], scope), required('ExchangeValidationError'));
  const history = Array.from({ length: 22 }, (_, index) => raw(index + 1));
  history[0].total = 999;
  assert.throws(() => required('createExchangePage')(history, scope), required('ExchangeValidationError'));
});

test('scope requires a safe profile identity, known environment and nonnegative safe server time', () => {
  const createDetail = required('createExchangeDetail');
  assert.equal(createDetail(raw(), { ...scope, ownerId: 'A'.repeat(128), serverTime: Number.MAX_SAFE_INTEGER }).ownerId.length, 128);
  assert.equal(createDetail(raw(), { ...scope, ownerId: 'A._:-1', environment: 'production', serverTime: 0 }).environment, 'production');
  for (const override of [{ ownerId: '' }, { ownerId: 'bad/user' }, { ownerId: 'owner\n' },
    { ownerId: 'A'.repeat(129) }, { environment: 'test' }, { serverTime: -1 }, { serverTime: 0.5 },
    { serverTime: Number.MAX_SAFE_INTEGER + 1 }, { serverTime: Infinity }, { serverTime: undefined }]) {
    assert.throws(() => createDetail(raw(), { ...scope, ...override }), required('ExchangeValidationError'));
  }
});

test('detail is an isolated scoped receipt and does not invent times, statuses or a new issue of resources', () => {
  const input = raw();
  const detail = required('createExchangeDetail')(input, scope);
  assert.deepEqual(detail, { exchangeFormat: 1, ...scope, exchange: projected() });
  input.items[0].grant.feed = 99;
  assert.equal(detail.exchange.received.feed, 8);
});

test('wire validators accept scoped JSON outputs while rejecting another account or environment', () => {
  const isPage = required('isExchangePage'), isDetail = required('isExchangeDetail');
  assert.equal(isPage(wirePage(), OWNER, 'development'), true);
  assert.equal(isPage(wirePage({ items: [] }), OWNER, 'development'), true);
  assert.equal(isDetail(wireDetail(), OWNER, 'development'), true);
  for (const [owner, environment] of [['another', 'development'], [OWNER, 'production'], ['', 'development'], [OWNER, 'test']]) {
    assert.equal(isPage(wirePage(), owner, environment), false);
    assert.equal(isDetail(wireDetail(), owner, environment), false);
  }
});

test('wire data cannot override totals, received quantities or leak extra private raw fields', () => {
  const isDetail = required('isExchangeDetail');
  for (const mutate of [
    value => { value.exchange.received.feed = 7; },
    value => { value.exchange.received.points = 20; },
    value => { value.exchange.total = 39; },
    value => { value.exchange.receiptId = raw().receiptId; },
    value => { value.exchange.items[0].description = 'private'; },
    value => { value.exchange.items[0].linePoints = 33; },
    value => { value.private = true; },
    value => { value.exchangeFormat = 2; },
    value => { value.serverTime = -1; },
  ]) {
    const value = wireDetail(); mutate(value);
    assert.equal(isDetail(value, OWNER, 'development'), false);
  }
});

test('wire page size, uniqueness, date order and continuation identity must be consistent', () => {
  const isPage = required('isExchangePage');
  const item2 = { ...projected(), id: exchangeId(2) };
  const fullPage = Array.from({ length: 20 }, (_, index) => ({ ...projected(), id: exchangeId(20 - index) }));
  assert.equal(isPage(wirePage({ items: fullPage, nextCursor: exchangeId(1) }), OWNER, 'development'), true);
  for (const value of [
    wirePage({ items: [projected(), projected()] }),
    wirePage({ items: Array.from({ length: 21 }, (_, index) => ({ ...projected(), id: exchangeId(index + 1) })) }),
    wirePage({ items: [], nextCursor: exchangeId(1) }),
    wirePage({ nextCursor: exchangeId(2) }),
    wirePage({ nextCursor: undefined }),
    wirePage({ items: [projected(), { ...item2, day: '2026-10-28' }] }),
    wirePage({ environment: 'test' }),
  ]) assert.equal(isPage(value, OWNER, 'development'), false);
});

test('wire continuation is present only after a full page, matching the server pagination contract', () => {
  const isPage = required('isExchangePage');
  assert.equal(isPage(wirePage({ nextCursor: exchangeId(1) }), OWNER, 'development'), false);
  assert.equal(isPage(wirePage({ items: [projected(), { ...projected(), id: exchangeId(2) }],
    nextCursor: exchangeId(2) }), OWNER, 'development'), false);
});

test('wire accessors and reflection failures return false without invoking user code or leaking errors', () => {
  let reads = 0;
  const value = wireDetail();
  Object.defineProperty(value.exchange, 'received', { enumerable: true, get() { reads++; return {}; } });
  assert.equal(required('isExchangeDetail')(value, OWNER, 'development'), false);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('private'); } });
  assert.equal(required('isExchangePage')(hostile, OWNER, 'development'), false);
  assert.equal(reads, 0);
});
