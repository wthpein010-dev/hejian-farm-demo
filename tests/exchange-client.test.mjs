import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as farmClient from '../apps/mobile/src/core/client.mjs';
import { createExchangePage, createExchangeDetail } from '../shared/exchanges.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const now=1793044800000,scope={ownerId:'member-a',environment:'development',serverTime:now};
const {mergeExchangePages}=farmClient;
const createFarmClient = options => farmClient.createFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport) });
const ok=data=>({status:200,data:{data}});
function purchase(n=1){const receiptId='api-'+n.toString(16).padStart(64,'0');return {id:'shop-'+receiptId,receiptId,day:'2026-10-27',items:[{id:'feed-pack',title:'原版日常饲料包',art:'feed',cost:30,quantity:2,lineTotal:60,grant:{feed:3}}],count:2,subtotal:60,discount:20,total:40,couponId:'coupon-original'};}
const detail=(n=1)=>createExchangeDetail(purchase(n),scope);
const page=(items=[purchase(1)],cursor='start')=>createExchangePage(items,{...scope,cursor});
function fixture(){const calls=[],replies=[];let serial=0;const client=createFarmClient({baseURL:'http://127.0.0.1:8787',generateKey:()=>`checkout-operation-${++serial}`,transport:async r=>{calls.push(structuredClone(r));const reply=replies.shift();assert.ok(reply,'explicit response required');if(reply instanceof Error)throw reply;return await reply;}});return {client,calls,replies};}
async function login(h,owner='member-a'){h.replies.push(ok({environment:'development',token:'token-'+owner,profile:{id:owner,displayName:'合成账户'}}));await h.client.loginDevelopment('synthetic-account');h.replies.push(ok(mobileSnapshot({profile:{id:owner}})));await h.client.load();}

test('exchange reads require a scoped snapshot and reject malformed or different-owner data',async()=>{
 const h=fixture();assert.equal(typeof h.client.loadExchangePage,'function');
 await assert.rejects(h.client.loadExchangePage(),e=>e.code==='SESSION_REQUIRED');await login(h);
 h.replies.push(ok(page()));await h.client.loadExchangePage();assert.equal(h.client.exchangePage.items[0].received.feed,6);
 const bad=page();bad.ownerId='member-b';h.replies.push(ok(bad));await assert.rejects(h.client.loadExchangePage(),e=>e.code==='SERVER_UNAVAILABLE');
 assert.equal(h.client.exchangePage.items[0].id,purchase(1).id,'failed replacement preserves valid private data');
 const corrupt=detail();corrupt.exchange.received.feed=9;h.replies.push(ok(corrupt));await assert.rejects(h.client.loadExchangeDetail(purchase(1).id),e=>e.code==='SERVER_UNAVAILABLE');
 await assert.rejects(h.client.loadExchangeDetail('../member-b'),e=>e.code==='INVALID_REQUEST');
});

test('a later exchange read wins and a login switch makes late receipts harmless',async()=>{
 const h=fixture();await login(h);let release;h.replies.push(new Promise(r=>release=r));const old=h.client.loadExchangeDetail(purchase(1).id);
 h.replies.push(ok(detail(2)));await h.client.loadExchangeDetail(purchase(2).id);release(ok(detail(1)));
 await assert.rejects(old,e=>e.code==='READ_SUPERSEDED');assert.equal(h.client.exchangeDetail.exchange.id,purchase(2).id);
 let late;h.replies.push(new Promise(r=>late=r));const pending=h.client.loadExchangePage();
 await login(h,'member-b');late(ok(page()));await assert.rejects(pending,e=>e.code==='SESSION_CHANGED');assert.equal(h.client.exchangePage,null);assert.equal(h.client.exchangeDetail,null);
});

test('display pagination only appends to its exact cursor and rejects overlap or changed scope',()=>{
 const records=Array.from({length:23},(_,i)=>purchase(i+1));const first=page(records),next=page(records,first.nextCursor);
 assert.equal(typeof mergeExchangePages,'function');const joined=mergeExchangePages(first,next,first.nextCursor);
 assert.equal(joined.items.length,23);assert.equal(joined.items[20].id,purchase(3).id);
 assert.throws(()=>mergeExchangePages(first,next,'start-wrong'),e=>e.code==='READ_SUPERSEDED');
 assert.throws(()=>mergeExchangePages(first,{...next,items:[first.items[0]]},first.nextCursor),e=>e.code==='READ_SUPERSEDED');
 assert.throws(()=>mergeExchangePages(first,{...next,ownerId:'member-b'},first.nextCursor),e=>e.code==='READ_SUPERSEDED');
 assert.equal(first.items.length,20);
});

test('a recovered checkout looks up its original key even when a newer purchase is already synchronized',async()=>{
 const h=fixture();await login(h);assert.equal(h.client.hasConfirmedCheckout,false);
 h.replies.push(new Error('lost success'));await assert.rejects(h.client.mutate('/checkout',{}),e=>e.code==='RESULT_UNKNOWN');
 const original=h.calls.at(-1);assert.equal(h.client.hasConfirmedCheckout,false);
 const latest=mobileSnapshot({revision:8});latest.system.purchases=[purchase(1),purchase(2)];h.replies.push(ok(latest));await h.client.load();
 const replay=mobileSnapshot({revision:4});replay.system.purchases=[purchase(1)];h.replies.push(ok(replay));await h.client.retryPending();
 assert.equal(h.client.snapshot.revision,8);assert.equal(h.client.hasConfirmedCheckout,true);
 h.replies.push(ok(detail(1)));await h.client.loadConfirmedCheckout();const read=h.calls.at(-1);
 assert.equal(read.method,'GET');assert.equal(read.url,'http://127.0.0.1:8787/api/v1/account/checkout-receipt');
 assert.equal(read.headers['Idempotency-Key'],original.headers['Idempotency-Key']);assert.equal(read.body,undefined);
 assert.equal(h.client.exchangeDetail.exchange.id,purchase(1).id);assert.equal(h.client.hasPending(),false);
});

test('history reads and a missing receipt cannot settle or repeat an uncertain asset operation',async()=>{
 const h=fixture();await login(h);h.replies.push(new Error('offline'));await assert.rejects(h.client.mutate('/checkout',{}));
 const original=h.calls.at(-1);h.replies.push({status:503,data:{error:{code:'maintenance',message:'服务维护'}}});await assert.rejects(h.client.loadExchangePage());
 assert.equal(h.client.hasPending(),true);await assert.rejects(h.client.loadConfirmedCheckout(),e=>e.code==='CHECKOUT_RECEIPT_UNAVAILABLE');
 const success=mobileSnapshot({revision:4});success.system.purchases=[purchase(1)];h.replies.push(ok(success));await h.client.retryPending();
 assert.equal(h.calls.at(-1).headers['Idempotency-Key'],original.headers['Idempotency-Key']);
 h.replies.push({status:404,data:{error:{code:'EXCHANGE_NOT_FOUND',message:'未找到记录'}}});await assert.rejects(h.client.loadConfirmedCheckout());
 assert.equal(h.client.hasConfirmedCheckout,true);assert.equal(h.client.hasPending(),false);
 assert.equal(h.calls.filter(r=>r.url.endsWith('/checkout')&&r.method==='POST').length,2,'only the original operation and explicit recovery were sent');
});

test('a new checkout clears the previous confirmed shortcut and account exit clears all receipt caches',async()=>{
 const h=fixture();await login(h);h.replies.push(ok(mobileSnapshot({revision:4})));await h.client.mutate('/checkout',{});
 h.replies.push(ok(detail()));await h.client.loadConfirmedCheckout();assert.equal(h.client.hasConfirmedCheckout,true);
 h.replies.push({status:422,data:{error:{code:'BUSINESS_RULE',message:'条件不满足'},data:mobileSnapshot({revision:4})}});
 await assert.rejects(h.client.mutate('/checkout',{}));assert.equal(h.client.hasConfirmedCheckout,false);
 h.replies.push(ok(page()));await h.client.loadExchangePage();h.replies.push(ok({loggedOut:true}));await h.client.logout();
 assert.equal(h.client.exchangePage,null);assert.equal(h.client.exchangeDetail,null);assert.equal(h.client.hasConfirmedCheckout,false);
});

test('a late confirmed-receipt response cannot replace the receipt for a newer confirmed checkout',async()=>{
 const h=fixture();await login(h);h.replies.push(ok(mobileSnapshot({revision:4})));await h.client.mutate('/checkout',{});
 let resolve;h.replies.push(new Promise(r=>resolve=r));const older=h.client.loadConfirmedCheckout();
 h.replies.push(ok(mobileSnapshot({revision:5})));await h.client.mutate('/checkout',{});
 h.replies.push(ok(detail(2)));await h.client.loadConfirmedCheckout();resolve(ok(detail(1)));
 await assert.rejects(older,e=>e.code==='READ_SUPERSEDED');assert.equal(h.client.exchangeDetail.exchange.id,purchase(2).id);
});

test('a confirmed checkout invalidates old history and supersedes its in-flight refresh',async()=>{
 const h=fixture();await login(h);h.replies.push(ok(page()));await h.client.loadExchangePage();
 let finish;h.replies.push(new Promise(resolve=>finish=resolve));const old=h.client.loadExchangePage();
 h.replies.push(ok(mobileSnapshot({revision:4})));await h.client.mutate('/checkout',{});
 assert.equal(h.client.exchangePage,null);finish(ok(page()));await assert.rejects(old,e=>e.code==='READ_SUPERSEDED');assert.equal(h.client.exchangePage,null);
});
