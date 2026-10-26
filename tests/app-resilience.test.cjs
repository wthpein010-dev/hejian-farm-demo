const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

test('unavailable care actions explain resources, cooldown and quota without claiming success', async () => {
  const app = createApp();
  await app.click('我的牧场');
  app.state.wallet.feed = 0; app.render();
  assert.ok(app.controls().some(c => c.name === '饲料不足' && c.disabled));
  assert.ok(!app.controls().some(c => c.name === '已投喂'));
  app.state.wallet.feed = 6;
  app.state.care['P01:feed'] = { usedToday: 1, lastAt: app.clock };
  app.render();
  assert.ok(app.controls().some(c => c.name === '等待间隔' && c.disabled));
  assert.match(app.html, /下次可用/);
  app.state.care['P01:feed'] = { usedToday: 2, lastAt: app.clock - 5 * 3600000 };
  app.render();
  assert.ok(app.controls().some(c => c.name === '今日已完成' && c.disabled));
  await app.click('我的菜园');
  app.state.plots[0].moisture = 70; app.render();
  assert.ok(app.controls().some(c => c.name === '湿度充足' && c.disabled));
  assert.equal(app.state.wallet.feed, 6);
  assert.equal(app.state.plots[0].moisture, 70);
});

async function startOneMinuteWater(app) {
  await app.click('浇水');
  await app.click('1 分钟');
  await app.click('确认灌溉 · 模拟设备');
  app.advance(700); app.flushTimeout(700);
  app.advance(1500); app.flushTimeout(1500);
  assert.equal(app.state.device.status, 'running');
}

function fillShipping(app, { invalid = false } = {}) {
  app.fill('name', '示例人员');
  app.fill('phone', '13800000000');
  app.fill('address', '浙江省杭州市示例路88号');
  app.fill('email', invalid ? 'invalid-email' : 'demo@example.com');
}

test('the original wallet and farm quotas never reset when the clock returns to an older day', () => {
  const app = createApp();
  app.nextDay(); app.render();
  app.state.wallet.adToday = 3;
  app.state.requests.add('A01:fertilize');
  app.state.care['A01:water'] = { usedToday: 2, lastAt: app.clock - 7 * 3600000 };
  app.advance(-86400000); app.render();
  assert.equal(app.state.day, '2026-10-28');
  assert.equal(app.state.wallet.adToday, 3);
  assert.equal(app.state.requests.has('A01:fertilize'), true);
  assert.equal(app.state.care['A01:water'].usedToday, 2);
});

test('a delayed watering timer uses elapsed time and waits for a stop ACK before updating moisture', async () => {
  const app = createApp();
  await startOneMinuteWater(app);
  const moisture = app.state.plots[0].moisture;
  app.advance(90000); app.tickIntervals();
  assert.equal(app.state.device.remaining, 0);
  assert.equal(app.state.device.status, 'stopping');
  assert.equal(app.state.plots[0].moisture, moisture);
  app.flushTimeout(1100);
  assert.equal(app.state.device.status, 'idle');
  assert.equal(app.state.plots[0].moisture, moisture + 8);
});

test('restoring a suspended active device requires reconciliation and retains its care cooldown', async () => {
  const app = createApp();
  await startOneMinuteWater(app);
  const moisture = app.state.plots[0].moisture;
  const lastAt = app.state.care['A01:water'].lastAt;
  await app.hide(); app.advance(90000); await app.resume();
  assert.equal(app.state.device.status, 'uncertain');
  assert.equal(app.state.plots[0].moisture, moisture);
  assert.equal(app.state.care['A01:water'].lastAt, lastAt);
  app.tickIntervals();
  assert.equal(app.state.device.status, 'uncertain');
  await app.click('模拟核查：确认阀门关闭');
  assert.equal(app.state.device.status, 'idle');
  await app.click('选择地块浇水');
  assert.ok(app.controls().some(c => c.name === '当前暂不可浇水' && c.disabled));
});

test('a late adoption result does not replace a newer product dialog', async () => {
  const app = createApp('#shop');
  await app.click('推荐 · 选择樱桃萝卜');
  await app.click('确认认养 · 演示下单');
  await app.click('关闭弹窗');
  await app.click('推荐 · 选择上海青');
  app.flushTimeout(500);
  assert.equal(app.state.orders[0].product, 'radish');
  assert.equal(app.modal.type, 'buy');
  assert.equal(app.modal.id, 'greens');
  assert.match(app.modalHTML, /上海青/);
});

test('a completed previous crop shipment does not block a new cultivation cycle on the same plot', async () => {
  const app = createApp();
  await app.click('去采收'); fillShipping(app); await app.submit();
  await app.click('查看收获与配送');
  for (let i = 0; i < 3; i++) await app.click('模拟下一步履约');
  await app.click('我的农场'); await app.click('A02'); await app.click('为这块地选种');
  await app.click('推荐 · 选择樱桃萝卜'); await app.click('确认认养 · 演示下单');
  app.flushTimeout(500); await app.click('查看认养订单');
  await app.click('模拟工作人员完成播种');
  await app.click('我的农场');
  assert.doesNotMatch(app.html, /<h3>A02 空闲地块<\/h3>/, 'a planted second cycle is not described as an empty plot');
  const current = app.state.plots.find(p => p.id === 'A02');
  current.status = 'ready'; current.days = current.total;
  await app.click('我的农场'); await app.click('A02');
  assert.ok(app.controls().some(c => c.dataset.action === 'harvest' && c.dataset.id === 'A02'), 'a second cycle has its own harvest action');
  await app.click('预约采收 · 收获到家'); fillShipping(app); await app.submit();
  assert.equal(app.state.shipments.length, 2);
  assert.notEqual(app.state.shipments[0].cycleId, app.state.shipments[1].cycleId);
});

test('closing a shipping dialog clears its raw draft and hidden form DOM', async () => {
  const app = createApp();
  await app.click('去采收'); fillShipping(app, { invalid: true }); await app.submit();
  assert.match(app.modalHTML, /13800000000/);
  const field = app.fill('phone', '13800000000');
  await app.click('关闭弹窗');
  assert.equal(app.dialogOpen, false);
  assert.equal(app.modal, null);
  assert.equal(app.modalHTML, '');
  assert.equal(field.value, '');
});

test('switching pickup and delivery preserves the in-memory shipping address until cancel', async () => {
  const app = createApp();
  await app.click('去采收'); fillShipping(app);
  await app.click('农场自提'); await app.click('配送到家');
  assert.match(app.modalHTML, /浙江省杭州市示例路88号/);
  await app.click('关闭弹窗');
  await app.click('去采收');
  assert.doesNotMatch(app.modalHTML, /13800000000|浙江省杭州市示例路88号/);
});

test('a missing application script leaves a readable startup failure with a retry action', () => {
  const app = createApp('', { omitScripts: ['systems.js'], allowBootFailure: true });
  assert.match(app.html, /重新加载|重新打开/);
  assert.match(app.bootStatus, /未能|失败|检查网络/);
  assert.equal(app.state, undefined);
});
