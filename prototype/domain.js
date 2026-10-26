/* Pure in-memory demo rules. No storage, network, device, payment or platform SDK calls. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FarmDomain = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const HOUR = 3600000, DAY = 24 * HOUR, CHINA_OFFSET = 8 * HOUR;
  const SEASONS = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' };
  const MOBILE = /^1[3-9]\d{9}$/;
  const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f]/;
  const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

  function nonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  function count(value) { return nonnegative(value) && Number.isSafeInteger(value); }
  function epoch(value) { return count(value) && value <= 8640000000000000 - CHINA_OFFSET; }
  function roundMoney(value) {
    if (!nonnegative(value) || value > Number.MAX_SAFE_INTEGER / 100) throw new RangeError('示例金额超出有效范围');
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
  function getSeason(month) {
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('月份必须是1至12的整数');
    const key = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
    return { key, name: SEASONS[key] };
  }
  function chinaDayKey(now) {
    if (!epoch(now)) throw new TypeError('时间必须是有效的非负毫秒数');
    return new Date(now + CHINA_OFFSET).toISOString().slice(0, 10);
  }
  function nextChinaDay(now) { return (Math.floor((now + CHINA_OFFSET) / DAY) + 1) * DAY - CHINA_OFFSET; }
  function pair(value, label) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(nonnegative) || value[0] > value[1]) throw new TypeError(`${label}必须是有序非负数值区间`);
    return value.slice();
  }
  function rankProducts(products, month) {
    const season = getSeason(month);
    if (!Array.isArray(products)) throw new TypeError('商品必须是数组');
    const ranked = products.map((product, index) => {
      if (!product || !['crop', 'animal'].includes(product.type) || !count(product.days) || !nonnegative(product.cost)) throw new TypeError('商品类型、成熟周期或成本无效');
      if (!Array.isArray(product.seasons) || product.seasons.some(key => !Object.hasOwn(SEASONS, key))) throw new TypeError('商品适宜季节无效');
      const yieldKg = pair(product.yieldKg, '示例产量'), pricePerKg = pair(product.pricePerKg, '示例单价');
      const estimatedValue = { min: roundMoney(yieldKg[0] * pricePerKg[0]), max: roundMoney(yieldKg[1] * pricePerKg[1]) };
      // Sales value is a sample range; the score uses sample net value after cost.
      const net = estimatedValue.min / 2 + estimatedValue.max / 2 - product.cost;
      if (!Number.isFinite(net)) throw new RangeError('示例净收益超出有效范围');
      const recommended = product.seasons.includes(season.key);
      const score = (recommended ? 100 : 0) + 20 / (1 + product.days / 30) + 2.5 * (1 + net / (100 + Math.abs(net)));
      // Month-only input uses conservative 30-day buckets, not an actual harvest date.
      const harvestMonth = ((month - 1 + Math.ceil(product.days / 30)) % 12) + 1;
      return { ...product, seasons: product.seasons.slice(), yieldKg, pricePerKg, recommended, score, estimatedValue, harvestMonth,
        recommendationReason: `${recommended ? `${season.name}适宜${product.type === 'animal' ? '养殖' : '种植'}` : `非${season.name}适宜品种`} · 约${product.days}天成熟 · 产值与收益仅为演示估算`, _index: index, _net: net };
    });
    ranked.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.days - b.days || b._net - a._net || a._index - b._index);
    return ranked.map(({ _index, _net, ...product }) => product);
  }

  function careEligibility(input) {
    const value = input || {}, remaining = count(value.usedToday) ? Math.max(0, 2 - value.usedToday) : 0;
    const deny = (reason, nextAt = null) => ({ allowed: false, reason, remaining, nextAt });
    if (!['water', 'feed'].includes(value.kind) || !count(value.usedToday) || !epoch(value.now) || (value.lastAt != null && (!epoch(value.lastAt) || value.lastAt > value.now))) return deny('照料数据无效，请重新查看');
    if (value.kind === 'water') {
      if (value.growing !== true) return deny('仅生长中的作物可以浇水');
      if (!nonnegative(value.moisture) || value.moisture > 100) return deny('土壤湿度数据无效，请先查看状态');
      if (value.moisture >= 65) return deny('土壤湿度已充足，暂不需要浇水');
    } else if (!count(value.inventory) || value.inventory <= 0) return deny('饲料不足，先领取或补充饲料');
    if (value.usedToday >= 2) return deny('今天已照料2次，明天再来', nextChinaDay(value.now));
    const nextAt = value.lastAt == null ? null : value.lastAt + (value.kind === 'water' ? 6 : 4) * HOUR;
    if (nextAt != null && value.now < nextAt) return deny(value.kind === 'water' ? '距离上次浇水不足6小时' : '距离上次投喂不足4小时', nextAt);
    return { allowed: true, reason: value.kind === 'water' ? '可以浇水' : '可以投喂', remaining, nextAt: null };
  }

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function safeText(value, min, max) {
    return typeof value === 'string' && value.length <= max && !UNSAFE_TEXT.test(value) && Array.from(value.trim()).length >= min;
  }
  function validateShipping(input) {
    const value = input || {}, errors = {};
    if (!['delivery', 'pickup'].includes(value.method)) errors.method = '请选择配送或到农场自提';
    if (!safeText(value.name, 2, 30)) errors.name = '请填写2至30字的收件姓名，不含HTML或控制字符';
    if (typeof value.phone !== 'string' || value.phone.length > 20 || !MOBILE.test(value.phone.trim())) errors.phone = '请填写有效的11位大陆手机号码';
    if (value.method === 'delivery' && !safeText(value.address, 5, 160)) errors.address = '请填写5至160字的完整配送地址，不含HTML或控制字符';
    if (value.email != null && value.email !== '' && (typeof value.email !== 'string' || value.email.length > 120 || UNSAFE_TEXT.test(value.email) || !EMAIL.test(value.email.trim()))) errors.email = '邮箱选填；请填写120字以内的有效邮箱';
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function maskShipping(input) {
    const value = input || {}, name = safeText(value.name, 2, 30) ? Array.from(value.name.trim())[0] + '**' : '姓名已隐藏';
    const phone = typeof value.phone === 'string' && MOBILE.test(value.phone.trim()) ? value.phone.trim().slice(0, 3) + '****' + value.phone.trim().slice(-4) : '号码已隐藏';
    return { name, phone, address: value.method === 'pickup' ? '到农场自提' : '详细地址已隐藏', email: text(value.email) ? '邮箱已隐藏' : '未填写邮箱' };
  }

  function copyWallet(wallet) {
    if (!wallet || !['points','feed','adToday','inviteCount'].every(key => count(wallet[key])) || typeof wallet.welcomeClaimed !== 'boolean' || !Array.isArray(wallet.receipts) || wallet.receipts.some(id => typeof id !== 'string' || !RECEIPT.test(id)) || new Set(wallet.receipts).size !== wallet.receipts.length) throw new TypeError('福利账户数据无效，不能重置或发放奖励');
    return { points: wallet.points, feed: wallet.feed, receipts: wallet.receipts.slice(), adToday: wallet.adToday, inviteCount: wallet.inviteCount, welcomeClaimed: wallet.welcomeClaimed };
  }
  function grantReward(wallet, request) {
    const result = copyWallet(wallet), value = request || {};
    const deny = reason => ({ granted: false, reason, wallet: result });
    if (!['ad','invite','welcome'].includes(value.kind)) return deny('未知的福利类型');
    if (typeof value.receiptId !== 'string' || !RECEIPT.test(value.receiptId)) return deny('福利回执无效，请重新体验');
    if (result.receipts.includes(value.receiptId)) return deny('这份福利已经领取过');
    if (value.kind === 'ad' && value.completed !== true) return deny('完整体验后才可领取福利');
    if (value.kind === 'ad' && result.adToday >= 3) return deny('今天已领取3次体验福利，明天再来');
    if (value.kind === 'invite' && value.qualified !== true) return deny('好友完成有效体验后才可领取福利');
    if (value.kind === 'welcome' && result.welcomeClaimed) return deny('新人福利只能领取一次');
    const points = value.kind === 'ad' ? 20 : value.kind === 'invite' ? 50 : 30, feed = value.kind === 'ad' ? 1 : 2;
    if (!count(result.points + points) || !count(result.feed + feed) || (value.kind === 'invite' && !count(result.inviteCount + 1))) return deny('福利数值超出有效范围，本次未发放');
    result.points += points;result.feed += feed;result.receipts.push(value.receiptId);
    if (value.kind === 'ad') result.adToday += 1;
    if (value.kind === 'invite') result.inviteCount += 1;
    if (value.kind === 'welcome') result.welcomeClaimed = true;
    return { granted: true, reason: `已领取${points}积分和${feed}份饲料（演示）`, wallet: result };
  }
  return Object.freeze({ getSeason, rankProducts, careEligibility, chinaDayKey, validateShipping, maskShipping, grantReward });
});
