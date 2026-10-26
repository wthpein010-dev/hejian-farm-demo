const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

const card = (html, sku) => [...html.matchAll(/<article\b[^>]*class="goods-card"[^>]*>([\s\S]*?)<\/article>/g)].map(match => match[1]).find(content => content.includes(`data-sku="${sku}"`));
const productOrder = html => [...html.matchAll(/<article\b[^>]*class="goods-card"[^>]*>[\s\S]*?data-sku="([^"]+)"/g)].map(match => match[1]);
const assertQuantities = (content, remaining, inCart, canAdd) => {
  const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, new RegExp(`今日剩余\\s*${remaining}\\s*件`));
  assert.match(text, new RegExp(`车中\\s*${inCart}\\s*件`));
  assert.match(text, new RegExp(`还可加\\s*${canAdd}\\s*件`));
};
const assets = app => JSON.stringify({ system: app.state.system, wallet: app.state.wallet });

test('a full cart disables the same product in its list and detail and recovers after removing one', async () => {
  const app = createApp('#shop');
  await app.click('农场物资');
  for (let count = 0; count < 5; count++) await app.click('加入日常饲料包到购物车');
  assertQuantities(card(app.html, 'feed-pack'), 5, 5, 0);
  assert.ok(app.controls().find(control => control.dataset.action === 'x-add-cart' && control.dataset.sku === 'feed-pack')?.disabled);
  assert.match(card(app.html, 'feed-pack'), /购物车达限/);
  await app.click('查看日常饲料包详情');
  assertQuantities(app.modalHTML, 5, 5, 0);
  assert.ok(app.controls().find(control => control.dataset.action === 'x-add-cart')?.disabled);
  assert.match(app.modalHTML, /购物车达限/);
  await app.click('查看购物车');
  await app.click('减少日常饲料包');
  await app.click('返回商城');
  assertQuantities(card(app.html, 'feed-pack'), 5, 4, 1);
  await app.click('查看日常饲料包详情');
  assertQuantities(app.modalHTML, 5, 4, 1);
  await app.click('加入购物车');
  assert.equal(app.state.system.cart['feed-pack'], 5);
  assert.ok(app.controls().find(control => control.dataset.action === 'x-add-cart')?.disabled);
});

test('completed daily exchanges show sold out in both entry points and become available on the next day', async () => {
  const app = createApp('#shop');
  app.state.wallet.points = 1000;
  await app.click('农场物资');
  for (let count = 0; count < 5; count++) await app.click('加入日常饲料包到购物车');
  await app.click(control => control.dataset.action === 'cart');
  await app.click(/^确认结算/);
  await app.click('确认兑换');
  await app.click('继续逛商城');
  assertQuantities(card(app.html, 'feed-pack'), 0, 0, 0);
  assert.match(card(app.html, 'feed-pack'), /今日兑完/);
  await app.click('查看日常饲料包详情');
  assertQuantities(app.modalHTML, 0, 0, 0);
  assert.ok(app.controls().find(control => control.dataset.action === 'x-add-cart')?.disabled);
  assert.match(app.modalHTML, /今日兑完/);
  const afterPurchase = assets(app);
  await app.click('关闭弹窗');
  assert.equal(assets(app), afterPurchase, 'viewing or closing a sold-out item does not repeat checkout');
  app.nextDay();
  app.render();
  assertQuantities(card(app.html, 'feed-pack'), 5, 0, 5);
  await app.click('查看日常饲料包详情');
  assertQuantities(app.modalHTML, 5, 0, 5);
  assert.equal(app.controls().find(control => control.dataset.action === 'x-add-cart')?.disabled, false);
});

test('detail reads the current wallet and explains the per-item grants without committing a purchase', async () => {
  const app = createApp('#shop');
  app.state.wallet.points = 127;
  await app.click('农场物资');
  const before = assets(app);
  await app.click('查看日常照料组合详情');
  const text = app.modalHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /65\s*积分\s*\/\s*件/);
  assert.match(text, /可用田园积分\s*127\s*积分/);
  assert.match(text, /每件包含/);
  assert.match(text, /日常饲料\s*3\s*份/);
  assert.match(text, /田园养护肥\s*1\s*份/);
  assert.match(text, /农事工具\s*1\s*件/);
  assert.match(text, /同一饲料余额/);
  assert.match(text, /我的仓库/);
  assert.equal(assets(app), before, 'product detail only describes the existing shared assets');
  await app.click('加入购物车');
  assert.equal(app.state.wallet.points, 127, 'adding one item never deducts wallet points');
  assert.equal(app.state.system.cart['care-bundle'], 1);
});

test('point sorting is visible, changes real product order, and survives category switches without changing assets', async () => {
  const app = createApp('#shop');
  await app.click('农场物资');
  await app.click('加入日常饲料包到购物车');
  const before = assets(app);
  assert.deepEqual(productOrder(app.html), ['feed-pack', 'fertilizer', 'care-tools', 'seed-box', 'care-bundle']);
  await app.click('积分从低到高');
  assert.deepEqual(productOrder(app.html), ['fertilizer', 'care-tools', 'feed-pack', 'seed-box', 'care-bundle']);
  assert.match(app.html, /data-sort="cost-asc"[^>]*aria-pressed="true"/);
  await app.click('积分好礼');
  assert.deepEqual(productOrder(app.html), ['garden-sign', 'season-gift', 'harvest-frame']);
  assert.match(app.html, /data-sort="cost-asc"[^>]*aria-pressed="true"/);
  await app.click('积分从高到低');
  assert.deepEqual(productOrder(app.html), ['harvest-frame', 'season-gift', 'garden-sign']);
  await app.click('农场物资');
  assert.deepEqual(productOrder(app.html), ['care-bundle', 'seed-box', 'feed-pack', 'care-tools', 'fertilizer']);
  await app.click('推荐顺序');
  assert.deepEqual(productOrder(app.html), ['feed-pack', 'fertilizer', 'care-tools', 'seed-box', 'care-bundle']);
  assert.equal(assets(app), before, 'sorting and switching categories do not alter the shopping cart, wallet, or benefits');
});

test('point sorting never changes the original seasonal adoption order or shows on the adoption section', async () => {
  const app = createApp('#shop');
  const before = app.controls().filter(control => control.dataset.action === 'buy').map(control => control.name);
  assert.ok(before.length > 0, 'seasonal adoption remains reachable');
  await app.click('农场物资');
  await app.click('积分从高到低');
  await app.click('当季认养');
  assert.deepEqual(app.controls().filter(control => control.dataset.action === 'buy').map(control => control.name), before);
  assert.equal(app.controls().filter(control => control.dataset.action === 'x-goods-sort').length, 0);
  await app.click('农场物资');
  assert.match(app.html, /data-sort="cost-desc"[^>]*aria-pressed="true"/);
});
