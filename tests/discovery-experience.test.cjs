const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');
const assets = app => JSON.stringify({system:app.state.system,wallet:app.state.wallet,care:app.state.care});
const goods = app => app.controls().filter(c=>c.dataset.action==='x-goods-detail').map(c=>c.dataset.sku);

test('local product search finds bundle resources and clearing recovers without changing assets', async()=>{
 const app=createApp('#shop'); await app.click('农场物资'); const before=assets(app);
 await app.search('肥料');
 assert.deepEqual(goods(app),['fertilizer','care-bundle']);
 await app.search('<img src=x onerror=alert(1)>');
 assert.deepEqual(goods(app),[]); assert.match(app.html,/没有找到/);
 assert.ok(!app.html.includes('<img src=x'));
 await app.click('清除商品搜索'); assert.equal(goods(app).length,5);
 assert.equal(assets(app),before);
});

test('IME composition cannot commit a partial product search', async()=>{
 const app=createApp('#shop'); await app.click('农场物资');
 await app.search('肥',{composing:true}); assert.equal(goods(app).length,5);
 await app.search('肥料'); assert.deepEqual(goods(app),['fertilizer','care-bundle']);
});

test('page resume preserves a product search draft, focused input, and cursor range',async()=>{
 const app=createApp('#shop');await app.click('农场物资');
 await app.draftSearch('照料组合',1,3);const before=assets(app);
 await app.hide();await app.resume();
 assert.deepEqual(app.focusedInput,{id:'shop-query',value:'照料组合',start:1,end:3});
 assert.equal(goods(app).length,5,'a draft remains uncommitted after lifecycle repaint');
 assert.equal(assets(app),before);
});

test('an IME confirmation Enter cannot search early and lifecycle repaint does not disconnect composition',async()=>{
 const app=createApp('#shop');await app.click('农场物资');
 await app.composeSearch('肥料');await app.hide();await app.resume();
 assert.equal(app.focusedInput.id,'shop-query');assert.equal(app.focusedInput.value,'肥料');
 await app.endSearchComposition();await app.enterSearch();
 assert.equal(goods(app).length,5,'candidate confirmation is not a search command');
 app.advance(60);await app.enterSearch();
 assert.deepEqual(goods(app),['fertilizer','care-bundle']);
});

test('wishlist and earn goal follow the same wallet and return to the same product without purchasing', async()=>{
 const app=createApp('#shop'); await app.click('积分好礼');
 await app.click('查看丰收纪念相框详情'); const before=assets(app);
 await app.click('存入心愿'); assert.equal(assets(app),before);
 await app.click('去活动攒积分'); assert.equal(app.state.view,'activities');
 assert.match(app.html,/丰收纪念相框/); assert.match(app.html,/还差 20 积分/);
 await app.click('领取今日签到');
 assert.equal(app.state.wallet.points,100); assert.equal(app.state.system.purchases.length,0);
 assert.match(app.html,/积分已够兑一件/);
 await app.click('回看心愿商品'); assert.equal(app.modal.sku,'harvest-frame');
 await app.click('关闭弹窗'); await app.click('我的心愿');
 assert.deepEqual(goods(app),['harvest-frame']);
 await app.click('查看丰收纪念相框详情'); await app.click('取消心愿');
 await app.click('关闭弹窗'); assert.deepEqual(goods(app),[]);
 assert.match(app.html,/还没有心愿/);
 assert.equal(createApp('#shop').state.shopWishlist.length,0);
});

test('task filters track reward eligibility, successful claims, and honest empty results', async()=>{
 const app=createApp(); await app.click('商城'); await app.click('活动');
 await app.click(c=>c.dataset.action==='x-task-filter'&&c.dataset.filter==='ready');
 let tasks=app.controls().filter(c=>c.dataset.action==='x-claim-task');
 assert.deepEqual(tasks.map(c=>c.dataset.task),['browse']);
 await app.click(tasks[0].name);
 assert.equal(app.state.wallet.points,90); assert.match(app.html,/没有待领取/);
 await app.click(c=>c.dataset.action==='x-task-filter'&&c.dataset.filter==='claimed');
 assert.match(app.html,/逛逛商城/); assert.ok(!app.html.includes('刚好的照料</h3>'));
 await app.click(c=>c.dataset.action==='x-task-filter'&&c.dataset.filter==='todo');
 assert.ok(app.html.includes('刚好的照料</h3>')); assert.ok(!app.html.includes('逛逛商城</h3>'));
});

test('all seven reward previews are read-only and the preview uses the existing daily sign-in transaction', async()=>{
 const app=createApp('#activities'); const before=assets(app);
 for(let day=1;day<=7;day++){
  await app.click(c=>c.dataset.action==='x-signin-preview'&&c.dataset.day===String(day));
  assert.ok(app.dialogOpen); assert.match(app.modalHTML,new RegExp('第 '+day+' 天'));
  assert.equal(assets(app),before); await app.click('关闭弹窗');
 }
 await app.click(c=>c.dataset.action==='x-signin-preview'&&c.dataset.day==='1');
 await app.click('领取今日签到'); assert.equal(app.state.wallet.points,100);
 assert.equal(app.state.rewardHistory.length,1);
});
