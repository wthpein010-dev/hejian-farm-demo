/* Page-memory activity display only. This history does not grant, restore or persist assets. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./domain.js'));
  else root.FarmRewards = factory(root.FarmDomain);
})(typeof window !== 'undefined' ? window : globalThis, function (Domain) {
  'use strict';
  if (!Domain || typeof Domain.chinaDayKey !== 'function') throw new Error('FarmRewards需要先加载FarmDomain');
  const SOURCES = ['signin', 'task', 'season', 'achievement'];
  const QUANTITIES = ['points', 'feed', 'fertilizer', 'tools', 'seedPacks', 'decorations'];
  const ENTRY_KEYS = ['id', 'source', 'title', 'reward', 'at'];
  const IDS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f]/;
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

  function fields(value, allowed, required, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(label + '格式无效');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.getOwnPropertyDescriptor(value, key).enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) || required.some(key => !Object.hasOwn(value, key))) throw new TypeError(label + '字段无效');
    return keys;
  }
  function validTitle(value) {
    return typeof value === 'string' && value.length <= 120 && value.trim().length > 0 && !UNSAFE_TEXT.test(value);
  }
  function copyReward(reward) {
    const keys = fields(reward, [...QUANTITIES, 'coupon'], [], '奖励');
    const copy = {};
    for (const key of keys) {
      if (key === 'coupon') {
        const coupon = reward.coupon;
        fields(coupon, ['title', 'min', 'off'], ['title', 'min', 'off'], '积分券');
        if (!validTitle(coupon.title) || !count(coupon.min) || !count(coupon.off) || coupon.off === 0 || coupon.off > coupon.min) throw new TypeError('积分券内容无效');
        copy.coupon = { title: coupon.title, min: coupon.min, off: coupon.off };
      } else {
        if (!count(reward[key])) throw new TypeError('奖励数量必须为非负安全整数');
        copy[key] = reward[key];
      }
    }
    if (!copy.coupon && !QUANTITIES.some(key => copy[key] > 0)) throw new TypeError('奖励内容不能为空');
    return copy;
  }
  function copyEntry(entry) {
    fields(entry, ENTRY_KEYS, ENTRY_KEYS, '奖励明细');
    if (typeof entry.id !== 'string' || !IDS.test(entry.id) || !SOURCES.includes(entry.source) || !validTitle(entry.title)) throw new TypeError('奖励来源、编号或标题无效');
    // Domain validates both safe-integer milliseconds and the representable Beijing offset.
    Domain.chinaDayKey(entry.at);
    return { id: entry.id, source: entry.source, title: entry.title, reward: copyReward(entry.reward), at: entry.at };
  }
  function copyHistory(history) {
    if (!Array.isArray(history) || Reflect.ownKeys(history).length !== history.length + 1) throw new TypeError('奖励明细列表无效');
    const ids = new Set(), copy = [];
    for (let index = 0; index < history.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(history, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('奖励明细列表无效');
      const entry = copyEntry(descriptor.value);
      if (ids.has(entry.id)) throw new TypeError('奖励明细编号不能重复');
      ids.add(entry.id); copy.push(entry);
    }
    return copy;
  }
  function createHistory() { return []; }
  function append(history, entry) {
    const copy = copyHistory(history), next = copyEntry(entry);
    if (!copy.some(item => item.id === next.id)) copy.push(next);
    return copy;
  }
  function validDay(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const time = Date.parse(day + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
  }
  function add(left, right) {
    const total = left + right;
    if (!count(total)) throw new RangeError('奖励汇总数量超出安全整数范围');
    return total;
  }
  function summarize(history, dayKey) {
    const copy = copyHistory(history);
    if (dayKey !== undefined && !validDay(dayKey)) throw new TypeError('北京时间日期无效');
    const totals = { count: 0, points: 0, feed: 0, fertilizer: 0, tools: 0, seedPacks: 0, decorations: 0, materials: 0, coupons: 0 };
    for (const entry of copy) {
      if (dayKey !== undefined && Domain.chinaDayKey(entry.at) !== dayKey) continue;
      totals.count++;
      for (const key of QUANTITIES) {
        const quantity = entry.reward[key] || 0;
        totals[key] = add(totals[key], quantity);
        if (key !== 'points') totals.materials = add(totals.materials, quantity);
      }
      if (entry.reward.coupon) totals.coupons++;
    }
    return totals;
  }
  return Object.freeze({ createHistory, append, summarize });
});
