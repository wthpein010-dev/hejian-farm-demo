/* Staff demonstration adapter. App owns orders, target cycles, the shared dialog and farm effects. */
(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.FarmWorkbench=factory();
})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 function create(ctx){
  const {state,D,W,esc,icon,btn}=ctx;
  let tomorrow=false,confirmation=null;
  const stages={pending:'待接单',accepted:'已接单 · 待分配',assigned:'已分配 · 待开工',working:'作业中',completed:'作业已完成'};
  const events={pending:'创建订单，等待接单',accepted:'工作人员演示接单',assigned:'分配作业组别',working:'开始本轮作业',completed:'确认本轮作业完成'};
  const getDay=()=>{const day=D.chinaDayKey(ctx.time());return tomorrow?W.nextDay(day):day;};
  const find=id=>state.orders.find(o=>o.id===id);
  const cycle=o=>o.cycleId||o.id;
  const workerName=id=>W.workers.find(w=>w.id===id)?.name||'尚未分配';
  const operation=o=>o.type==='animal'?'入栏':'播种';
  const attr=o=>`data-order="${esc(o.id)}"`;
  const notice=()=>`<div class="work-notice">${icon('shield')}<p>工作人员演示 · 所有办理仅在本页模拟，刷新后重置。未连接真实工作人员、农场作业或设备。</p></div>`;
  const back=()=>btn('mine',icon('back')+'返回我的','back-button');
  const heading=(title,copy)=>`<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(copy)}</p></div></div>`;
  const stage=o=>o.status==='harvested'?'本轮已完成收获':o.work?stages[o.work.status]||'记录待核对':o.status==='active'?'已'+operation(o):'等待作业安排';
  function facts(o){
   const rows=[['订单编号',o.id],['地块／圈舍',ctx.targetLabel(o.target)],['认养轮次',cycle(o)],['示例认养金额',`¥${o.cost}（无真实付款）`],['次日作业（T+1）',o.work?.plannedDay||'早期示例，未记录日期'],['作业组别',workerName(o.work?.workerId)]];
   return `<dl class="work-facts">${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
  }
  function timeline(o){
   if(!o.work?.history?.length)return '<p class="work-helper">此早期示例没有作业时间线。</p>';
   return `<ol class="work-timeline" aria-label="作业时间线（北京时间日期）">${o.work.history.map((h,index)=>`<li><span class="work-step" aria-hidden="true">${esc(index+1)}</span><div><strong>${esc(events[h.status]||'记录待核对')}</strong><p><time datetime="${esc(h.day)}">${esc(h.day)}</time> · ${esc(h.workerId?workerName(h.workerId):'本页演示')}</p></div></li>`).join('')}</ol>`;
  }
  function controls(o){
   if(o.status!=='pending'||!o.work)return '';
   if(o.work.status==='pending')return btn('w-accept','演示接单','primary-button full',attr(o));
   if(o.work.status==='accepted')return `<div class="work-assign" role="group" aria-label="${esc(o.name)}的作业组别">${W.workers.map(w=>btn('w-assign','分配'+esc(w.name),'outline-button',`${attr(o)} data-worker="${esc(w.id)}"`)).join('')}</div>`;
   const action=o.work.status==='assigned'?'start':o.work.status==='working'?'complete':null;
   if(!action)return '';
   const check=W.apply(o,action,{day:getDay()}),label=action==='start'?'演示开始'+operation(o):'确认'+operation(o)+'完成';
   return `${btn('w-'+action,esc(label),'primary-button full',`${attr(o)} ${check.ok?'':'disabled aria-disabled="true"'}`)}${check.ok?'':`<p class="work-constraint">${esc(check.reason)}</p>`}`;
  }
  function card(o,staff){
   return `<article class="work-card"><div class="work-card-heading"><div><p class="work-kicker">${esc(o.type==='animal'?'入栏作业':'种植作业')}</p><h2>${esc(o.name)}</h2></div><span class="work-status">${esc(stage(o))}</span></div>${facts(o)}${staff?timeline(o):`<p class="work-helper">${esc(o.status==='pending'?'接单、分配和次日作业完成后，才可进入照料。':o.status==='harvested'?'本轮已归档，可查看收货进度。':'本轮已进入种养周期，可返回农场照料。')}</p>`}<div class="work-actions">${staff?controls(o):o.status==='active'?btn('go-target','查看我的认养','primary-button full',`data-id="${esc(o.target)}"`):o.status==='harvested'?btn('deliveries','查看收货进度','outline-button full'):''}${btn('w-record','查看作业记录','outline-button full',attr(o))}</div></article>`;
  }
  function renderOrders(){
   return `${back()}${heading('我的认养订单','查看品种、次日安排和工作人员演示进度。')}${notice()}<p class="work-helper">示例认养金额仅作展示，没有真实付款。作业状态与真实农场执行无关。</p>${state.orders.length?state.orders.map(o=>card(o,false)).join(''):`<div class="empty">${icon('seed')}<h2>先选一份田园认养</h2><p>选择品种与空闲地块后，可在这里查看安排。</p>${btn('adopt-shop','选择认养品种','primary-button')}</div>`}${btn('workbench','进入工作人员演示区','outline-button full')}`;
  }
  function renderPage(view){
   if(view!=='workbench')return null;
   const pending=state.orders.filter(o=>o.status==='pending').length;
   return `${back()}${heading('工作人员演示区','接单、分组，按次日计划完成播种或入栏。')}${notice()}<section class="work-day-panel" aria-label="作业演示日期"><p class="work-kicker">当前作业演示日（北京时间）</p><strong><time datetime="${esc(getDay())}">${esc(getDay())}</time></strong><p>${esc(tomorrow?'正在体验次日办理。':'当前为今天，下单当天不能开工。')}只改变本区作业日期，不改变签到、钱包或照料时间。</p>${btn(tomorrow?'w-today':'w-next-day',tomorrow?'返回今天查看':'体验次日办理','outline-button full')}</section><div class="work-list-heading"><h2>作业安排</h2><span>${esc(pending)} 笔待办理</span></div>${state.orders.length?state.orders.map(o=>card(o,true)).join(''):`<div class="empty"><h2>目前没有作业单</h2><p>先选择认养品种并创建演示订单。</p>${btn('adopt-shop','选择认养品种','primary-button')}</div>`}`;
  }
  function renderModal(m){
   if(!m||!['work-complete','work-record'].includes(m.type))return null;
   const o=find(m.orderId);if(!o)return ctx.frame('作业记录',`<p class="work-constraint">订单不存在，请返回列表查看。</p>${btn('close','关闭','outline-button full')}`);
   if(m.type==='work-record')return ctx.frame('作业记录',`<div class="work-modal"><h3>${esc(o.name)} · ${esc(stage(o))}</h3>${facts(o)}${timeline(o)}${notice()}${btn('close','关闭记录','outline-button full')}</div>`);
   const valid=confirmation&&confirmation.orderId===o.id&&confirmation.work===o.work&&confirmation.cycleId===cycle(o)&&W.apply(o,'complete',{day:getDay()}).ok;
   return ctx.frame('确认'+operation(o)+'完成',`<div class="work-modal"><h3>${esc(o.name)} · ${esc(ctx.targetLabel(o.target))}</h3>${facts(o)}<p class="work-helper">本页确认后，该轮认养进入照料；这是工作人员办理演示，不会向真实农场或设备发送指令。</p>${valid?'':'<p class="work-constraint">作业状态或日期已变化，请关闭后重新查看。</p>'}<div class="work-actions">${btn('close','返回核对','outline-button full')}${btn('w-confirm-complete','确认本轮'+operation(o)+'完成','primary-button full',`${attr(o)} ${valid?'':'disabled'}`)}</div></div>`);
  }
  function handleAction(action,target){
   if(!['w-next-day','w-today','w-accept','w-assign','w-start','w-complete','w-confirm-complete','w-record'].includes(action))return false;
   if(action==='w-next-day'||action==='w-today'){confirmation=null;tomorrow=action==='w-next-day';ctx.render();ctx.toast(tomorrow?'已切到次日作业演示，签到与资产日期不变':'已返回今天查看作业');return true;}
   const id=target?.dataset?.order,o=find(id);
   if(!o){ctx.toast('订单不存在，请返回订单列表');return true;}
   if(action==='w-record'){confirmation=null;ctx.open('work-record',{orderId:o.id});return true;}
   if(action==='w-confirm-complete'){
    if(!confirmation||confirmation.orderId!==o.id||confirmation.cycleId!==cycle(o)||confirmation.work!==o.work){ctx.toast('本轮作业状态已变化，请重新核对');return true;}
    const result=W.apply(o,'complete',{day:getDay()});
    if(!result.ok||o.status!=='pending'||o.work.status!=='working'){ctx.toast(result.reason||'本轮作业不能重复完成');return true;}
    if(!ctx.completeOrder(result.order)){ctx.toast('本轮地块或圈舍状态已变化，请关闭后核对订单');return true;}
    confirmation=null;ctx.close();ctx.render();ctx.toast('本页'+operation(o)+'演示已完成，可以查看照料');return true;
   }
   const command={'w-accept':'accept','w-assign':'assign','w-start':'start','w-complete':'complete'}[action];
   const result=W.apply(o,command,{day:getDay(),...(action==='w-assign'?{workerId:target?.dataset?.worker}:{})});
   if(!result.ok){ctx.toast(result.reason);return true;}
   if(action==='w-complete'){
    if(o.status!=='pending'||o.work.status!=='working'){ctx.toast('本轮作业已经办理，请查看记录');return true;}
    confirmation={orderId:o.id,cycleId:cycle(o),work:o.work};ctx.open('work-complete',{orderId:o.id,cycleId:cycle(o)});return true;
   }
   confirmation=null;const index=state.orders.indexOf(o);if(index>=0)state.orders[index]=result.order;
   ctx.render();ctx.toast(action==='w-accept'?'演示已接单，请分配作业组':action==='w-assign'?'已分配'+workerName(result.order.work.workerId):'本页作业演示已开工');return true;
  }
  const onClose=()=>{confirmation=null;};
  return {renderPage,renderOrders,renderModal,handleAction,onClose,navOwner:view=>view==='workbench'?'mine':null,titles:{workbench:'工作人员演示区'}};
 }
 return Object.freeze({create});
});
