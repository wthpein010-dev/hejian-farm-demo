const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
let W={};
try { W=require('../prototype/workflow.js'); } catch(e) { if(e.code!=='MODULE_NOT_FOUND')throw e; }
const order=(extra={})=>({id:'HJ-0001',name:'胡萝卜',product:'carrot',type:'crop',cost:18,target:'A04',status:'pending',cycleId:'HJ-0001',...extra});
function call(name,...args){assert.equal(typeof W[name],'function',`${name} must be implemented`);return W[name](...args);}
function advance(o,action,day='2026-10-27',workerId){const r=call('apply',o,action,{day,workerId});assert.equal(r.ok,true,r.reason);return r.order;}
function assigned(){return advance(advance(call('plan',order(),'2026-10-27'),'accept'),'assign','2026-10-27','team-1');}

test('browser host receives workflow when window is separate from globalThis',()=>{
 const window={},sandbox={window};vm.runInNewContext(fs.readFileSync(require.resolve('../prototype/workflow.js'),'utf8'),sandbox);
 assert.equal(typeof window.FarmWorkflow?.plan,'function');
 const planned=window.FarmWorkflow.plan(order(),'2026-10-27'),accepted=window.FarmWorkflow.apply(planned,'accept',{day:'2026-10-27'});
 assert.equal(accepted.ok,true);assert.equal(accepted.order.work.status,'accepted');assert.equal(accepted.order.work.plannedDay,'2026-10-28');
});

test('strict calendar handles month/year/leap boundaries without normalizing invalid dates',()=>{
 for(const [day,want] of [['2026-10-31','2026-11-01'],['2026-12-31','2027-01-01'],['2028-02-28','2028-02-29'],['2028-02-29','2028-03-01'],['2026-02-28','2026-03-01']])assert.equal(call('nextDay',day),want);
 for(const day of ['2026-02-29','2026-04-31','2026-1-01','2026-01-00','0000-01-01','9999-12-31','2026-01-01T00:00:00Z',null,NaN])assert.throws(()=>call('nextDay',day));
});
test('planning preserves order and creates a separate pending T+1 record',()=>{
 const o=order(),before=structuredClone(o),p=call('plan',o,'2026-10-27');
 assert.deepEqual(o,before);assert.notEqual(p,o);assert.equal(p.work.status,'pending');assert.equal(p.work.plannedDay,'2026-10-28');assert.equal(p.work.workerId,null);
 for(const key of Object.keys(o))assert.deepEqual(p[key],o[key]);
 assert.deepEqual(p.work.history,[{status:'pending',day:'2026-10-27',workerId:null}]);
 assert.throws(()=>call('plan',order({status:'active'}),'2026-10-27'));assert.throws(()=>call('plan',order({type:'unknown'}),'2026-10-27'));
 assert.throws(()=>call('plan',p,'2026-10-27'));
});
test('work must be accepted, assigned and started on or after planned day before completion',()=>{
 const planned=call('plan',order(),'2026-10-27');
 for(const action of ['assign','start','complete'])assert.equal(call('apply',planned,action,{day:'2026-10-28',workerId:'team-1'}).ok,false);
 const accepted=advance(planned,'accept');assert.equal(call('apply',accepted,'assign',{day:'2026-10-27',workerId:'team-3'}).ok,false);
 const a=advance(accepted,'assign','2026-10-27','team-2'),before=structuredClone(a);
 for(const action of ['start','complete'])assert.equal(call('apply',a,action,{day:'2026-10-27'}).ok,false);
 assert.equal(call('apply',a,'complete',{day:'2026-10-28'}).ok,false);
 const started=advance(a,'start','2026-10-28'),done=advance(started,'complete','2026-10-28');
 assert.deepEqual(a,before);assert.equal(done.status,'pending');assert.equal(done.target,'A04');assert.equal(done.cycleId,'HJ-0001');assert.equal(done.work.status,'completed');assert.equal(done.work.workerId,'team-2');
 assert.deepEqual(done.work.history.map(x=>x.status),['pending','accepted','assigned','working','completed']);assert.notEqual(done.work.history,started.work.history);
 const repeated=call('apply',done,'complete',{day:'2026-10-28'});assert.equal(repeated.ok,true);assert.equal(repeated.order,done);assert.equal(repeated.order.work.history.length,5);
});
test('invalid commands, backward dates and changed orders cannot progress or mutate history',()=>{
 const a=assigned(),working=advance(a,'start','2026-10-29');
 for(const [o,action,options] of [[a,'start',{day:'2026-02-30'}],[working,'complete',{day:'2026-10-28'}],[a,'start',{day:'2026-10-28',workerId:'team-2'}],[a,'destroy',{day:'2026-10-28'}],[{...a,status:'harvested'},'start',{day:'2026-10-28'}],[{...a,work:{...a.work,workerId:'team-x'}},'start',{day:'2026-10-28'}]]){
  const before=structuredClone(o),r=call('apply',o,action,options);assert.equal(r.ok,false);assert.equal(r.order,o);assert.equal(typeof r.reason,'string');assert.deepEqual(o,before);
 }
 assert.equal(call('apply',null,'accept',{day:'2026-10-27'}).ok,false);
});
test('animal orders use the same next-day process without changing active animal state',()=>{
 let o=call('plan',order({type:'animal',target:'N02',product:'chicken',name:'散养鸡'}),'2026-10-27');
 for(const [action,day,worker] of [['accept','2026-10-27'],['assign','2026-10-27','team-1'],['start','2026-10-28'],['complete','2026-10-28']])o=advance(o,action,day,worker);
 assert.equal(o.status,'pending');assert.equal(o.type,'animal');assert.equal(o.target,'N02');assert.equal(o.work.status,'completed');
});
