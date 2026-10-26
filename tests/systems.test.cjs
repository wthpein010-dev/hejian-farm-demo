const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Domain = require('../prototype/domain.js');
const file = path.join(__dirname, '../prototype/systems.js');
let S = {};
try { S = require(file); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function call(name, ...args) { assert.equal(typeof S[name], 'function', `${name} must exist`); return S[name](...args); }
const now = Date.parse('2026-10-27T04:00:00Z'), DAY = 86400000;
const wallet = points => ({ points: points ?? 500, feed: 6, receipts: [], adToday: 2, inviteCount: 1, welcomeClaimed: true });
const state = () => call('createState', now);
const cart = (sku, quantity = 1) => call('addCart', state(), sku, quantity, now).system;
function event(system, type, id, at = now, items) { return call('recordEvent', system, { type, eventId: id, now: at, ...(items ? { items } : {}) }); }
function task(system, purse, taskId, receiptId, at = now) { return call('claimTask', system, purse, { taskId, receiptId, now: at }); }

test('catalog clones grants and initial state has the complete inventory and welcome coupon', () => {
  const catalog = call('getCatalog');
  assert.deepEqual(catalog.map(p => p.id), ['feed-pack','fertilizer','care-tools','seed-box','garden-sign','harvest-frame','care-bundle','season-gift']);
  assert.deepEqual(catalog.map(p => p.cost), [30,20,25,40,80,100,65,90]);
  catalog[0].grant.feed = 999;
  assert.equal(call('getCatalog')[0].grant.feed, 3);
  const s = state();
  assert.deepEqual(s.inventory, { fertilizer: 2, tools: 1, seedPacks: 0, eggs: 0, crops: 0, meat: 0, decorations: 0 });
  assert.equal(s.xp, 120);
  assert.equal(s.coupons[0].id, 'welcome-20');
  assert.equal(s.daily.day, '2026-10-27');
});

test('cart rejects missing SKU, invalid delta, underflow and per-item daily limits', () => {
  const s = state(), before = JSON.stringify(s);
  for (const [sku, delta] of [['missing',1],['__proto__',1],['feed-pack',-1],['feed-pack',6],['feed-pack',NaN],['feed-pack',Infinity],['feed-pack','1'],['feed-pack',0.5]]) {
    const result = call('addCart', s, sku, delta, now);
    assert.equal(result.ok, false);
    assert.deepEqual(result.system, s);
  }
  const added = call('addCart', s, 'feed-pack', 2, now);
  assert.equal(added.system.cart['feed-pack'], 2);
  assert.equal(JSON.stringify(s), before);
  const removed = call('addCart', added.system, 'feed-pack', -2, now);
  assert.equal(Object.hasOwn(removed.system.cart, 'feed-pack'), false);
});

test('quote calculates an eligible one-time discount and does not silently apply invalid coupons', () => {
  const s = cart('feed-pack', 2), before = JSON.stringify(s);
  const q = call('quoteCart', s, { couponId: 'welcome-20' });
  assert.equal(q.count, 2); assert.equal(q.subtotal, 60); assert.equal(q.discount, 20); assert.equal(q.total, 40);
  assert.equal(q.items[0].quantity, 2); assert.equal(q.items[0].lineTotal, 60); assert.equal(q.couponEligible, true);
  assert.equal(JSON.stringify(s), before);
  const low = call('quoteCart', cart('fertilizer'), { couponId: 'welcome-20' });
  assert.equal(low.couponEligible, false); assert.equal(low.discount, 0); assert.equal(low.total, 20);
  assert.equal(call('quoteCart', s, { couponId: 'missing' }).couponEligible, false);
});

test('checkout atomically deducts points, grants stock, consumes coupon and records both receipts', () => {
  const s = cart('care-bundle'), w = wallet(), before = JSON.stringify({ s, w });
  const r = call('checkout', s, w, { now, couponId: 'welcome-20', receiptId: 'buy-1' });
  assert.equal(r.ok, true); assert.equal(r.wallet.points, 455); assert.equal(r.wallet.feed, 9);
  assert.equal(r.system.inventory.fertilizer, 3); assert.equal(r.system.inventory.tools, 2);
  assert.deepEqual(r.system.cart, {}); assert.equal(r.system.coupons[0].used, true);
  assert.equal(r.system.daily.bought['care-bundle'], 1); assert.equal(r.purchase.total, 45);
  assert.equal(r.system.receipts.includes('buy-1'), true); assert.equal(r.wallet.receipts.includes('buy-1'), true);
  assert.deepEqual([r.wallet.adToday,r.wallet.inviteCount,r.wallet.welcomeClaimed], [2,1,true]);
  assert.equal(JSON.stringify({ s, w }), before);
});

test('failed checkout grants nothing, consumes no coupon and preserves cart', () => {
  for (const options of [{ points: 1 }, { points: 500, couponId: 'missing' }, { points: 500, receiptId: '' }]) {
    const s = cart('feed-pack', 2), w = wallet(options.points);
    const r = call('checkout', s, w, { now, couponId: options.couponId ?? 'welcome-20', receiptId: options.receiptId ?? 'buy-1' });
    assert.equal(r.ok, false); assert.deepEqual(r.system, s); assert.deepEqual(r.wallet, w);
  }
  assert.equal(call('checkout', state(), wallet(), { now, receiptId: 'empty' }).ok, false);
});

test('a supplied malformed or already consumed coupon cannot silently charge the full price', () => {
  for (const couponId of [0, false, NaN, {}, '<script>']) {
    const s=cart('feed-pack',2),w=wallet(),r=call('checkout',s,w,{now,couponId,receiptId:'bad-coupon'});
    assert.equal(r.ok,false);assert.deepEqual(r.wallet,w);assert.deepEqual(r.system,s);
  }
  const used=call('checkout',cart('feed-pack',2),wallet(),{now,couponId:'welcome-20',receiptId:'first'});
  const s=call('addCart',used.system,'feed-pack',2,now).system;
  const second=call('checkout',s,used.wallet,{now,couponId:'welcome-20',receiptId:'second'});
  assert.equal(second.ok,false);assert.equal(second.system.coupons[0].used,true);assert.equal(second.wallet.points,460);
});

test('checkout revalidates stock after a cart quote and sync preserves inventory and historical claims', () => {
  const s=cart('feed-pack',2);s.daily.bought['feed-pack']=4;
  const r=call('checkout',s,wallet(),{now,receiptId:'stale-cart'});
  assert.equal(r.ok,false);assert.deepEqual(r.system,s);assert.equal(r.wallet.points,500);
  const signed=call('signIn',state(),wallet(),{now,receiptId:'signed'});
  const next=call('syncDay',signed.system,now+DAY);
  assert.deepEqual(next.signedDays,['2026-10-27']);assert.deepEqual(next.receipts,['signed']);
  assert.deepEqual(next.inventory,signed.system.inventory);assert.equal(next.xp,130);
});

test('checkout replay and reentrant receipt cannot double-charge or grant a second shipment', () => {
  const first = call('checkout', cart('feed-pack'), wallet(), { now, receiptId: 'same-buy' });
  const again = call('addCart', first.system, 'feed-pack', 1, now).system;
  const replay = call('checkout', again, first.wallet, { now, receiptId: 'same-buy' });
  assert.equal(replay.ok, false); assert.equal(replay.wallet.points, 470); assert.equal(replay.wallet.feed, 9);
  assert.equal(replay.system.purchases.length, 1); assert.equal(replay.system.cart['feed-pack'], 1);
  const cross = call('checkout', cart('feed-pack'), { ...wallet(), receipts: ['domain-receipt'] }, { now, receiptId: 'domain-receipt' });
  assert.equal(cross.ok, false);
});

test('purchased quantities limit the next cart and reset only after Shanghai midnight', () => {
  const limit = call('getCatalog').find(p => p.id === 'garden-sign').limit;
  const first = call('checkout', cart('garden-sign', limit), wallet(), { now, receiptId: 'daily-buy' });
  assert.equal(first.ok, true);
  assert.equal(call('addCart', first.system, 'garden-sign', 1, now).ok, false);
  const next = call('addCart', first.system, 'garden-sign', 1, Date.parse('2026-10-27T16:00:00Z'));
  assert.equal(next.ok, true); assert.equal(next.system.daily.day, '2026-10-28');
  const backwards = call('addCart', next.system, 'garden-sign', 1, now);
  assert.equal(backwards.ok, false);
});

test('invalid state and wallet numbers fail closed instead of resetting quotas', () => {
  assert.equal(typeof S.checkout, 'function');
  for (const value of [-1,NaN,Infinity,'10',1.5]) {
    assert.throws(() => call('checkout', cart('feed-pack'), { ...wallet(), points: value }, { now, receiptId: 'bad' }));
    const s = state(); s.inventory.tools = value;
    assert.throws(() => call('addCart', s, 'feed-pack', 1, now));
  }
  const full = { ...wallet(), feed: Number.MAX_SAFE_INTEGER };
  const r = call('checkout', cart('feed-pack'), full, { now, receiptId: 'overflow' });
  assert.equal(r.ok, false); assert.equal(r.wallet.points, 500);
});

test('harvest event is idempotent for XP, stats and physical inventory', () => {
  const s = state(), r = event(s, 'harvest', 'harvest-1', now, { eggs: 3, crops: 2, meat: 1 });
  assert.equal(r.xp, 128); assert.equal(r.stats.harvest, 1);
  assert.deepEqual([r.inventory.eggs,r.inventory.crops,r.inventory.meat], [3,2,1]);
  assert.deepEqual(event(r, 'harvest', 'harvest-1', now, { eggs: 3 }), r);
  assert.equal(s.inventory.eggs, 0);
  assert.equal(call('getTasks', r, now).find(t => t.id === 'harvest').ready, true);
});

test('browse grants XP at most once daily and other unique events grant eight XP', () => {
  let s = event(state(), 'browse', 'browse-1');
  s = event(s, 'browse', 'browse-2');
  assert.equal(s.xp, 128); assert.equal(s.daily.browse, 1);
  s = event(s, 'care', 'care-1'); s = event(s, 'adoption', 'adopt-1');
  assert.equal(s.xp, 144); assert.equal(s.stats.care, 1); assert.equal(s.stats.adoption, 1);
});

test('only harvest accepts bounded inventory grants and malformed events do not mutate inputs', () => {
  assert.equal(typeof S.recordEvent, 'function');
  const s = state(), before = JSON.stringify(s);
  for (const [type,items] of [['care',{eggs:1}],['harvest',{feed:2}],['harvest',{eggs:-1}],['harvest',{crops:NaN}],['harvest',{meat:'2'}]]) {
    assert.throws(() => event(s, type, 'bad-event', now, items));
  }
  assert.equal(JSON.stringify(s), before);
});

test('daily tasks require the event and cannot be claimed twice with another receipt', () => {
  const w = wallet(); assert.equal(task(state(), w, 'care', 'not-ready').ok, false);
  const s = event(state(), 'care', 'care-1'), first = task(s, w, 'care', 'task-1');
  assert.equal(first.ok, true); assert.equal(first.wallet.points, 515);
  const tasks = call('getTasks', first.system, now);
  assert.equal(tasks.find(t => t.id === 'care').claimed, true);
  assert.equal(task(first.system, first.wallet, 'care', 'task-2').ok, false);
  assert.equal(task(first.system, first.wallet, 'browse', 'task-1').ok, false);
});

test('task claims reset by Shanghai day while historical receipt and care cooldown survive', () => {
  const first = task(event(state(), 'care', 'care-1'), wallet(), 'care', 'task-1');
  const midnight = Date.parse('2026-10-27T16:00:00Z');
  let s = call('syncDay', first.system, midnight);
  assert.equal(call('getTasks', s, midnight).find(t => t.id === 'care').ready, false);
  s = event(s, 'care', 'care-2', midnight);
  assert.equal(task(s, first.wallet, 'care', 'task-1', midnight).ok, false);
  const next = task(s, first.wallet, 'care', 'task-2', midnight);
  assert.equal(next.ok, true);
  const cooldown = { kind:'feed', usedToday:1, lastAt:midnight-3600000, now:midnight, inventory:next.wallet.feed };
  assert.equal(Domain.careEligibility(cooldown).allowed, false);
  assert.equal(next.wallet.adToday, 2);
});

test('sign-in is once per day, continues seven days and gives the seventh-day coupon', () => {
  let s = state(), w = wallet();
  for (let i = 0; i < 7; i++) {
    const r = call('signIn', s, w, { now:now+i*DAY, receiptId:'sign-'+i });
    assert.equal(r.ok, true); s=r.system;w=r.wallet;
    assert.equal(call('signIn', s, w, { now:now+i*DAY, receiptId:'repeat-'+i }).ok, false);
  }
  assert.equal(w.points, 650); assert.equal(w.feed, 7); assert.equal(s.inventory.fertilizer, 3);
  assert.equal(s.coupons.length, 2); assert.equal(s.stats.checkins, 7); assert.equal(s.xp, 190);
  const info=call('getSignIn', s, now+6*DAY);
  assert.equal(info.todayClaimed, true); assert.equal(info.streak, 7); assert.equal(info.nextIndex, 0); assert.equal(info.rewards.length, 7);
});

test('broken check-in streak resets display and rejects backdated sign-ins or replay receipts', () => {
  const first=call('signIn', state(), wallet(), {now,receiptId:'sign-0'});
  const info=call('getSignIn', first.system, now+2*DAY);
  assert.equal(info.streak, 0); assert.equal(info.nextIndex, 0);
  const next=call('signIn', first.system, first.wallet, {now:now+2*DAY,receiptId:'sign-2'});
  assert.equal(next.ok, true); assert.equal(next.wallet.points, 540);
  assert.equal(call('signIn',next.system,next.wallet,{now:now+DAY,receiptId:'past'}).ok,false);
  assert.equal(call('signIn',next.system,next.wallet,{now:now+3*DAY,receiptId:'sign-0'}).ok,false);
});

test('four achievements require actual stats and each can only reward once', () => {
  let s=state(),w=wallet();
  assert.equal(call('claimAchievement',s,w,{achievementId:'first-care',now,receiptId:'early'}).ok,false);
  for(const [type,id]of [['care','c'],['adoption','a'],['harvest','h']])s=event(s,type,id);
  for(let i=0;i<3;i++){const r=call('signIn',s,w,{now:now+i*DAY,receiptId:'sign-'+i});s=r.system;w=r.wallet;}
  const achievements=call('getAchievements',s);assert.equal(achievements.length,4);assert.equal(achievements.every(a=>a.ready),true);
  for(const a of achievements){const r=call('claimAchievement',s,w,{achievementId:a.id,now:now+2*DAY,receiptId:'ach-'+a.id});assert.equal(r.ok,true);s=r.system;w=r.wallet;assert.equal(call('claimAchievement',s,w,{achievementId:a.id,now:now+2*DAY,receiptId:'again-'+a.id}).ok,false);}
  assert.equal(w.points,650);assert.equal(w.feed,7);
});

test('season stamp requires all three claimed tasks, rewards once and resets by day', () => {
  let s=state(),w=wallet();
  for(const type of ['browse','care','harvest'])s=event(s,type,'event-'+type);
  assert.equal(call('getSeasonStatus',s,now).count,0);
  assert.equal(call('claimSeason',s,w,{now,receiptId:'early'}).ok,false);
  for(const id of ['browse','care','harvest']){const r=task(s,w,id,'task-'+id);s=r.system;w=r.wallet;}
  assert.deepEqual(call('getSeasonStatus',s,now),{count:3,total:3,claimed:false,ready:true});
  const r=call('claimSeason',s,w,{now,receiptId:'season'});
  assert.equal(r.ok,true);assert.equal(r.wallet.points,575);assert.equal(r.wallet.feed,7);assert.equal(r.system.coupons.length,2);
  assert.equal(call('claimSeason',r.system,r.wallet,{now,receiptId:'season-again'}).ok,false);
  assert.equal(call('getSeasonStatus',r.system,now+DAY).count,0);
});

test('cross-system receipt cannot pay two different rewards and overflow is atomic', () => {
  const s=event(state(),'care','care-1'),first=task(s,wallet(),'care','shared');
  assert.equal(call('signIn',first.system,first.wallet,{now,receiptId:'shared'}).ok,false);
  const huge=wallet(Number.MAX_SAFE_INTEGER);
  const r=task(s,huge,'care','too-large');
  assert.equal(r.ok,false);assert.deepEqual(r.system,s);assert.deepEqual(r.wallet,huge);
});

test('level uses earned XP thresholds without a paid VIP status', () => {
  assert.deepEqual(call('getLevel',state()),{level:3,label:'勤耕生活家',xp:120,current:120,next:220,progress:0});
  const s=state();s.xp=550;const level=call('getLevel',s);assert.equal(level.level,6);assert.equal(level.next,null);assert.equal(level.progress,100);
});

test('browser UMD uses FarmDomain and returns isolated states with no external services', () => {
  assert.equal(fs.existsSync(file),true);
  const context={window:{FarmDomain:Domain}};vm.createContext(context);vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const api=context.window.FarmSystems,a=api.createState(now),b=api.createState(now);a.inventory.tools=99;
  assert.equal(b.inventory.tools,1);assert.equal(api.getCatalog().length,8);
});
