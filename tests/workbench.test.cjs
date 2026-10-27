const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const W=require('../prototype/workflow.js');
const D=require('../prototype/domain.js');
let B={};try{B=require('../prototype/workbench.js');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture({complete=true,name='胡萝卜',api=B}={}){
 assert.equal(typeof api?.create,'function','workbench adapter must be implemented');
 const state={orders:[W.plan({id:'HJ-0001',cycleId:'round-1',name,product:'carrot',type:'crop',cost:18,target:'A04',status:'pending'},'2026-10-27')],plots:[{id:'A04',cycleId:'round-1',status:'pending'}],wallet:{points:80},signDay:'2026-10-27'};
 let modal=null,clock=Date.parse('2026-10-27T04:00:00Z');const toasts=[];
 const adapter=api.create({state,D,W,esc,icon:()=>'',btn:(a,label,c='',attrs='')=>`<button type="button" data-action="${a}" class="${c}" ${attrs}>${label}</button>`,frame:(title,body)=>`<h2>${title}</h2>${body}`,open:(type,data)=>{modal={type,...data};},close:()=>{modal=null;},navigate:()=>{},render:()=>{},toast:message=>toasts.push(message),targetLabel:()=> '地块4',time:()=>clock,completeOrder:next=>{
  if(!complete)return false;
  if(state.orders[0].status!=='pending'||state.plots[0].status!=='pending'||next.cycleId!==state.plots[0].cycleId)return false;
  state.orders[0]={...next,status:'active'};state.plots[0].status='growing';return true;
 }});
 const act=(action,extra={})=>adapter.handleAction(action,{dataset:{order:'HJ-0001',...extra}});
 const toWorking=()=>{act('w-accept');act('w-assign',{worker:'team-1'});act('w-next-day');act('w-start');};
 return {state,adapter,act,toWorking,toasts,get modal(){return modal;},setClock:value=>{clock=value;}};
}
test('browser window host receives an operable workbench adapter',()=>{
 const window={};vm.runInNewContext(fs.readFileSync(require.resolve('../prototype/workbench.js'),'utf8'),{window});
 assert.equal(typeof window.FarmWorkbench?.create,'function');
 const f=fixture({api:window.FarmWorkbench});assert.match(f.adapter.renderOrders(),/HJ-0001/);
 f.toWorking();f.act('w-complete');f.act('w-confirm-complete');assert.equal(f.state.orders[0].status,'active');assert.equal(f.state.plots[0].status,'growing');
});
test('customer reads progress and record but has no direct staff completion control',()=>{
 const f=fixture(),html=f.adapter.renderOrders();assert.match(html,/HJ-0001/);assert.match(html,/2026-10-28/);assert.match(html,/地块4/);assert.doesNotMatch(html,/data-action="w-(?:accept|assign|start|complete|confirm-complete)"/);assert.match(html,/data-action="w-record"/);
 assert.equal(f.adapter.renderPage('mine'),null);assert.equal(f.adapter.renderModal({type:'other'}),null);assert.equal(f.act('other'),false);
});
test('next-day worker flow preserves array ownership and only confirmed successful completion starts growing',()=>{
 const f=fixture(),owner=f.state.orders;f.act('w-accept');f.act('w-assign',{worker:'team-2'});f.act('w-start');assert.equal(f.state.orders[0].work.status,'assigned');
 assert.match(f.adapter.renderPage('workbench'),/disabled/);f.act('w-next-day');f.act('w-start');assert.equal(f.state.orders[0].work.status,'working');assert.equal(f.state.plots[0].status,'pending');
 f.act('w-complete');assert.equal(f.modal.type,'work-complete');assert.match(f.adapter.renderModal(f.modal),/round-1/);assert.equal(f.state.orders[0].status,'pending');
 f.act('w-confirm-complete');assert.equal(f.state.orders,owner);assert.equal(f.state.orders[0].status,'active');assert.equal(f.state.plots[0].status,'growing');assert.equal(f.state.orders[0].work.history.length,5);
 const done=f.state.orders[0];f.act('w-confirm-complete');assert.equal(f.state.orders[0],done);assert.equal(f.state.wallet.points,80);assert.equal(f.state.signDay,'2026-10-27');
});
test('failed atomic completion leaves order and target unchanged',()=>{
 const f=fixture({complete:false});f.toWorking();f.act('w-complete');const before=structuredClone(f.state);f.act('w-confirm-complete');assert.deepEqual(f.state,before);assert.ok(f.modal);assert.ok(f.toasts.length);
});
test('stale confirmation, forged direct confirm and invalid group cannot complete',()=>{
 const f=fixture();f.act('w-confirm-complete');assert.equal(f.state.orders[0].work.status,'pending');f.act('w-accept');f.act('w-assign',{worker:'team-x'});assert.equal(f.state.orders[0].work.status,'accepted');
 f.act('w-assign',{worker:'team-1'});f.act('w-next-day');f.act('w-start');f.act('w-complete');f.state.orders[0]={...f.state.orders[0],cycleId:'round-2'};const before=structuredClone(f.state);f.act('w-confirm-complete');assert.deepEqual(f.state,before);
});
test('returning to today cannot roll back work dates, and all dynamic text/attributes are escaped',()=>{
 const f=fixture({name:'<img src=x onerror="alert(1)">'});f.toWorking();f.act('w-today');f.act('w-complete');assert.equal(f.modal,null);assert.equal(f.state.orders[0].work.status,'working');
 assert.match(f.adapter.renderOrders(),/&lt;img/);assert.doesNotMatch(f.adapter.renderPage('workbench'),/<img src=x/);f.act('w-record');assert.match(f.adapter.renderModal(f.modal),/&lt;img/);
});
