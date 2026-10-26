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
      await app.click('A04');
      await app.click('为这块地选种');
    } else if (intent === 'recommendations') {
      await app.click('查看推荐');
    } else {
      await app.click('我的');
      await app.click(/^我的认养订单/);
      await app.click('去认养优选');
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
    await app.click('活动');
    await app.click(/^签到领取 /);
    assert.equal(app.state.system.signedDays.length, day + 1, 'the real sign-in transaction succeeds once each day');
  }
  app.nextDay();
  await app.click('活动');
  const cells = [...app.html.matchAll(/<div\b[^>]*\bclass="([^"]*\bcheckin-day\b[^"]*)"[^>]*>\s*<span>(\d+日)<\/span>/g)].map(match => ({ classes: match[1].split(/\s+/), label: match[2] }));
  assert.equal(cells.length, 7, 'the rendered activity page contains seven reward cells');
  assert.deepEqual(cells.filter(cell => cell.classes.includes('claimed')).map(cell => cell.label), ['1日']);
  assert.deepEqual(cells.filter(cell => cell.classes.includes('active')).map(cell => cell.label), ['2日']);
});
