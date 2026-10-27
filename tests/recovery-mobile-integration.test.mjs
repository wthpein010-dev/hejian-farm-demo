import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../services/api/src/server.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
const now=1793044800000,recordId='recovery-mobile-plot',command={action:'request',recordId,expectedRecordVersion:1};
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'recovery-mobile-')),databasePath=path.join(directory,'synthetic.sqlite'),calls=[];
 let app,baseURL,drop='';
 async function start(){app=createApp({databasePath,mode:'development',allowDevelopmentAuth:true,clock:()=>now,requestRateLimit:{maxRequests:10000,windowMs:60000}});baseURL=`http://127.0.0.1:${await listenOnFetchSafePort(app.server)}`;}
 await start();t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const create=()=>createFarmClient({baseURL,transport:async request=>{calls.push(structuredClone(request));const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body)}),reply={status:response.status,data:await response.json()};if(drop&&request.url.endsWith(drop)){drop='';throw Error('synthetic lost after commit');}return reply;}});
 const login=async(account='recovery-mobile-owner')=>{const client=create();await client.loginDevelopment(account);await client.load();return client;};
 const owner=await login(),dispatcher=await login('recovery-mobile-dispatch');
 app.store.importFarmBatch({formatVersion:1,batchId:'recovery-mobile-batch',source:'synthetic',entries:[{expectedVersion:0,record:{id:recordId,ownerId:owner.profile.id,kind:'plot',name:'合成番茄',unitLabel:'地块1',cycleRef:'cycle-synthetic',status:'planned',startedAt:null,expectedHarvestAt:now+100000,observedAt:now-1000,measurements:{areaM2:12}}}]},now);
 app.store.provisionPlanting({recordId,expectedPlanVersion:0,recordVersion:1,enabled:true,notBefore:now,staff:[{accountId:dispatcher.profile.id,role:'dispatch'}]},now);
 return {owner,dispatcher,calls,login,drop:path=>{drop=path;},restart:async()=>{await app.close();await start();},get app(){return app;}};
}
test('fresh client after prepare response loss and service restart finds original fixed command without auto execution',async t=>{
 const h=await fixture(t),financial=h.owner.snapshot;h.drop('/prepare');await assert.rejects(h.owner.commandPlanting(command),{code:'RESULT_UNKNOWN'});
 const beforeRestart=h.calls.at(-1).body;await h.restart();const cold=await h.login();assert.equal(cold.pendingStage,'prepared');assert.deepEqual(cold.recoveryIntent.command,command);assert.equal(cold.recoveryIntent.prepareEpoch,beforeRestart.expectedEpoch);assert.equal((await cold.loadPlantingPage()).items.length,0);
 const receipt=await cold.continuePlanting();assert.equal(receipt.outcome,'applied');assert.equal(cold.pendingStage,'receipt-review');await cold.acknowledgePlanting();assert.equal((await cold.loadPlantingPage()).items.length,1);assert.deepEqual(cold.snapshot.wallet,financial.wallet);assert.equal(cold.snapshot.revision,financial.revision);
});
test('fresh client after execute loss and restart recovers original request even after another actor accepted order',async t=>{
 const h=await fixture(t);h.drop('/execute');await assert.rejects(h.owner.commandPlanting(command),{code:'RESULT_UNKNOWN'});const originalId=h.owner.recoveryIntent.id,originalKey=h.owner.recoveryIntent.operationKey;
 const order=(await h.dispatcher.loadPlantingPage('staff')).items[0];await h.dispatcher.commandPlanting({action:'accept',orderId:order.id,expectedOrderVersion:1},'staff');await h.dispatcher.acknowledgePlanting();
 await h.restart();const cold=await h.login();assert.equal(cold.pendingStage,'receipt-review');assert.equal(cold.recoveryIntent.id,originalId);assert.equal(cold.recoveryIntent.receipt.operationKey,originalKey);assert.equal(cold.recoveryIntent.receipt.action,'request');assert.equal((await cold.loadPlantingDetail(order.id)).order.status,'accepted');
 const executions=h.calls.filter(x=>x.url.endsWith('/execute')).length;await cold.retryPending();assert.equal(h.calls.filter(x=>x.url.endsWith('/execute')).length,executions);await cold.acknowledgePlanting();assert.equal(cold.hasPending(),false);assert.equal((await cold.loadPlantingPage()).items.length,1);
});
test('ack lost only retries original id and discovers a newer prepared intent without clearing it',async t=>{
 const h=await fixture(t),receipt=await h.owner.commandPlanting(command),id=h.owner.recoveryIntent.id;h.drop('/ack');await assert.rejects(h.owner.acknowledgePlanting(),{code:'RESULT_UNKNOWN'});assert.equal(h.owner.pendingStage,'ack-unknown');
 const other=await h.login();h.drop('/execute');await assert.rejects(other.commandPlanting({action:'cancel',orderId:receipt.orderId,expectedOrderVersion:1}),{code:'RESULT_UNKNOWN'});const newer=other.recoveryIntent.id;
 // The new intent settled; retrying the old acknowledgement must discover it.
 await h.owner.retryPending();assert.notEqual(newer,id);assert.equal(h.owner.recoveryIntent.id,newer);assert.equal(h.owner.recoveryIntent.receipt.action,'cancel');assert.equal(h.owner.pendingStage,'receipt-review');
});

test('real definitive financial refusal reveals a remote prepared planting intent and leaves safe reads available', async t => {
  const h = await fixture(t), other = await h.login();
  await other.mutate('/cart/items', { sku: 'feed-pack', delta: 1 });
  h.drop('/checkout');
  await assert.rejects(h.owner.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  const original = h.calls.at(-1);
  h.drop('/prepare'); await assert.rejects(other.commandPlanting(command), { code: 'RESULT_UNKNOWN' });
  await h.owner.discoverRecovery(); assert.equal(h.owner.pendingKind, 'assets'); assert.equal(h.owner.recoveryIntent, null);
  await assert.rejects(h.owner.retryPending(), { code: 'REVISION_CONFLICT', status: 409 });
  const retry = h.calls.findLast(request => request.url.endsWith('/checkout'));
  assert.deepEqual(retry, original); assert.equal(h.owner.pendingStage, 'prepared'); assert.equal(h.owner.recoveryIntent.command.action, 'request');
  assert.equal((await h.owner.loadPlantingPage()).items.length, 0); assert.equal((await h.owner.loadPlantingRecord(recordId)).recordId, recordId);
  await assert.rejects(h.owner.mutate('/activities/sign-in'), { code: 'PENDING_OPERATION' });
  await h.owner.abandonPlanting(); assert.equal(h.owner.hasPending(), false);
});
