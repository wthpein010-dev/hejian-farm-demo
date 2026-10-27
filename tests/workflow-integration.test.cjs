const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');
const W = require('../prototype/workflow.js');
const action = (app, name, id, worker) => app.click(c => c.dataset.action === name && (!id || c.dataset.order === id) && (!worker || c.dataset.worker === worker));
async function order() {
  const app = createApp('#shop');
  await app.click('选择樱桃萝卜');
  await app.click('确认认养 · 演示下单');
  app.flushTimeout(500);
  await app.click('查看认养订单');
  return app;
}
async function working(app) {
  const id = app.state.orders[0].id;
  await app.click('我的'); await app.click(/农场工作台/);
  await action(app, 'w-accept', id);
  await action(app, 'w-assign', id, 'team-1');
  await action(app, 'w-next-day');
  await action(app, 'w-start', id);
  return id;
}
test('customers create a specific crop/plot order and cannot directly complete staff work', async () => {
  const app = await order(), o = app.state.orders[0];
  assert.equal(o.product, 'radish'); assert.equal(o.target, 'A04');
  assert.equal(o.work.plannedDay, '2026-10-28');
  assert.equal(o.work.status, 'pending');
  assert.equal(app.state.plots.find(p => p.id === 'A04').status, 'pending');
  assert.equal(app.controls().some(c => c.dataset.action === 'fulfill-order' || c.dataset.action?.startsWith('w-accept')), false);
});
test('staff must accept, assign and reach T+1 before work, then confirmation commits planting once', async () => {
  const app = await order(), id = app.state.orders[0].id;
  await app.click('我的'); await app.click(/农场工作台/);
  await action(app, 'w-accept', id); await action(app, 'w-assign', id, 'team-1');
  const start = app.controls().find(c => c.dataset.action === 'w-start');
  assert.ok(start?.disabled, 'same-day work is unavailable');
  const day = app.state.day, clock = app.clock, wallet = JSON.stringify(app.state.wallet);
  await action(app, 'w-next-day');
  assert.equal(app.state.day, day); assert.equal(app.clock, clock); assert.equal(JSON.stringify(app.state.wallet), wallet);
  await action(app, 'w-start', id); await action(app, 'w-complete', id);
  await app.click('关闭弹窗');
  assert.equal(app.state.orders[0].work.status, 'working', 'cancel is not completion');
  await action(app, 'w-complete', id); await action(app, 'w-confirm-complete', id);
  const o = app.state.orders[0], p = app.state.plots.find(p => p.id === 'A04');
  assert.equal(o.status, 'active'); assert.equal(o.work.status, 'completed');
  assert.equal(p.status, 'growing'); assert.equal(p.cycleId, o.cycleId);
  const before = JSON.stringify(app.state);
  assert.equal(app.completeWork(o), false, 'repeated completion is rejected by the actual owner');
  assert.equal(JSON.stringify(app.state), before);
});
test('a stale staff completion cannot overwrite a replacement planting cycle', async () => {
  const app = await order(); await working(app);
  const current = app.state.orders[0], next = W.apply(current, 'complete', { day: '2026-10-28' }).order;
  const plot = app.state.plots.find(p => p.id === current.target);
  plot.cycleId = 'replacement-cycle';
  const before = JSON.stringify(app.state);
  assert.equal(app.completeWork(next), false);
  assert.equal(JSON.stringify(app.state), before);
});
