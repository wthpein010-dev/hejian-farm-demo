const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Domain = require('../prototype/domain.js');
const Systems = require('../prototype/systems.js');
const file = path.join(__dirname, '../prototype/rewards.js');
let Rewards = {};
try { Rewards = require(file); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes(file)) throw error; }
const now = Date.parse('2026-10-27T04:00:00Z');
function call(name, ...args) {
  assert.equal(typeof Rewards[name], 'function', `${name} must exist`);
  return Rewards[name](...args);
}
function receipt(overrides = {}) {
  return { id: 'signin-2026-10-27', source: 'signin', title: '今日签到', reward: { points: 20 }, at: now, ...overrides };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('a fresh history accepts an activity receipt without changing the input', () => {
  const history = call('createHistory'), input = freeze(receipt());
  assert.deepEqual(history, []);
  const next = call('append', freeze(history), input);
  assert.deepEqual(next, [{ id: 'signin-2026-10-27', source: 'signin', title: '今日签到', reward: { points: 20 }, at: now }]);
  assert.deepEqual(history, []);
  assert.notEqual(next[0], input);
});

test('the same receipt id is recorded once even if its later payload differs', () => {
  const first = call('append', [], receipt());
  const again = call('append', freeze(first), receipt({ source: 'task', title: '重复传入', reward: { points: 999 } }));
  assert.deepEqual(again, first);
  assert.notEqual(again, first);
  assert.notEqual(again[0], first[0]);
  assert.notEqual(again[0].reward, first[0].reward);
  assert.equal(call('summarize', again).points, 20);
});

test('input and returned receipt mutations cannot alter a different history version', () => {
  const input = receipt({ reward: { points: 30, coupon: { title: '满60减20积分', min: 60, off: 20 } } });
  const first = call('append', [], input);
  input.reward.points = 999;
  input.reward.coupon.off = 60;
  const second = call('append', first, receipt({ id: 'task-browse', source: 'task', reward: { feed: 1 } }));
  second[0].reward.coupon.title = '已改动';
  second[0].reward.points = 888;
  second[1].title = '已改动';
  assert.deepEqual(first[0].reward, { points: 30, coupon: { title: '满60减20积分', min: 60, off: 20 } });
  assert.equal(first.length, 1);
  assert.equal(call('summarize', first).points, 30);
});

test('all four activity sources accept the existing grant shapes', () => {
  let history = call('createHistory');
  for (const source of ['signin', 'task', 'season', 'achievement']) {
    history = call('append', history, receipt({ id: source, source, reward: { points: 3, feed: 1, fertilizer: 2, tools: 3, seedPacks: 4, decorations: 5, coupon: { title: '满60减20积分', min: 60, off: 20 } } }));
  }
  assert.deepEqual(call('summarize', history), { count: 4, points: 12, feed: 4, fertilizer: 8, tools: 12, seedPacks: 16, decorations: 20, materials: 60, coupons: 4 });
});

test('summaries use the saved millisecond timestamp across the Beijing day boundary', () => {
  const before = Date.parse('2026-10-27T15:59:59.999Z'), after = before + 1;
  const history = call('append', call('append', [], receipt({ at: before })), receipt({ id: 'season-28', source: 'season', at: after, reward: { points: 30, feed: 1, coupon: { title: '满60减20积分', min: 60, off: 20 } } }));
  assert.equal(Domain.chinaDayKey(before), '2026-10-27');
  assert.equal(Domain.chinaDayKey(after), '2026-10-28');
  assert.deepEqual(call('summarize', history, '2026-10-27'), { count: 1, points: 20, feed: 0, fertilizer: 0, tools: 0, seedPacks: 0, decorations: 0, materials: 0, coupons: 0 });
  assert.deepEqual(call('summarize', history, '2026-10-28'), { count: 1, points: 30, feed: 1, fertilizer: 0, tools: 0, seedPacks: 0, decorations: 0, materials: 1, coupons: 1 });
  assert.equal(call('summarize', history, '2026-10-29').count, 0);
  assert.equal(call('summarize', history).points, 50);
});

test('an empty summary contains explicit zeros and is isolated from later calls', () => {
  const first = call('summarize', []);
  assert.deepEqual(first, { count: 0, points: 0, feed: 0, fertilizer: 0, tools: 0, seedPacks: 0, decorations: 0, materials: 0, coupons: 0 });
  first.points = 77;
  assert.equal(call('summarize', []).points, 0);
});

test('real successful activity results can be appended without changing system or wallet state', () => {
  const wallet = { points: 80, feed: 6, receipts: [], adToday: 0, inviteCount: 0, welcomeClaimed: false };
  const result = Systems.signIn(Systems.createState(now), wallet, { now, receiptId: 'activity-result' });
  assert.equal(result.ok, true);
  const before = JSON.stringify(result), history = call('append', [], receipt({ id: 'activity-result', reward: result.reward }));
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.wallet.points, 100);
  assert.deepEqual(call('summarize', history), { count: 1, points: 20, feed: 0, fertilizer: 0, tools: 0, seedPacks: 0, decorations: 0, materials: 0, coupons: 0 });
});

test('receipt source, id, title and required fields reject malformed values', () => {
  const invalid = [
    null, [], {}, receipt({ id: '' }), receipt({ id: '<script>' }), receipt({ id: 'a'.repeat(129) }),
    receipt({ source: 'ad' }), receipt({ source: 'invite' }), receipt({ source: 'welcome' }), receipt({ source: 'unknown' }),
    receipt({ title: '' }), receipt({ title: '  ' }), receipt({ title: '<b>签到</b>' }), receipt({ title: '签到\n' }), receipt({ title: 'a'.repeat(121) }),
    { id: 'missing-time', source: 'task', title: '任务奖励', reward: { points: 10 } },
  ];
  for (const input of invalid) assert.throws(() => call('append', [], input), TypeError);
});

test('reward quantities reject negatives, fractions, unsafe values and empty grants', () => {
  for (const reward of [null, [], {}, { points: 0 }, { points: -1 }, { feed: 1.5 }, { fertilizer: NaN }, { tools: Infinity }, { seedPacks: Number.MAX_SAFE_INTEGER + 1 }, { decorations: '1' }, { points: undefined }]) {
    assert.throws(() => call('append', [], receipt({ reward })), TypeError);
  }
  assert.equal(call('append', [], receipt({ reward: { points: 0, feed: 1 } }))[0].reward.points, 0);
});

test('coupons only accept their original title, minimum and discount fields', () => {
  for (const coupon of [null, [], {}, { title: '积分券', min: 60 }, { title: '积分券', min: 60, off: 0 }, { title: '积分券', min: 60, off: 61 }, { title: '', min: 60, off: 20 }, { title: '<b>积分券</b>', min: 60, off: 20 }, { title: '积分券', min: 60, off: 1.5 }, { title: '积分券', min: '60', off: 20 }, { title: '积分券', min: 60, off: 20, used: false }]) {
    assert.throws(() => call('append', [], receipt({ reward: { coupon } })), TypeError);
  }
});

test('unknown, symbolic, inherited and accessor fields cannot enter the history', () => {
  const accessor = receipt();
  Object.defineProperty(accessor, 'title', { enumerable: true, get() { throw new Error('must not execute an accessor'); } });
  const hidden = receipt();
  Object.defineProperty(hidden, 'secret', { value: 'forbidden' });
  for (const input of [receipt({ balance: 80 }), receipt({ reward: { points: 20, eggs: 1 } }), receipt({ reward: { points: 20, unknown: 1 } }), { ...receipt(), [Symbol('hidden')]: 1 }, Object.assign(Object.create({ extra: 1 }), receipt()), accessor, hidden]) {
    assert.throws(() => call('append', [], input), TypeError);
  }
});

test('invalid or missing timestamps are never replaced with a current time', () => {
  for (const at of [undefined, null, '2026-10-27', new Date(now), -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 8640000000000000 - 28800000 + 1]) {
    assert.throws(() => call('append', [], receipt({ at })), TypeError);
  }
  assert.equal(call('append', [], receipt({ at: 0 }))[0].at, 0);
  assert.equal(call('append', [], receipt({ at: 8640000000000000 - 28800000 }))[0].at, 8640000000000000 - 28800000);
});

test('a duplicate id does not bypass validation of the attempted new receipt', () => {
  const history = call('append', [], receipt());
  assert.throws(() => call('append', history, receipt({ reward: { points: -1 } })), TypeError);
  assert.deepEqual(history[0].reward, { points: 20 });
});

test('append and summary reject corrupt input histories instead of silently repairing them', () => {
  const sparse = new Array(1), extra = [receipt()]; extra.private = 'data';
  for (const history of [null, {}, sparse, extra, [receipt(), receipt()], [receipt({ source: 'ad' })], [receipt({ reward: { points: -1 } })]]) {
    assert.throws(() => call('append', history, receipt({ id: 'new-receipt' })), TypeError);
    assert.throws(() => call('summarize', history), TypeError);
  }
});

test('daily summaries reject malformed or impossible Beijing date filters', () => {
  for (const day of [null, '', 20261027, '2026-1-1', '2026-02-29', '2026-13-01', '2026-10-27T00:00:00Z', '<script>']) {
    assert.throws(() => call('summarize', [], day), TypeError);
  }
  assert.equal(call('summarize', [], '2028-02-29').count, 0);
});

test('summaries fail explicitly rather than rounding overflowing aggregate quantities', () => {
  const points = call('append', call('append', [], receipt({ reward: { points: Number.MAX_SAFE_INTEGER } })), receipt({ id: 'another', reward: { points: 1 } }));
  assert.throws(() => call('summarize', points), RangeError);
  const materials = call('append', [], receipt({ reward: { feed: Number.MAX_SAFE_INTEGER, tools: 1 } }));
  assert.throws(() => call('summarize', materials), RangeError);
});

test('the UMD browser export uses FarmDomain and requires it before loading', () => {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.notEqual(source, '', 'the browser module must exist');
  const missing = vm.createContext({});
  assert.throws(() => vm.runInContext(source, missing), /FarmDomain/);
  const context = vm.createContext({ FarmDomain: Domain });
  vm.runInContext(source, context);
  assert.equal(vm.runInContext("FarmRewards.append([], {id:'browser',source:'task',title:'任务奖励',reward:{points:10},at:1793073600000}).length", context), 1);
  assert.equal(vm.runInContext('FarmRewards.summarize([]).points', context), 0);
});
