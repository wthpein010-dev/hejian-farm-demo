const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

test('profile sign-in uses the existing wallet, receipt history and daily eligibility', async () => {
  const app = createApp('#mine');
  assert.match(app.html, /示例身份/);
  assert.match(app.html, /本页数据.*刷新重置/);
  assert.match(app.html, /每日签到/);
  const before = app.state.wallet.points;
  await app.click(c => c.dataset.action === 'x-signin');
  assert.equal(app.state.wallet.points, before + 20);
  assert.equal(app.state.rewardHistory.length, 1);
  assert.equal(app.state.view, 'mine');
  const claimed = app.controls().find(c => c.dataset.action === 'x-signin');
  assert.ok(claimed.disabled);
  assert.match(claimed.name, /✓ 已领取/);
  await app.click(c => c.dataset.action === 'x-signin-calendar');
  assert.equal(app.state.view, 'activities');
  assert.equal(app.state.wallet.points, before + 20);
  assert.equal(app.state.rewardHistory.length, 1);
  assert.ok(app.controls().filter(c => c.dataset.action === 'x-signin').every(c => c.disabled));
  await app.click('我的');
  await app.click(c => c.dataset.action === 'rewards');
  assert.equal(app.state.rewardOrigin, 'mine');
  assert.match(app.html, /七日田园签到/);
});

test('profile retains every existing service and its seven-day entry never pays a reward', async () => {
  const app = createApp('#mine');
  const actions = new Set(app.controls().map(c => c.dataset.action));
  for (const action of ['orders', 'deliveries', 'activities', 'share', 'device', 'records', 'warehouse', 'coupons', 'album', 'messages', 'rewards', 'guide', 'achievements', 'platform']) {
    assert.ok(actions.has(action), `profile retains ${action}`);
  }
  const before = JSON.stringify({ system: app.state.system, wallet: app.state.wallet, care: app.state.care, device: app.state.device });
  await app.click(c => c.dataset.action === 'x-signin-calendar');
  assert.equal(app.state.view, 'activities');
  assert.equal(JSON.stringify({ system: app.state.system, wallet: app.state.wallet, care: app.state.care, device: app.state.device }), before);
});
