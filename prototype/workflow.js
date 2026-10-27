/* In-memory staff workflow rules. No farm equipment or production authorization. */
(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.FarmWorkflow=factory();
})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const workers=Object.freeze([Object.freeze({id:'team-1',name:'田园一组'}),Object.freeze({id:'team-2',name:'田园二组'})]);
 const stages=['pending','accepted','assigned','working','completed'];
 const transitions={accept:['pending','accepted'],assign:['accepted','assigned'],start:['assigned','working'],complete:['working','completed']};
 const workerExists=id=>workers.some(w=>w.id===id);
 const dayValue=day=>{
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||day.slice(0,4)==='0000')throw new TypeError('请使用有效的年月日');
  const at=Date.parse(day+'T00:00:00Z');
  if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==day)throw new RangeError('日期不存在');
  return at;
 };
 function nextDay(day){const result=new Date(dayValue(day)+86400000).toISOString().slice(0,10);if(!/^\d{4}-/.test(result))throw new RangeError('日期超出范围');return result;}
 const isOrder=o=>o&&typeof o==='object'&&!Array.isArray(o)&&typeof o.id==='string'&&!!o.id&&['crop','animal'].includes(o.type)&&typeof o.target==='string'&&!!o.target;
 function plan(order,day){
  dayValue(day);
  if(!isOrder(order)||order.status!=='pending'||order.work)throw new TypeError('只可安排尚未作业的待办订单');
  return {...order,work:{status:'pending',plannedDay:nextDay(day),workerId:null,history:[{status:'pending',day,workerId:null}]}};
 }
 function validWork(work){
  if(!work||typeof work!=='object'||!stages.includes(work.status)||!Array.isArray(work.history)||work.history.length!==stages.indexOf(work.status)+1)return false;
  dayValue(work.plannedDay);
  let prior='',assigned=null;
  for(let i=0;i<work.history.length;i++){
   const item=work.history[i];if(!item||item.status!==stages[i])return false;
   dayValue(item.day);if(prior&&item.day<prior)return false;
   if(i===0&&nextDay(item.day)!==work.plannedDay)return false;
   if(i<2&&item.workerId!==null)return false;
   if(i>=2){if(!workerExists(item.workerId))return false;if(i===2)assigned=item.workerId;else if(item.workerId!==assigned)return false;}
   if(i>=3&&item.day<work.plannedDay)return false;
   prior=item.day;
  }
  return work.workerId===assigned;
 }
 function apply(order,action,options){
  const fail=reason=>({ok:false,order,reason});
  if(!isOrder(order))return fail('订单不存在，请返回订单列表');
  const transition=transitions[action];if(!transition)return fail('未知作业操作');
  try{
   dayValue(options?.day);if(!validWork(order.work))return fail('作业记录无效，请重新查看订单');
  }catch(_){return fail('作业日期或记录无效，请重新查看订单');}
  const work=order.work,day=options.day,last=work.history[work.history.length-1];
  if(day<last.day)return fail('演示日期早于已有作业记录，请恢复日期后继续');
  if(options.workerId!==undefined&&(!workerExists(options.workerId)||(action!=='assign'&&options.workerId!==work.workerId)))return fail('请选择本单有效的作业组别');
  if(work.status==='completed'&&action==='complete')return {ok:true,order,reason:'本轮作业已经完成'};
  if(order.status!=='pending')return fail('本轮认养状态已变化，不能继续作业');
  if(work.status!==transition[0])return fail('请按接单、分配、开工、完成的顺序办理');
  if((action==='start'||action==='complete')&&day<work.plannedDay)return fail('尚未到次日作业日期，请到计划日期再开工');
  if(action==='assign'&&!workerExists(options.workerId))return fail('请选择田园一组或田园二组');
  const workerId=action==='assign'?options.workerId:work.workerId;
  const next={...order,work:{...work,status:transition[1],workerId,history:[...work.history.map(item=>({...item})),{status:transition[1],day,workerId}]}};
  return {ok:true,order:next,reason:''};
 }
 return Object.freeze({workers,plan,apply,nextDay});
});
