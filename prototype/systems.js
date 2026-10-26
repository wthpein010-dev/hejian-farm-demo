/* Demo systems: pure memory transactions; no network, storage or platform SDK. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./domain.js'));
  else root.FarmSystems = factory(root.FarmDomain);
})(typeof window !== 'undefined' ? window : globalThis, function (Domain) {
  'use strict';
  if (!Domain || typeof Domain.chinaDayKey !== 'function') throw new Error('FarmSystems需要先加载FarmDomain');
  const DAY = 86400000;
  const IDS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const INVENTORY = ['fertilizer','tools','seedPacks','eggs','crops','meat','decorations'];
  const TYPES = ['browse','care','adoption','harvest'];
  const CATALOG = [
    { id:'feed-pack',title:'日常饲料包',description:'3份饲料，按需照料牧场伙伴',category:'supplies',cost:30,grant:{feed:3},limit:5,art:'feed' },
    { id:'fertilizer',title:'田园营养肥',description:'1份养护物资，实际使用遵循农场建议',category:'supplies',cost:20,grant:{fertilizer:1},limit:5,art:'fertilizer' },
    { id:'care-tools',title:'农事工具',description:'1件工具，收入农场物资仓',category:'supplies',cost:25,grant:{tools:1},limit:5,art:'tools' },
    { id:'seed-box',title:'当季种子盒',description:'1份种子礼包，供后续种植体验',category:'supplies',cost:40,grant:{seedPacks:1},limit:5,art:'seed' },
    { id:'garden-sign',title:'我的田园木牌',description:'1件田园装饰，记录自己的小天地',category:'gifts',cost:80,grant:{decorations:1},limit:3,art:'sign' },
    { id:'harvest-frame',title:'丰收纪念相框',description:'1件丰收装饰，留住田园好时光',category:'gifts',cost:100,grant:{decorations:1},limit:3,art:'frame' },
    { id:'care-bundle',title:'日常照料组合',description:'3份饲料、1份肥料和1件工具',category:'supplies',cost:65,grant:{feed:3,fertilizer:1,tools:1},limit:3,art:'bundle' },
    { id:'season-gift',title:'四季田园礼盒',description:'5份饲料与2份肥料，按需使用',category:'gifts',cost:90,grant:{feed:5,fertilizer:2},limit:3,art:'gift' }
  ];
  const TASKS = [
    { id:'browse',title:'逛逛商城',description:'今日逛一次农场商城',target:1,reward:{points:10} },
    { id:'care',title:'刚好的照料',description:'完成一次设备确认的浇水或投喂',target:1,reward:{points:15} },
    { id:'harvest',title:'收入一份收获',description:'收取鸡蛋，或完成一次采收与处理',target:1,reward:{points:20} }
  ];
  const ACHIEVEMENTS = [
    { id:'first-care',title:'第一份照料',description:'累计完成1次有效照料',stat:'care',target:1,reward:{points:25} },
    { id:'first-adoption',title:'认养的开始',description:'累计创建1笔认养订单',stat:'adoption',target:1,reward:{points:25} },
    { id:'first-harvest',title:'第一次丰收',description:'累计收入1次实际演示收获',stat:'harvest',target:1,reward:{points:25} },
    { id:'three-checkins',title:'常来田园看看',description:'累计签到3天',stat:'checkins',target:3,reward:{points:25} }
  ];
  const SIGN_REWARDS = [
    {day:1,label:'20积分',reward:{points:20}}, {day:2,label:'30积分',reward:{points:30}},
    {day:3,label:'1份饲料',reward:{feed:1}}, {day:4,label:'40积分',reward:{points:40}},
    {day:5,label:'1份肥料',reward:{fertilizer:1}}, {day:6,label:'60积分',reward:{points:60}},
    {day:7,label:'满60减20积分券',reward:{coupon:{title:'满60减20积分',min:60,off:20}}}
  ];
  const count = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const idOK = v => typeof v === 'string' && IDS.test(v);
  const dayNumber = day => Date.parse(day + 'T00:00:00Z') / DAY;
  const dayOK = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(dayNumber(day)) && new Date(dayNumber(day)*DAY).toISOString().slice(0,10) === day;
  const product = sku => CATALOG.find(item => item.id === sku);
  function clone(value) {
    if (typeof value === 'number' && !count(value)) throw new TypeError('系统数值必须为有限非负安全整数');
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,clone(item)]));
    if (value === null || ['string','boolean','number'].includes(typeof value)) return value;
    throw new TypeError('系统数据格式无效');
  }
  function validIds(array, label, validator = idOK) {
    if (!Array.isArray(array) || array.some(v => !validator(v)) || new Set(array).size !== array.length) throw new TypeError(label + '记录无效');
  }
  function copySystem(system) {
    const s = clone(system);
    if (!s || !INVENTORY.every(k => count(s.inventory?.[k])) || !count(s.xp) || !s.cart || !s.daily || !dayOK(s.daily.day) || !s.daily.bought || !TYPES.every(k => count(s.daily[k])) || !['care','adoption','harvest','checkins'].every(k => count(s.stats?.[k]))) throw new TypeError('田园系统状态无效');
    for (const [sku,qty] of Object.entries(s.cart)) if (!product(sku) || !count(qty) || qty < 1 || qty > 5) throw new TypeError('购物车数据无效');
    for (const [sku,qty] of Object.entries(s.daily.bought)) if (!product(sku) || !count(qty)) throw new TypeError('每日限购数据无效');
    for (const key of ['receipts','taskClaims','achievementClaims','eventIds']) validIds(s[key], key);
    for (const key of ['signedDays','seasonClaims']) validIds(s[key], key, dayOK);
    if (!Array.isArray(s.purchases) || !Array.isArray(s.coupons)) throw new TypeError('商城记录无效');
    const coupons = new Set();
    for (const c of s.coupons) {
      if (!idOK(c.id) || typeof c.title !== 'string' || !count(c.min) || !count(c.off) || !c.off || c.off > c.min || typeof c.used !== 'boolean' || coupons.has(c.id)) throw new TypeError('优惠券数据无效');
      coupons.add(c.id);
    }
    return s;
  }
  function copyWallet(wallet) {
    if (!wallet || !['points','feed','adToday','inviteCount'].every(k => count(wallet[k])) || typeof wallet.welcomeClaimed !== 'boolean') throw new TypeError('福利账户数值无效');
    validIds(wallet.receipts, '福利回执');
    return clone(wallet);
  }
  function getCatalog() { return clone(CATALOG); }
  function createState(now) {
    return { inventory:{fertilizer:2,tools:1,seedPacks:0,eggs:0,crops:0,meat:0,decorations:0},cart:{},
      coupons:[{id:'welcome-20',title:'满60减20积分',min:60,off:20,used:false}],purchases:[],receipts:[],signedDays:[],taskClaims:[],achievementClaims:[],seasonClaims:[],eventIds:[],
      daily:{day:Domain.chinaDayKey(now),browse:0,care:0,adoption:0,harvest:0,bought:{}},stats:{care:0,adoption:0,harvest:0,checkins:0},xp:120 };
  }
  function syncDay(system, now) {
    const s = copySystem(system), day = Domain.chinaDayKey(now);
    if (day > s.daily.day) s.daily = {day,browse:0,care:0,adoption:0,harvest:0,bought:{}};
    return s;
  }
  function addCart(system, sku, delta, now) {
    const base = copySystem(system), day = Domain.chinaDayKey(now);
    const deny = reason => ({ok:false,reason,system:base});
    if (day < base.daily.day) return deny('不能回到过去的日期操作商城');
    if (!Number.isSafeInteger(delta)) return deny('商品数量必须是整数');
    const item = product(sku); if (!item) return deny('商品不存在');
    const s = syncDay(base,now), qty = (s.cart[sku] || 0) + delta;
    const remaining = Math.max(0,item.limit-(s.daily.bought[sku]||0));
    if (!count(qty) || qty > Math.min(5,remaining)) return deny('数量超出购物车或今日剩余限购额度');
    if (qty) s.cart[sku]=qty; else delete s.cart[sku];
    return {ok:true,reason:qty?'已更新购物车':'已移出购物车',system:s};
  }
  function quoteCart(system, options = {}) {
    const s = copySystem(system), couponId = options?.couponId;
    const items = Object.entries(s.cart).map(([sku,quantity]) => ({...clone(product(sku)),quantity,lineTotal:product(sku).cost*quantity}));
    const subtotal = items.reduce((sum,item)=>sum+item.lineTotal,0), countItems=items.reduce((sum,item)=>sum+item.quantity,0);
    const coupon = s.coupons.find(c=>c.id===couponId), hasCoupon=couponId != null && couponId !== '';
    const couponEligible = !!(hasCoupon && coupon && !coupon.used && subtotal>=coupon.min && countItems>0);
    const discount = couponEligible ? Math.min(subtotal,coupon.off) : 0;
    const stockOK=items.every(item=>item.quantity+(s.daily.bought[item.id]||0)<=item.limit);
    const reason = !countItems?'购物车还是空的':!stockOK?'部分商品超出今日剩余限购额度':hasCoupon&&!couponEligible?(!coupon?'优惠券不存在':coupon.used?'这张优惠券已使用':'未达到优惠券使用门槛'):couponEligible?'优惠券已抵扣':'积分兑换，仅为演示';
    return {items,count:countItems,subtotal,discount,total:subtotal-discount,couponEligible,reason};
  }
  function prepare(system,wallet,options) {
    const base=copySystem(system), originalWallet=copyWallet(wallet), day=Domain.chinaDayKey(options?.now);
    const ctx={base,originalWallet,s:syncDay(base,options.now),w:copyWallet(wallet),day,receiptId:options?.receiptId,error:null};
    if(day<base.daily.day)ctx.error='不能使用过去的日期领取或结算';
    else if(!idOK(ctx.receiptId))ctx.error='操作回执无效';
    else if(base.receipts.includes(ctx.receiptId)||wallet.receipts.includes(ctx.receiptId))ctx.error='这次操作已经完成，请勿重复领取或结算';
    return ctx;
  }
  const failed=(ctx,reason)=>({ok:false,reason,system:ctx.base,wallet:ctx.originalWallet});
  function grant(ctx,reward,couponId) {
    const values=[['points',ctx.w],['feed',ctx.w],...INVENTORY.map(key=>[key,ctx.s.inventory])];
    for(const [key,target]of values)if(!count(target[key]+(reward[key]||0)))return false;
    if(reward.coupon&&ctx.s.coupons.some(c=>c.id===couponId))return false;
    for(const [key,target]of values)target[key]+=reward[key]||0;
    if(reward.coupon)ctx.s.coupons.push({id:couponId,...clone(reward.coupon),used:false});
    return true;
  }
  function commit(ctx,reason,reward) {
    ctx.s.receipts.push(ctx.receiptId);ctx.w.receipts.push(ctx.receiptId);
    return {ok:true,reason,system:ctx.s,wallet:ctx.w,...(reward?{reward:clone(reward)}:{})};
  }
  function checkout(system,wallet,options) {
    const ctx=prepare(system,wallet,options);if(ctx.error)return failed(ctx,ctx.error);
    const q=quoteCart(ctx.s,{couponId:options.couponId});
    if(!q.count)return failed(ctx,q.reason);
    if(q.items.some(item=>item.quantity+(ctx.s.daily.bought[item.id]||0)>item.limit))return failed(ctx,'商品已达今日限购数量');
    if(options.couponId!=null&&options.couponId!==''&&(!idOK(options.couponId)||!q.couponEligible))return failed(ctx,q.reason);
    if(ctx.w.points<q.total)return failed(ctx,'积分不足，先完成任务或签到');
    const grants={};for(const item of q.items)for(const [key,value]of Object.entries(item.grant))grants[key]=(grants[key]||0)+value*item.quantity;
    if(!grant(ctx,grants))return failed(ctx,'物资数量超出有效范围，本次未兑换');
    ctx.w.points-=q.total;
    for(const item of q.items)ctx.s.daily.bought[item.id]=(ctx.s.daily.bought[item.id]||0)+item.quantity;
    if(q.couponEligible)ctx.s.coupons.find(c=>c.id===options.couponId).used=true;
    const purchase={id:'shop-'+ctx.receiptId,receiptId:ctx.receiptId,day:ctx.day,items:q.items,count:q.count,subtotal:q.subtotal,discount:q.discount,total:q.total,couponId:q.couponEligible?options.couponId:null};
    ctx.s.purchases.push(clone(purchase));ctx.s.cart={};
    return {...commit(ctx,'积分兑换成功，物资已收入仓库（演示）'),purchase:clone(purchase)};
  }
  function recordEvent(system,event) {
    const base=copySystem(system), value=event||{},day=Domain.chinaDayKey(value.now);
    if(!TYPES.includes(value.type)||!idOK(value.eventId))throw new TypeError('农场事件类型或编号无效');
    if(value.items!=null){if(value.type!=='harvest'||typeof value.items!=='object'||Array.isArray(value.items)||Object.entries(value.items).some(([k,v])=>!['eggs','crops','meat'].includes(k)||!count(v)))throw new TypeError('只有收获事件可以收入有效的鸡蛋、作物或肉类数量');}
    if(day<base.daily.day||base.eventIds.includes(value.eventId))return base;
    const s=syncDay(base,value.now);if(value.type==='browse'&&s.daily.browse>=1)return s;
    if(!count(s.xp+8)||!count(s.daily[value.type]+1)||(value.type!=='browse'&&!count(s.stats[value.type]+1)))throw new RangeError('农场进展超出有效范围');
    for(const [key,qty]of Object.entries(value.items||{}))if(!count(s.inventory[key]+qty))throw new RangeError('收获库存超出有效范围');
    s.eventIds.push(value.eventId);s.daily[value.type]++;s.xp+=8;
    if(value.type!=='browse')s.stats[value.type]++;
    for(const [key,qty]of Object.entries(value.items||{}))s.inventory[key]+=qty;
    return s;
  }
  function getTasks(system,now) {
    const s=syncDay(system,now);
    return TASKS.map(task=>{const claimed=s.taskClaims.includes(s.daily.day+':'+task.id),progress=Math.min(task.target,s.daily[task.id]);return {...clone(task),progress,claimed,ready:progress>=task.target&&!claimed};});
  }
  function claimTask(system,wallet,options) {
    const ctx=prepare(system,wallet,options);if(ctx.error)return failed(ctx,ctx.error);
    const task=getTasks(ctx.s,options.now).find(t=>t.id===options.taskId);
    if(!task||!task.ready)return failed(ctx,task?.claimed?'今日任务奖励已经领取':'请先完成这项每日任务');
    if(!grant(ctx,task.reward))return failed(ctx,'奖励数量超出有效范围');
    ctx.s.taskClaims.push(ctx.day+':'+task.id);return commit(ctx,'任务奖励已领取（演示）',task.reward);
  }
  function getSignIn(system,now) {
    const s=syncDay(system,now),day=s.daily.day,todayClaimed=s.signedDays.includes(day),set=new Set(s.signedDays);
    let cursor=dayNumber(day)-(todayClaimed?0:1),streak=0;
    while(set.has(new Date(cursor*DAY).toISOString().slice(0,10))){streak++;cursor--;}
    return {todayClaimed,streak,nextIndex:streak%7,rewards:clone(SIGN_REWARDS)};
  }
  function signIn(system,wallet,options) {
    const ctx=prepare(system,wallet,options);if(ctx.error)return failed(ctx,ctx.error);
    const info=getSignIn(ctx.s,options.now);if(info.todayClaimed)return failed(ctx,'今天已经签到，明天再来');
    const reward=SIGN_REWARDS[info.nextIndex].reward;
    if(!count(ctx.s.xp+10)||!count(ctx.s.stats.checkins+1)||!grant(ctx,reward,'signin-'+ctx.day))return failed(ctx,'签到奖励超出有效范围');
    ctx.s.signedDays.push(ctx.day);ctx.s.stats.checkins++;ctx.s.xp+=10;return commit(ctx,'今日签到成功（演示）',reward);
  }
  function getAchievements(system) {
    const s=copySystem(system);
    return ACHIEVEMENTS.map(a=>{const claimed=s.achievementClaims.includes(a.id),progress=Math.min(a.target,s.stats[a.stat]);const {stat,...publicAchievement}=clone(a);return {...publicAchievement,progress,claimed,ready:progress>=a.target&&!claimed};});
  }
  function claimAchievement(system,wallet,options) {
    const ctx=prepare(system,wallet,options);if(ctx.error)return failed(ctx,ctx.error);
    const a=getAchievements(ctx.s).find(a=>a.id===options.achievementId);
    if(!a||!a.ready)return failed(ctx,a?.claimed?'这项成就奖励已经领取':'成就条件尚未达成');
    if(!grant(ctx,a.reward))return failed(ctx,'成就奖励超出有效范围');
    ctx.s.achievementClaims.push(a.id);return commit(ctx,'成就奖励已领取（演示）',a.reward);
  }
  function getSeasonStatus(system,now) {
    const s=syncDay(system,now),countClaims=TASKS.filter(t=>s.taskClaims.includes(s.daily.day+':'+t.id)).length,claimed=s.seasonClaims.includes(s.daily.day);
    return {count:countClaims,total:3,claimed,ready:countClaims===3&&!claimed};
  }
  function claimSeason(system,wallet,options) {
    const ctx=prepare(system,wallet,options);if(ctx.error)return failed(ctx,ctx.error);
    const status=getSeasonStatus(ctx.s,options.now);
    if(!status.ready)return failed(ctx,status.claimed?'今天的丰收礼已经领取':'先领取今日三项任务奖励，集齐三枚印章');
    const reward={points:30,feed:1,coupon:{title:'满60减20积分',min:60,off:20}};
    if(!grant(ctx,reward,'season-'+ctx.day))return failed(ctx,'丰收奖励超出有效范围');
    ctx.s.seasonClaims.push(ctx.day);return commit(ctx,'丰收集章礼已领取（演示）',reward);
  }
  function getLevel(system) {
    const s=copySystem(system),thresholds=[0,50,120,220,360,550],labels=['田园新友','初识农事','勤耕生活家','丰收实践家','田园守护者','四季耕耘家'];
    let index=0;while(index+1<thresholds.length&&s.xp>=thresholds[index+1])index++;
    const current=thresholds[index],next=thresholds[index+1]??null;
    return {level:index+1,label:labels[index],xp:s.xp,current,next,progress:next===null?100:Math.min(100,Math.floor((s.xp-current)/(next-current)*100))};
  }
  return Object.freeze({getCatalog,createState,syncDay,addCart,quoteCart,checkout,recordEvent,getTasks,claimTask,getSignIn,signIn,getAchievements,claimAchievement,getSeasonStatus,claimSeason,getLevel});
});
