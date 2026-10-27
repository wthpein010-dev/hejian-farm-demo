import test from 'node:test';
import assert from 'node:assert/strict';
import { isForumCommand, isForumContent, isForumCommandReceipt, isForumPage, isForumReport, isModerationBatch, isModerationQueue } from '../../../shared/forum.mjs';
const ID='a'.repeat(32),PEER='b'.repeat(32),OWNER='synthetic-wire-account';
const content=()=>({id:ID,kind:'post',parentId:null,circle:'chat',author:{peerId:PEER,alias:'农友bbbbbbbb',self:false},title:'合成严格标题',body:'合成严格正文内容。',state:'published',version:2,createdAt:1,updatedAt:2,publishedAt:2,reasonCode:null});
const report=()=>({id:'c'.repeat(32),contentId:ID,kind:'post',reason:'spam',status:'open',resolution:null,version:1,createdAt:3,resolvedAt:null});

test('text command limits use Unicode code points, reject controls and bidi, and never invoke accessor properties',()=>{
  const v={action:'submit-post',circle:'chat',title:'🌾'.repeat(40),body:'🌾'.repeat(600)};assert.equal(isForumCommand(v),true);
  for(const bad of [{...v,title:'🌾'.repeat(41)},{...v,body:'🌾'.repeat(601)},{...v,title:'未满字'},{...v,body:'正文\t控制'},{...v,body:'正文\u202e控制'},{...v,body:'正文\ud800控制'},{...v,title:'  合成标题  '},{...v,ownerId:OWNER}])assert.equal(isForumCommand(bad),false);
  let reads=0;const accessor={...v};Object.defineProperty(accessor,'body',{enumerable:true,get(){reads++;return v.body;}});assert.equal(isForumCommand(accessor),false);assert.equal(reads,0);
  const forged=Object.create({action:'submit-post'});Object.assign(forged,{circle:'chat',title:'合成严格标题',body:'合成严格正文内容。'});assert.equal(isForumCommand(forged),false);
});

test('wire projections reject unreviewed public content, wrong scope, duplicate IDs, unsafe tombstones and impossible versions',()=>{
  const p={forumFormat:1,ownerId:OWNER,environment:'development',serverTime:3,scope:'public',circle:'all',items:[content()],nextCursor:null};assert.equal(isForumPage(p,OWNER,'development','public','all'),true);
  assert.equal(isForumPage(p,'another-account','development'),false);assert.equal(isForumPage({...p,items:[content(),content()]},OWNER,'development'),false);
  assert.equal(isForumPage({...p,items:[{...content(),state:'pending',version:1,publishedAt:null}]},OWNER,'development'),false);
  assert.equal(isForumContent({...content(),state:'withdrawn',version:3,title:'',body:''}),true);
  assert.equal(isForumContent({...content(),state:'withdrawn',version:3}),false);
  assert.equal(isForumContent({...content(),state:'pending',version:99,publishedAt:null}),false);
});

test('minimal command receipts bind account, environment, original key and action without any UGC fields',()=>{
  const v={forumFormat:1,ownerId:OWNER,environment:'development',operationKey:'forum-wire-key',action:'submit-post',outcome:'applied',code:'OK',contentId:ID,completedAt:2};
  assert.equal(isForumCommandReceipt(v,OWNER,'development','forum-wire-key','submit-post'),true);
  for(const bad of [{...v,body:'PRIVATE CONTENT'},{...v,ownerId:'other'},{...v,operationKey:'different-key'},{...v,action:'withdraw'},{...v,environment:'production'},{...v,outcome:'refused'},{...v,contentId:null}])assert.equal(isForumCommandReceipt(bad,OWNER,'development','forum-wire-key','submit-post'),false);
});

test('private moderation requires exact parent context and both report and target versions',()=>{
  const c={...content(),id:'d'.repeat(32),kind:'comment',parentId:ID,title:'',body:'合成评论',state:'pending',version:1,publishedAt:null,updatedAt:1};
  const queue={formatVersion:1,environment:'development',serverTime:3,contentState:'pending',contents:[c],reports:[{...report(),content:content()}],parents:[content()]};assert.equal(isModerationQueue(queue),true);
  assert.equal(isModerationQueue({...queue,parents:[]}),false);assert.equal(isModerationQueue({...queue,parents:[content(),content()]}),false);
  assert.equal(isModerationQueue({...queue,contentState:'published'}),false);assert.equal(isModerationQueue({...queue,contentState:'withdrawn'}),false);
  assert.equal(isModerationQueue({...queue,contentState:'published',contents:[content()],parents:[]}),true);
  const batch={formatVersion:1,batchId:'moderation-wire-batch',operatorId:'synthetic-op',decisions:[{kind:'report',id:'c'.repeat(32),expectedVersion:1,expectedContentVersion:2,decision:'hide',reason:'spam'}]};assert.equal(isModerationBatch(batch),true);
  const {expectedContentVersion:omitted,...old}=batch.decisions[0];assert.equal(isModerationBatch({...batch,decisions:[old]}),false);
  assert.equal(isModerationBatch({...batch,decisions:[{...batch.decisions[0],body:'PRIVATE CONTENT'}]}),false);
});

test('a resolved report has exactly one transition and a moderation queue never re-exposes withdrawn content',()=>{
  assert.equal(isForumReport({...report(),status:'resolved',resolution:'dismissed',version:2,resolvedAt:4}),true);
  assert.equal(isForumReport({...report(),status:'resolved',resolution:'dismissed',version:99,resolvedAt:4}),false);
  const queue={formatVersion:1,environment:'development',serverTime:4,contentState:'pending',contents:[],reports:[{...report(),content:{...content(),state:'withdrawn',version:3,title:'',body:''}}],parents:[]};
  assert.equal(isModerationQueue(queue),false);
});
