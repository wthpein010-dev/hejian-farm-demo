const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

test('adoption entry points override a previous supplies tab while ordinary shop navigation remembers it', async () => {
  for (const intent of ['empty-plot', 'recommendations', 'empty-orders']) {
    const app = createApp();
    await app.click('商城');
    await app.click('农场物资');
    await app.click('我的农场');
    await app.click('商城');
    assert.equal(app.state.storefront, 'supplies', 'ordinary bottom navigation keeps the last shop section');
    await app.click('我的农场');
    if (intent === 'empty-plot') {
      await app.click('地块4');
      await app.click('为这块地选种');
    } else if (intent === 'recommendations') {
      await app.click('查看推荐');
    } else {
      await app.click('我的');
      await app.click(/^我的认养订单/);
      await app.click('选择认养品种');
    }
    assert.equal(app.state.storefront, 'adopt', `${intent} must lead to adoption`);
    assert.ok(app.controls().some(control => control.name.includes('选择樱桃萝卜')), `${intent} renders the actual seed choices`);
  }
});

test('initial shop URLs, normal navigation and history restoration each count one daily shop visit', async () => {
  const observations = [];
  for (const entry of ['initial-url', 'navigation', 'popstate']) {
    const app = createApp(entry === 'initial-url' ? '#shop' : '');
    if (entry === 'navigation') await app.click('商城');
    if (entry === 'popstate') await app.popstate('shop');
    const onEntry = app.state.system.daily.browse;
    await app.click('我的农场');
    await app.click('商城');
    await app.click('农场物资');
    await app.click('积分好礼');
    await app.click('当季认养');
    await app.popstate('shop');
    observations.push({ entry, onEntry, afterRepeats: app.state.system.daily.browse, xp: app.state.system.xp });
  }
  assert.deepEqual(observations, [
    { entry: 'initial-url', onEntry: 1, afterRepeats: 1, xp: 128 },
    { entry: 'navigation', onEntry: 1, afterRepeats: 1, xp: 128 },
    { entry: 'popstate', onEntry: 1, afterRepeats: 1, xp: 128 },
  ]);
});

test('after eight real sign-ins the ninth-day activity grid shows one claimed cell and the second reward active', async () => {
  const app = createApp();
  for (let day = 0; day < 8; day++) {
    if (day) app.nextDay();
    await app.click('打开活动中心');
    await app.click(/^签到领取 /);
    assert.equal(app.state.system.signedDays.length, day + 1, 'the real sign-in transaction succeeds once each day');
  }
  app.nextDay();
  await app.click('打开活动中心');
  const cells = app.controls().filter(control => control.dataset.action === 'x-signin-preview');
  assert.equal(cells.length, 7, 'the rendered activity page contains seven reward cells');
  assert.deepEqual(cells.filter(cell => cell.name.includes('已领取')).map(cell => cell.dataset.day), ['1']);
  assert.deepEqual(cells.filter(cell => cell.name.includes('今日可签到')).map(cell => cell.dataset.day), ['2']);
});

test('the shop cart summary stays reachable outside the scrolling catalogue and follows current quantities', async () => {
  const app = createApp();
  await app.click('商城');
  await app.click('农场物资');
  assert.doesNotMatch(app.html, /<aside\b[^>]*class="commerce-dock"/);
  await app.click('加入日常饲料包到购物车');
  await app.click('加入日常饲料包到购物车');
  const dock = app.html.match(/<aside\b[^>]*class="commerce-dock"[^>]*>([\s\S]*?)<\/aside>/);
  assert.ok(dock, 'a selected cart remains reachable while the catalogue scrolls');
  assert.match(dock[1], /已选\s*2\s*件/);
  assert.match(dock[1], /60\s*积分/);
  assert.match(dock[1], /80\s*积分/);
  assert.match(app.html, /<\/div><aside\b[^>]*class="commerce-dock"[\s\S]*<\/aside><nav\b/);
  await app.click(el => el.dataset.action === 'cart' && el.name === '查看购物车');
  assert.equal(app.state.view, 'cart');
  assert.doesNotMatch(app.html, /<aside\b[^>]*class="commerce-dock"/);
  await app.click('返回商城');
  await app.click('当季认养');
  assert.doesNotMatch(app.html, /<aside\b[^>]*class="commerce-dock"/);
  await app.click('农场物资');
  assert.match(app.html, /<aside\b[^>]*class="commerce-dock"/);
  await app.click('我的');
  assert.doesNotMatch(app.html, /<aside\b[^>]*class="commerce-dock"/);
});

test('activity overview exposes current rewards and reaches canonical tasks and welfare screens', async () => {
  const app = createApp();
  await app.click('商城');
  await app.click('打开活动中心');
  const overview = app.html.match(/<section\b[^>]*class="activity-overview"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(overview, 'the first activity section exposes actionable reward status');
  assert.match(overview[1], /1\s*项可领/);
  assert.match(overview[1], /0\s*\/\s*3\s*枚印章/);
  const before = app.state.wallet.points;
  await app.click('领取今日签到');
  assert.equal(app.state.wallet.points, before + 20);
  const claimed = app.controls().find(el => el.name === '今日签到已领取');
  assert.ok(claimed?.disabled, 'the overview cannot repeat a claimed sign-in');
  await app.click(el => el.dataset.action === 'tasks' && el.name.includes('1 项可领'));
  assert.equal(app.state.view, 'tasks');
  await app.click('打开活动中心');
  await app.click('新人和好友福利');
  assert.equal(app.state.view, 'welfare');
  assert.ok(app.controls().some(el => el.dataset.action === 'welcome'), 'the original reward flow is reused');
});

test('coupons return to their actual entry context without changing assets', async () => {
  for (const source of ['mine', 'shop', 'cart']) {
    const app = createApp();
    if (source === 'mine') await app.click('我的');
    else {
      await app.click('商城');
      await app.click('农场物资');
      if (source === 'cart') {
        await app.click('加入日常饲料包到购物车');
        await app.click(el => el.dataset.action === 'cart');
      }
    }
    const assets = JSON.stringify({ wallet: app.state.wallet, system: app.state.system });
    await app.click(el => el.dataset.action === 'coupons');
    assert.equal(app.state.view, 'coupons');
    const owner = source === 'mine' ? 'mine' : 'shop';
    assert.match(app.html, new RegExp(`data-route="${owner}"[^>]*aria-current="page"`));
    await app.click(/^返回/);
    assert.equal(app.state.view, source, 'back returns to the screen that opened the coupons');
    assert.equal(JSON.stringify({ wallet: app.state.wallet, system: app.state.system }), assets);
  }
  const direct = createApp('#coupons');
  await direct.click('返回我的');
  assert.equal(direct.state.view, 'mine', 'a direct coupon URL has a safe fallback');
});

test('exchange history starts empty and preserves the shop or warehouse return path', async () => {
  const app = createApp();
  await app.click('商城');
  await app.click(el => el.dataset.action === 'exchanges');
  assert.equal(app.state.view, 'exchanges');
  assert.match(app.html, /还没有积分兑换记录/);
  assert.ok(app.controls().some(el => el.name === '逛逛农场物资'));
  await app.click('返回商城');
  assert.equal(app.state.view, 'shop');
  await app.click('我的农场');
  await app.click('我的仓库');
  await app.click('全部记录');
  assert.equal(app.state.view, 'exchanges');
  await app.click('返回仓库');
  assert.equal(app.state.view, 'warehouse');
});

test('exchange history shows every real purchase with its saved day, quantity and coupon totals', async () => {
  const app = createApp();
  app.state.wallet.points = 1000; // Fund a multi-purchase fixture; every record is still a real checkout below.
  for (let index = 0; index < 5; index++) {
    if (index) app.nextDay();
    await app.click('商城');
    await app.click('农场物资');
    await app.click('加入日常饲料包到购物车');
    if (!index) await app.click('加入日常饲料包到购物车');
    await app.click(el => el.dataset.action === 'cart');
    if (!index) await app.click(el => el.dataset.action === 'x-coupon' && el.dataset.coupon === 'welcome-20');
    await app.click(/^确认结算/);
    await app.click('确认兑换');
    await app.click('继续逛商城');
  }
  assert.equal(app.state.system.purchases.length, 5);
  assert.equal(app.state.wallet.points, 840);
  assert.equal(app.state.wallet.feed, 24);
  const assets = JSON.stringify({ wallet: app.state.wallet, system: app.state.system });
  await app.click(el => el.dataset.action === 'exchanges');
  const records = [...app.html.matchAll(/<article\b[^>]*class="exchange-card"[^>]*>([\s\S]*?)<\/article>/g)].map(match => match[1]);
  assert.equal(records.length, 5, 'history is not truncated to the four warehouse previews');
  assert.match(records.at(-1), /2026-10-27/);
  assert.match(records.at(-1), /日常饲料包\s*×\s*2/);
  assert.match(records.at(-1), /商品积分[\s\S]*?60\s*积分/);
  assert.match(records.at(-1), /优惠抵扣[\s\S]*?20\s*积分/);
  assert.match(records.at(-1), /实付积分[\s\S]*?40\s*积分/);
  assert.match(records[0], /2026-10-31/);
  assert.doesNotMatch(records.join(''), /\d{1,2}:\d{2}/, 'saved records contain a day, not an invented time');
  assert.equal(JSON.stringify({ wallet: app.state.wallet, system: app.state.system }), assets, 'viewing history never replays a transaction');
});

test('browser back restores the coupon cart entry instead of adopting the page being left', async () => {
  const app = createApp();
  await app.click('商城');
  await app.click('农场物资');
  await app.click('加入日常饲料包到购物车');
  await app.click(el => el.dataset.action === 'cart');
  await app.click(el => el.dataset.action === 'coupons');
  const assets = JSON.stringify({ wallet: app.state.wallet, system: app.state.system });
  await app.click('去使用');
  assert.equal(app.state.view, 'shop');
  await app.back();
  assert.equal(app.state.view, 'coupons');
  assert.ok(app.controls().some(el => el.name === '返回购物车'));
  await app.click('返回购物车');
  assert.equal(app.state.view, 'cart');
  assert.equal(JSON.stringify({ wallet: app.state.wallet, system: app.state.system }), assets);
});

test('separate coupon history entries keep their own mine and shop return contexts in both directions', async () => {
  const app = createApp();
  await app.click('我的');
  await app.click(el => el.dataset.action === 'coupons'); // First coupon entry belongs to mine.
  await app.click('商城');
  await app.click(el => el.dataset.action === 'coupons'); // Second coupon entry belongs to shop.
  await app.click('打开活动中心');
  await app.back();
  assert.equal(app.state.view, 'coupons');
  assert.ok(app.controls().some(el => el.name === '返回商城'));
  assert.match(app.html, /data-route="shop"[^>]*aria-current="page"/);
  await app.back();
  assert.equal(app.state.view, 'shop');
  await app.back();
  assert.equal(app.state.view, 'coupons');
  assert.ok(app.controls().some(el => el.name === '返回我的'));
  assert.match(app.html, /data-route="mine"[^>]*aria-current="page"/);
  await app.forward();
  await app.forward();
  assert.equal(app.state.view, 'coupons');
  assert.ok(app.controls().some(el => el.name === '返回商城'));
  assert.match(app.html, /data-route="shop"[^>]*aria-current="page"/);
});

test('separate exchange history entries restore warehouse and shop return contexts without mutating assets', async () => {
  const app = createApp('#farm');
  await app.click('我的仓库');
  await app.click('全部记录'); // First exchange entry belongs to the warehouse.
  await app.click('商城');
  await app.click(el => el.dataset.action === 'exchanges'); // Second entry belongs to the shop.
  const assets = JSON.stringify({ wallet: app.state.wallet, system: app.state.system });
  await app.click('打开活动中心');
  await app.back();
  assert.equal(app.state.view, 'exchanges');
  assert.ok(app.controls().some(el => el.name === '返回商城'));
  await app.back();
  await app.back();
  assert.equal(app.state.view, 'exchanges');
  assert.ok(app.controls().some(el => el.name === '返回仓库'));
  await app.forward();
  await app.forward();
  assert.equal(app.state.view, 'exchanges');
  assert.ok(app.controls().some(el => el.name === '返回商城'));
  assert.equal(JSON.stringify({ wallet: app.state.wallet, system: app.state.system }), assets);
});

test('direct and unknown-state exchange URLs use a safe shop return without trusting unrelated history fields', async () => {
  const app = createApp('#exchanges');
  assert.ok(app.controls().some(el => el.name === '返回商城'));
  await app.popstate('coupons', { farmNavigation: { couponOrigin: 'live', exchangeOrigin: 'javascript:bad', wallet: { points: 99999 } } });
  assert.ok(app.controls().some(el => el.name === '返回我的'));
  assert.equal(app.state.wallet.points, 80);
  await app.popstate('exchanges');
  assert.ok(app.controls().some(el => el.name === '返回商城'));
  assert.equal(app.state.wallet.points, 80);
});
