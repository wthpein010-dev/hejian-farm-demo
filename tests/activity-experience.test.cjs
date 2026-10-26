const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

const nextAction = app => app.controls().find(c => c.dataset.guide === 'next');

test('activity next step moves from sign-in to a ready task without paying twice', async () => {
  const app = createApp();
  await app.click('商城');
  await app.click('活动');
  assert.equal(nextAction(app)?.dataset.action, 'x-signin');
  await app.click(c => c.dataset.guide === 'next');
  assert.equal(app.state.wallet.points, 100);
  assert.equal(app.state.rewardHistory.length, 1);
  assert.equal(nextAction(app)?.dataset.task, 'browse');
  await app.click(c => c.dataset.guide === 'next');
  assert.equal(app.state.wallet.points, 110);
  assert.equal(app.state.rewardHistory.length, 2);
  await app.click('我的农场');
  await app.click('活动');
  assert.equal(app.state.wallet.points, 110);
  assert.equal(app.state.rewardHistory.length, 2);
  assert.match(app.html, /最近到账/);
});

test('reward details reflect successful task and achievement claims and preserve their entry context', async () => {
  const app = createApp();
  await app.click('活动');
  await app.click('领取今日签到');
  await app.click('全部任务');
  await app.click(c => c.dataset.action === 'x-task-go' && c.dataset.task === 'harvest');
  await app.click('收取鸡蛋 · 演示');
  await app.click(c => c.dataset.action === 'x-claim-task' && c.dataset.task === 'harvest');
  await app.click('活动');
  await app.click('成长成就');
  await app.click(c => c.dataset.action === 'x-claim-achievement' && c.dataset.achievement === 'first-harvest');
  const earned = JSON.stringify({ system: app.state.system, wallet: app.state.wallet });
  await app.click(c => c.dataset.action === 'rewards');
  assert.equal(app.state.view, 'rewards');
  assert.match(app.html, /签到/);
  assert.match(app.html, /收入一份收获/);
  assert.match(app.html, /第一次丰收/);
  assert.match(app.html, /2026-10-27/);
  assert.match(app.html, /12:00/);
  assert.match(app.html, /65/);
  assert.equal(app.state.rewardHistory.length, 3);
  assert.equal(JSON.stringify({ system: app.state.system, wallet: app.state.wallet }), earned);
  await app.click('返回活动');
  assert.equal(app.state.view, 'activities');
  assert.equal(app.state.activityTab, 'growth');
  await app.click('我的');
  await app.click(c => c.dataset.action === 'rewards');
  await app.click('返回我的');
  assert.equal(app.state.view, 'mine');
  await app.back();
  assert.equal(app.state.view, 'rewards');
  assert.ok(app.controls().some(c => c.name === '返回我的'));
});

test('empty reward history is honest and daily totals do not include earlier days or ordinary welfare', async () => {
  const empty = createApp('#rewards');
  assert.match(empty.html, /还没有活动奖励记录/);
  assert.equal(empty.state.rewardHistory.length, 0);
  await empty.click('去活动中心');
  await empty.click('领取今日签到');
  empty.nextDay();
  await empty.click('活动');
  await empty.click('领取今日签到');
  await empty.click(c => c.dataset.action === 'rewards');
  assert.equal(empty.state.rewardHistory.length, 2);
  assert.match(empty.html, /今日到账/);
  assert.match(empty.html, /30/);
  assert.match(empty.html, /2026-10-28/);
  assert.match(empty.html, /2026-10-27/);
  const fresh = createApp();
  assert.equal(fresh.state.rewardHistory.length, 0, 'a new page never presents the former page history');
});

test('activity rules reuse the shared dialog and leave rewards and care state untouched', async () => {
  const app = createApp('#activities');
  const before = JSON.stringify({ system: app.state.system, wallet: app.state.wallet, care: app.state.care });
  await app.click('活动说明');
  assert.ok(app.dialogOpen);
  assert.match(app.modalHTML, /北京时间/);
  assert.match(app.modalHTML, /次数与间隔/);
  await app.click('关闭弹窗');
  assert.equal(app.state.view, 'activities');
  assert.equal(JSON.stringify({ system: app.state.system, wallet: app.state.wallet, care: app.state.care }), before);
});

test('reward detail coupon links return to the same history entry and reject untrusted return destinations', async () => {
  const app = createApp('#activities');
  await app.click('领取今日签到');
  await app.click(c => c.dataset.action === 'rewards');
  const assets = JSON.stringify({ system: app.state.system, wallet: app.state.wallet });
  await app.click('查看积分优惠券');
  await app.click('返回奖励明细');
  assert.equal(app.state.view, 'rewards');
  await app.click('返回活动');
  await app.back();
  assert.equal(app.state.view, 'rewards');
  assert.ok(app.controls().some(c => c.name === '返回活动'));
  await app.popstate('rewards', { farmNavigation: { rewardOrigin: 'javascript:bad', wallet: { points: 99999 } } });
  assert.ok(app.controls().some(c => c.name === '返回活动'));
  assert.equal(JSON.stringify({ system: app.state.system, wallet: app.state.wallet }), assets);
});

test('a coupon detour preserves the mine origin of reward details and its navigation owner', async () => {
  const app = createApp('#activities');
  await app.click('领取今日签到');
  await app.click('我的');
  await app.click(c => c.dataset.action === 'rewards');
  assert.equal(app.state.rewardOrigin, 'mine');
  await app.click('查看积分优惠券');
  await app.click('返回奖励明细');
  assert.equal(app.state.rewardOrigin, 'mine');
  assert.ok(app.controls().some(c => c.name === '返回我的'));
  assert.match(app.html, /class="nav-item active"[^>]*data-route="mine"|data-route="mine"[^>]*class="nav-item active"/);
});

test('the mature-object suggestion opens the actual crop or animal harvest card without harvesting it', async () => {
  for (const kind of ['crop','animal']) {
    const app = createApp('#activities');
    await app.click('领取今日签到');
    await app.click('商城');
    await app.click('活动');
    await app.click(c => c.dataset.guide === 'next');
    app.state.eggs = 0;
    for (const p of app.state.animals) app.state.care[p.id + ':feed'] = { usedToday: 2, lastAt: app.clock };
    for (const p of app.state.plots) app.state.care[p.id + ':water'] = { usedToday: 2, lastAt: app.clock };
    if (kind === 'animal') app.state.plots.find(p => p.id === 'A02').status = 'empty';
    app.render();
    assert.equal(nextAction(app)?.name, '查看成熟对象');
    const assets = JSON.stringify({ system: app.state.system, wallet: app.state.wallet, shipments: app.state.shipments, care: app.state.care });
    await app.click(c => c.dataset.guide === 'next');
    assert.equal(app.state.view, 'farm');
    assert.equal(app.state.tab, kind);
    assert.equal(kind === 'crop' ? app.state.selected : app.state.animal, kind === 'crop' ? 'A02' : 'G01');
    assert.ok(app.controls().some(c => c.name.includes(kind === 'crop' ? '预约采收' : '预约出栏')));
    assert.equal(JSON.stringify({ system: app.state.system, wallet: app.state.wallet, shipments: app.state.shipments, care: app.state.care }), assets);
  }
});

test('a completed harvest season records its mixed reward once and keeps the successful care cooldown', async () => {
  const app = createApp('#activities');
  await app.click('领取今日签到');
  await app.click('商城');
  await app.click('活动');
  await app.click(c => c.dataset.guide === 'next');
  await app.click('全部任务');
  await app.click(c => c.dataset.action === 'x-task-go' && c.dataset.task === 'harvest');
  await app.click('收取鸡蛋 · 演示');
  await app.click(c => c.dataset.action === 'x-claim-task' && c.dataset.task === 'harvest');
  await app.click(c => c.dataset.action === 'x-task-go' && c.dataset.task === 'care');
  await app.click(c => c.dataset.action === 'confirm-feed');
  await app.click(c => c.dataset.action === 'x-claim-task' && c.dataset.task === 'care');
  const care = JSON.stringify(app.state.care), points = app.state.wallet.points, feed = app.state.wallet.feed;
  await app.click(c => c.dataset.action === 'x-claim-season');
  assert.equal(app.state.wallet.points, points + 30);
  assert.equal(app.state.wallet.feed, feed + 1);
  const entry = app.state.rewardHistory.find(r => r.source === 'season');
  assert.equal(entry.reward.points, 30);
  assert.equal(entry.reward.feed, 1);
  assert.equal(entry.reward.coupon.off, 20);
  assert.equal(app.state.rewardHistory.length, 5);
  assert.ok(app.controls().find(c => c.dataset.action === 'x-claim-season')?.disabled);
  await app.click('活动');
  await app.click(c => c.dataset.action === 'rewards');
  assert.match(app.html, /丰收季 · 田园三章/);
  assert.match(app.html, /张积分券/);
  assert.equal(app.state.rewardHistory.length, 5);
  assert.equal(JSON.stringify(app.state.care), care);
});

test('missing reward display resources fail into the app loading recovery instead of partial activity controls', () => {
  const app = createApp('#activities', { omitScripts: ['rewards.js'], allowBootFailure: true });
  assert.equal(app.state, undefined);
  assert.match(app.bootStatus, /未能完整加载/);
  assert.match(app.html, /重新加载/);
  assert.equal(app.reloads, 0);
});
