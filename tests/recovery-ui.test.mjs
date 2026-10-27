import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
const id='a'.repeat(32),time=1793044800000;
const original={id,audience:'customer',command:{action:'request',recordId:'record-001',expectedRecordVersion:1},createdAt:time,receipt:null};
async function ui(extra={}){
 const actions=[],state=vue.reactive({authenticated:true,busy:false,pending:true,snapshot:{environment:'development'},recoveryDiscovery:'open',recoveryStage:'prepared',recoveryIntent:original,...extra});
 const farm={farmState:state,recoveryActionLabel:command=>command.domain==='eggs'?'手动收取鸡蛋':'客户申请',recoveryObjectLabel:command=>command.recordId||command.batchId||command.orderId,farmRecordDate:()=> '2026年10月27日 12:00 北京时间',recoveryResultLabel:receipt=>receipt.eggFormat===1?`原收取已完成，本笔收取 ${receipt.quantity} 枚鸡蛋。`:receipt.outcome==='applied'?'播种申请已保存，等待农场接单。':'农场暂未开放这块田的播种，请联系农场核查。'};
 for(const name of ['retryFarmRecovery','continueFarmRecovery','abandonFarmRecovery','acknowledgeFarmRecovery','retryFarmOperation','openProfile','refreshFarm','openConfirmedCheckout'])farm[name]=()=>actions.push(name);
 const imports={vue,'../core/farm':farm};
 async function component(name){const source=(await readFile(new URL('../apps/mobile/src/components/'+name+'.vue',import.meta.url),'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g,'');const script=compileScript(parse(source).descriptor,{id:name,inlineTemplate:true,templateOptions:{compilerOptions:{isCustomElement:t=>['view','text'].includes(t)}}}).content;const code=ts.transpile(script,{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS});return new Function('require','exports','HTMLElement','document',code+';return exports.default;')(name=>{assert.ok(imports[name],name);return name.endsWith('.vue')?{default:imports[name]}:imports[name];},{},class Element {},{activeElement:null});}
 imports['./FarmButton.vue']=await component('FarmButton');imports['./FarmRecoveryNotice.vue']=await component('FarmRecoveryNotice');imports['./FarmNavigation.vue']=vue.defineComponent({setup:()=>()=>null});
 const renderer=vue.createRenderer({createElement:type=>({type,children:[],props:{}}),createText:text=>({type:'#text',text}),createComment:()=>({type:'#comment'}),setText:(node,text)=>{node.text=text;},setElementText:(node,text)=>{node.text=text;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]||null,patchProp:(n,key,prev,value)=>{n.props[key]=value;},insert:(node,parent,anchor)=>{node.parent=parent;const i=anchor?parent.children.indexOf(anchor):-1;if(i<0)parent.children.push(node);else parent.children.splice(i,0,node);},remove:n=>{if(n?.parent){const i=n.parent.children.indexOf(n);if(i>=0)n.parent.children.splice(i,1);}}});
 const root={children:[]},app=renderer.createApp(await component('FarmScreen'),{title:'合成任意页面',allowGuest:true});app.mount(root);
 const text=n=>(n.text||'')+(n.children||[]).map(text).join(''),nodes=()=>{const result=[];const walk=n=>{result.push(n);(n.children||[]).forEach(walk);};walk(root);return result;};
 return {state,actions,text:()=>text(root),buttons:()=>nodes().filter(n=>n.type==='button'),click:async label=>{const button=nodes().find(n=>n.type==='button'&&text(n)===label);assert.ok(button,label);button.props.onClick({currentTarget:button});await vue.nextTick();},close:()=>app.unmount()};
}
test('actual global screen exposes discovery retry with no operation slot',async()=>{const h=await ui({pending:false,recoveryDiscovery:'error',recoveryStage:null,recoveryIntent:null,recoveryError:'连接未能确认'});try{assert.match(h.text(),/暂不能提交新操作/);await h.click('重新检查上次操作');assert.deepEqual(h.actions,['retryFarmRecovery']);}finally{h.close();}});
test('actual global prepared choices are explicit, preserve object/action and never generic execute retry',async()=>{const h=await ui();try{assert.match(h.text(),/record-001/);assert.match(h.text(),/客户申请/);assert.equal(h.buttons().length,2);await h.click('继续原操作');await h.click('放弃这次未执行操作');assert.deepEqual(h.actions,['continueFarmRecovery','abandonFarmRecovery']);}finally{h.close();}});
test('actual global settled receipt shows human result and time before exact user acknowledgement',async()=>{const h=await ui({recoveryStage:'receipt-review',recoveryIntent:{...original,receipt:{outcome:'applied',code:'OK',completedAt:time}}});try{assert.match(h.text(),/播种申请已保存，等待农场接单/);assert.match(h.text(),/北京时间/);assert.match(h.text(),/当前作业进展可能已变化/);assert.equal(h.actions.length,0);await h.click('已核对结果，继续');assert.deepEqual(h.actions,['acknowledgeFarmRecovery']);}finally{h.close();}});
test('actual global quarantine has manual review message and no self-release action',async()=>{const h=await ui({recoveryStage:'quarantined'});try{assert.match(h.text(),/人工核查/);assert.equal(h.buttons().length,0);}finally{h.close();}});

test('actual global bare open gate always offers a recovery retry without inventing an intent', async () => {
  const h = await ui({ pending: false, recoveryDiscovery: 'open', recoveryStage: null, recoveryIntent: null });
  try { assert.match(h.text(), /还有待核对的原操作/); await h.click('重新检查上次操作'); assert.deepEqual(h.actions, ['retryFarmRecovery']); } finally { h.close(); }
});
test('egg original result remains separate from inventory and asset-sync retry stays global after acknowledgement', async () => {
 const h=await ui({assetSyncRequired:true,recoveryStage:'receipt-review',recoveryIntent:{...original,command:{domain:'eggs',action:'collect',batchId:id,expectedBatchVersion:1,expectedRevision:3},receipt:{eggFormat:1,outcome:'applied',quantity:6,completedAt:time}}});
 try { assert.match(h.text(),/手动收取鸡蛋/); assert.match(h.text(),/本笔收取 6 枚鸡蛋/); assert.match(h.text(),/不能把原数量当作当前库存/); await h.click('已核对结果，继续'); h.state.recoveryIntent=null;h.state.recoveryStage=null;h.state.recoveryDiscovery='clear';h.state.pending=false;await vue.nextTick();assert.match(h.text(),/收蛋结果已确认，资产待同步/);await h.click('重新同步田园资产');assert.deepEqual(h.actions,['acknowledgeFarmRecovery','refreshFarm']); } finally {h.close();}
});
test('actual global open gate explains an existing other-domain pending without offering execute', async () => {
  const h = await ui({ pending: true, recoveryDiscovery: 'open', recoveryStage: null, recoveryIntent: null });
  try { assert.match(h.text(), /先核对当前未确认操作/); assert.equal(h.buttons().some(button => button.children.some(child => child.text === '继续原操作')), false); await h.click('重新检查上次操作'); assert.deepEqual(h.actions, ['retryFarmRecovery']); } finally { h.close(); }
});
