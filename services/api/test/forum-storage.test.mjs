import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createBackup, verifyBackup, restoreBackup, inspectApplicationDatabase } from '../tools/sqlite-backup.mjs';
const NOW = Date.parse('2026-10-27T04:00:00Z');
const config = file => normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-forum-')), file = path.join(directory, 'source', 'farm.sqlite');
  await mkdir(path.dirname(file));
  let instant = NOW, store = new FarmStore({ ...config(file), clock: () => instant }), n = 0;
  const a = store.createIdentity('development', 'forum-storage-a', store.serverNow()), b = store.createIdentity('development', 'forum-storage-b', store.serverNow());
  for (const auth of [a,b]) store.friendCommand(auth.profile.id, `enable-forum-${++n}`, { action: 'enable', expectedVersion: 0 }, NOW);
  const cmd = (auth, body, key = `forum-store-${++n}`) => store.forumCommand(auth.profile.id, key, body, store.serverNow());
  const post = (auth = a) => cmd(auth, { action: 'submit-post', circle: 'chat', title: '合成论坛标题', body: '合成论坛正文，仅用于测试。' });
  const batch = decisions => ({ formatVersion: 1, batchId: `moderate-store-${++n}`, operatorId: 'synthetic-operator', decisions });
  const approve = p => store.applyForumModeration(batch([{ kind: 'content', id: p.contentId, expectedVersion: 1, decision: 'approve', reason: 'other' }]), store.serverNow());
  const db = work => { const d = new DatabaseSync(file); try { return work(d); } finally { d.close(); } };
  t.after(async () => { store.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('farm-forum-')); await rm(directory, { recursive: true, force: true }); });
  return { a,b,file,directory,cmd,post,batch,approve,db, setTime(value){instant=value;store.serverNow();}, get store(){return store;}, reopen(){store.close(); store=new FarmStore({ ...config(file), clock: () => instant });} };
}
async function rehash(directory) { const bytes = await readFile(path.join(directory, 'farm.sqlite')), file = path.join(directory, 'manifest.json'), m = JSON.parse(await readFile(file, 'utf8')); Object.assign(m,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}); await writeFile(file,JSON.stringify(m)); }

test('forum backup and isolated restore preserve minimal original receipts and audit metadata while revoking sessions', async t => {
  const f=await fixture(t), body={action:'submit-post',circle:'chat',title:'合成原回执标题',body:'合成原回执正文资料。'}, key='forum-original-unreceived';
  const p=f.cmd(f.a,body,key);f.approve(p);const before=f.store.bootstrap(f.a.profile.id,NOW);
  const backup=path.join(f.directory,'backup'), out=path.join(f.directory,'restored');
  assert.equal(inspectApplicationDatabase(f.file),9);assert.equal((await createBackup({databasePath:f.file,outputDirectory:backup})).schemaVersion,9);
  await restoreBackup({backupDirectory:backup,outputDirectory:out});
  const restored=new FarmStore(config(path.join(out,'farm.sqlite')));
  try {assert.equal(restored.authenticate(f.a.token,NOW),null);assert.deepEqual(restored.forumCommand(f.a.profile.id,key,body,NOW),p);assert.equal(restored.forumPage(f.b.profile.id,'all','start',NOW).items.length,1);assert.deepEqual(restored.bootstrap(f.a.profile.id,NOW),before);}finally{restored.close();}
  f.db(d=>{const r=d.prepare('SELECT * FROM forum_moderation').get();assert.equal(r.operator_id,'synthetic-operator');assert.equal(JSON.parse(r.decisions_json)[0].id,p.contentId);const all=JSON.stringify(d.prepare('SELECT * FROM forum_commands').all());assert.equal(all.includes(body.title),false);assert.equal(all.includes(body.body),false);});
});

test('receipt storage failure rolls back content, daily quota and stranger block together',async t=>{
  const f=await fixture(t);f.db(d=>d.exec("CREATE TRIGGER fail_forum_receipt BEFORE INSERT ON forum_commands WHEN NEW.key='faulted-forum-operation' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"));
  const body={action:'submit-post',circle:'chat',title:'合成失败标题',body:'合成失败正文内容。'};
  assert.throws(()=>f.cmd(f.a,body,'faulted-forum-operation'));assert.equal(f.store.forumMine(f.a.profile.id,'start',NOW).items.length,0);assert.equal(f.store.forumStatus(f.a.profile.id,NOW).usage.posts,0);
  f.db(d=>d.exec('DROP TRIGGER fail_forum_receipt'));const p=f.cmd(f.a,body,'faulted-forum-operation');f.approve(p);
  f.db(d=>d.exec("CREATE TRIGGER fail_forum_receipt BEFORE INSERT ON forum_commands WHEN NEW.key='faulted-forum-block' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"));
  const before=f.store.friendsView(f.b.profile.id,NOW);assert.throws(()=>f.cmd(f.b,{action:'block-author',contentId:p.contentId,expectedVersion:2},'faulted-forum-block'));
  assert.deepEqual(f.store.friendsView(f.b.profile.id,NOW),before);assert.equal(f.store.forumPage(f.b.profile.id,'all','start',NOW).items.length,1);
});

test('whole moderation batch rolls back first approval when a later decision is stale; original successful batch never re-executes',async t=>{
  const f=await fixture(t),p=f.post(),q=f.post();
  const batch=f.batch([{kind:'content',id:p.contentId,expectedVersion:1,decision:'approve',reason:'other'},{kind:'content',id:q.contentId,expectedVersion:2,decision:'approve',reason:'other'}]);
  assert.throws(()=>f.store.applyForumModeration(batch,NOW));assert.equal(f.store.forumDetail(f.a.profile.id,p.contentId,'start',NOW).post.state,'pending');
  batch.decisions[1].expectedVersion=1;const original=f.store.applyForumModeration(batch,NOW);assert.equal(original.applied,2);
  f.cmd(f.a,{action:'withdraw',contentId:p.contentId,expectedVersion:2});
  assert.equal(f.store.applyForumModeration(batch,NOW).replayed,true);assert.equal(f.store.forumDetail(f.a.profile.id,p.contentId,'start',NOW).post.state,'withdrawn');
  assert.throws(()=>f.store.applyForumModeration({...batch,operatorId:'other-operator'},NOW));
});

test('account deletion removes own content, child comments, reports and all author mappings but keeps irreversible audit and foreign minimal receipts',async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);const c=f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'合成子评论'});f.approve(c);
  f.cmd(f.b,{action:'report',contentId:p.contentId,expectedVersion:2,reason:'privacy'});
  const ownOther=f.post(f.b);f.approve(ownOther);f.cmd(f.a,{action:'submit-comment',postId:ownOther.contentId,expectedVersion:2,body:'合成其他帖子评论'});
  const prep=f.store.prepareDeletion(f.a.profile.id,f.a.token,0,NOW);assert.equal(f.store.confirmDeletion(prep.data.confirmationToken,NOW).status,200);
  assert.equal(f.store.forumReports(f.b.profile.id,'start',NOW).items.length,0);assert.equal(f.store.forumMine(f.b.profile.id,'start',NOW).items.length,1);
  f.db(d=>{for(const table of ['forum_content','forum_usage','forum_reports','forum_commands']) assert.equal(d.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=?`).get(f.a.profile.id).n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM forum_content WHERE parent_id=?').get(p.contentId).n,0);});
  await createBackup({databasePath:f.file,outputDirectory:path.join(f.directory,'after-delete')});
});

test('two connections preserve original key results and cannot withdraw a newer version',async t=>{
  const f=await fixture(t),body={action:'submit-post',circle:'chat',title:'合成并发标题',body:'合成并发正文内容。'}, key='two-connection-forum-key';
  const second=new FarmStore(config(f.file));try{const p=f.cmd(f.a,body,key);assert.deepEqual(second.forumCommand(f.a.profile.id,key,body,NOW),p);f.approve(p);assert.equal(second.forumCommand(f.a.profile.id,'stale-withdraw-key',{action:'withdraw',contentId:p.contentId,expectedVersion:1},NOW).code,'CONTENT_CHANGED');assert.equal(second.forumMine(f.a.profile.id,'start',NOW).items.length,1);}finally{second.close();}
});

test('a report exported before hide and restore cannot hide the newly restored content version',async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);f.cmd(f.b,{action:'report',contentId:p.contentId,expectedVersion:2,reason:'spam'});
  const queued=f.store.forumModerationQueue(NOW).reports[0];
  f.store.applyForumModeration(f.batch([{kind:'content',id:p.contentId,expectedVersion:2,decision:'hide',reason:'other'}]),NOW);
  f.store.applyForumModeration(f.batch([{kind:'content',id:p.contentId,expectedVersion:3,decision:'restore',reason:'other'}]),NOW);
  assert.throws(()=>f.store.applyForumModeration(f.batch([{kind:'report',id:queued.id,expectedVersion:1,expectedContentVersion:2,decision:'hide',reason:'spam'}]),NOW),e=>e.code==='CONTENT_CHANGED');
  assert.equal(f.store.forumDetail(f.a.profile.id,p.contentId,'start',NOW).post.state,'published');
});

test('operators can reject pending comments and hide published comments while their parent is hidden',async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);
  const c=f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'合成待拒评论'}),d=f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'合成待隐藏评论'});f.approve(d);
  f.store.applyForumModeration(f.batch([{kind:'content',id:p.contentId,expectedVersion:2,decision:'hide',reason:'other'}]),NOW);
  assert.equal(f.store.applyForumModeration(f.batch([{kind:'content',id:c.contentId,expectedVersion:1,decision:'reject',reason:'other'},{kind:'content',id:d.contentId,expectedVersion:2,decision:'hide',reason:'other'}]),NOW).applied,2);
  assert.throws(()=>f.store.applyForumModeration(f.batch([{kind:'content',id:d.contentId,expectedVersion:3,decision:'restore',reason:'other'}]),NOW));
});

test('a second valid report can resolve an already hidden target without hiding it again or changing its version',async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);
  const c=f.store.createIdentity('development','forum-report-another',NOW);f.store.friendCommand(c.profile.id,'enable-report-another',{action:'enable',expectedVersion:0},NOW);
  for(const auth of[f.b,c])f.cmd(auth,{action:'report',contentId:p.contentId,expectedVersion:2,reason:'abuse'});
  const first=f.store.forumReports(f.b.profile.id,'start',NOW).items[0],second=f.store.forumReports(c.profile.id,'start',NOW).items[0];
  f.store.applyForumModeration(f.batch([{kind:'report',id:first.id,expectedVersion:1,expectedContentVersion:2,decision:'hide',reason:'abuse'}]),NOW);
  assert.equal(f.store.applyForumModeration(f.batch([{kind:'report',id:second.id,expectedVersion:1,expectedContentVersion:3,decision:'hide',reason:'abuse'}]),NOW).applied,1);
  assert.equal(f.store.forumDetail(f.a.profile.id,p.contentId,'start',NOW).post.version,3);
  assert.equal(f.store.forumReports(c.profile.id,'start',NOW).items[0].resolution,'hidden');
});

test('operator queues select current published and hidden versions for hide and restore while retaining independent open reports',async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);
  f.cmd(f.b,{action:'report',contentId:p.contentId,expectedVersion:2,reason:'spam'});
  const published=f.store.forumModerationQueue(NOW,'published');assert.equal(published.contentState,'published');assert.equal(published.contents[0].id,p.contentId);assert.equal(published.contents[0].version,2);assert.equal(published.reports.length,1);
  f.store.applyForumModeration(f.batch([{kind:'content',id:p.contentId,expectedVersion:published.contents[0].version,decision:'hide',reason:'spam'}]),NOW);
  const hidden=f.store.forumModerationQueue(NOW,'hidden');assert.equal(hidden.contentState,'hidden');assert.equal(hidden.contents[0].state,'hidden');assert.equal(hidden.contents[0].version,3);assert.equal(hidden.reports.length,1);
  f.store.applyForumModeration(f.batch([{kind:'content',id:p.contentId,expectedVersion:hidden.contents[0].version,decision:'restore',reason:'other'}]),NOW);
  assert.equal(f.store.forumModerationQueue(NOW,'published').contents[0].version,4);assert.equal(f.store.forumModerationQueue(NOW,'hidden').contents.length,0);
  assert.equal(f.store.forumModerationQueue(NOW).contentState,'pending');
  for(const state of ['withdrawn','all','',null,{},'published\n'])assert.throws(()=>f.store.forumModerationQueue(NOW,state),e=>e.code==='INVALID_MODERATION_STATE');
});

test('public, own and comment pages filter before keyset pagination and reject a now-inaccessible cursor',async t=>{
  const f=await fixture(t), ids=[];
  for(let i=0;i<25;i++){f.setTime(NOW+Math.floor(i/10)*86400000+i);const p=f.post();f.approve(p);ids.push(p.contentId);}
  const now=f.store.serverNow(), first=f.store.forumPage(f.b.profile.id,'all','start',now);assert.equal(first.items.length,20);assert.equal(first.nextCursor,first.items.at(-1).id);
  const second=f.store.forumPage(f.b.profile.id,'all',first.nextCursor,now);assert.equal(second.items.length,5);assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,25);
  assert.throws(()=>f.store.forumMine(f.b.profile.id,first.nextCursor,now));
  f.cmd(f.b,{action:'block-author',contentId:first.items[0].id,expectedVersion:2});
  assert.deepEqual(f.store.forumPage(f.b.profile.id,'all','start',now).items,[]);assert.throws(()=>f.store.forumPage(f.b.profile.id,'all',first.nextCursor,now));
  assert.equal(f.store.forumMine(f.a.profile.id,'start',now).items.length,20);
});

test('daily comment and report quotas reset only at the server Shanghai day; active content remains bounded across days',async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);
  for(let i=0;i<50;i++)assert.equal(f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'合成额度评论'}).outcome,'applied');
  assert.equal(f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'超限评论'}).code,'DAILY_COMMENT_LIMIT');
  for(let i=0;i<20;i++){f.setTime(NOW+(i+1)*86400000);const target=f.post();f.approve(target);}
  const targets=f.store.forumPage(f.b.profile.id,'all','start',f.store.serverNow()).items;
  for(const target of targets)assert.equal(f.cmd(f.b,{action:'report',contentId:target.id,expectedVersion:2,reason:'spam'}).outcome,'applied');
  assert.equal(f.cmd(f.b,{action:'report',contentId:p.contentId,expectedVersion:2,reason:'spam'}).code,'DAILY_REPORT_LIMIT');
  f.setTime(NOW+21*86400000);assert.equal(f.cmd(f.b,{action:'report',contentId:p.contentId,expectedVersion:2,reason:'spam'}).outcome,'applied');
  for(let d=22;d<25;d++){f.setTime(NOW+d*86400000);for(let i=0;i<50;i++)assert.equal(f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'合成累计评论'}).outcome,'applied');}
  f.setTime(NOW+25*86400000);assert.equal(f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'累计超限评论'}).code,'ACTIVE_LIMIT');
});

for(const environment of ['development','production'])test(`backup and replay reject an applied forum receipt attributed to a platform identity in ${environment}`,async t=>{
  const f=await fixture(t), store=new FarmStore(normalizeConfig({databasePath:f.file,mode:environment,clock:()=>NOW}));
  try{const a=store.createIdentity('weixin','synthetic-forged-forum',NOW),body={action:'submit-post',circle:'chat',title:'合成越权标题',body:'合成越权正文内容。'},key='forged-platform-forum';
    assert.equal(store.forumCommand(a.profile.id,key,body,NOW).code,'FORUM_UNAVAILABLE');
    f.db(d=>{const row=d.prepare('SELECT result_json FROM forum_commands WHERE owner_id=?').get(a.profile.id),v=JSON.parse(row.result_json);v.outcome='applied';v.code='OK';v.contentId='a'.repeat(32);d.prepare('UPDATE forum_commands SET result_json=? WHERE owner_id=?').run(JSON.stringify(v),a.profile.id);});
    assert.throws(()=>store.forumCommand(a.profile.id,key,body,NOW));await assert.rejects(createBackup({databasePath:f.file,outputDirectory:path.join(f.directory,'forged-backup')}));
  }finally{store.close();}
});

for(const corrupt of ['extra-index','missing-index','parent-circle','parent-kind','future-time','withdrawn-body','foreign-receipt','unsafe-receipt','invalid-usage','audit-fingerprint','invalid-state-version']){
test(`forum backup rejects ${corrupt} after the file hash is recomputed`,async t=>{
  const f=await fixture(t),p=f.post();f.approve(p);const c=f.cmd(f.b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:'合成校验评论'});
  const backup=path.join(f.directory,'backup');await createBackup({databasePath:f.file,outputDirectory:backup});const d=new DatabaseSync(path.join(backup,'farm.sqlite'));
  try{
    if(corrupt==='extra-index')d.exec('CREATE INDEX unexpected_forum_index ON forum_content(version)');
    if(corrupt==='missing-index')d.exec('DROP INDEX forum_content_parent');
    if(corrupt==='parent-circle')d.prepare("UPDATE forum_content SET circle='harvest' WHERE id=?").run(c.contentId);
    if(corrupt==='parent-kind')d.prepare('UPDATE forum_content SET parent_id=? WHERE id=?').run(c.contentId,c.contentId);
    if(corrupt==='future-time')d.exec('UPDATE forum_content SET updated_at=updated_at+1');
    if(corrupt==='withdrawn-body')d.prepare("UPDATE forum_content SET state='withdrawn',version=3 WHERE id=?").run(p.contentId);
    if(corrupt==='invalid-usage')d.exec("UPDATE forum_usage SET day='2026-02-30'");
    if(corrupt==='audit-fingerprint')d.exec("UPDATE forum_moderation SET operator_id='changed-operator'");
    if(corrupt==='invalid-state-version')d.prepare('UPDATE forum_content SET version=99 WHERE id=?').run(c.contentId);
    if(corrupt==='foreign-receipt'||corrupt==='unsafe-receipt'){const r=d.prepare('SELECT rowid,result_json FROM forum_commands LIMIT 1').get(),v=JSON.parse(r.result_json);if(corrupt==='foreign-receipt')v.ownerId=f.b.profile.id;else v.body='PRIVATE BODY';d.prepare('UPDATE forum_commands SET result_json=? WHERE rowid=?').run(JSON.stringify(v),r.rowid);}
  }finally{d.close();}await rehash(backup);await assert.rejects(verifyBackup({backupDirectory:backup}));await assert.rejects(restoreBackup({backupDirectory:backup,outputDirectory:path.join(f.directory,'rejected')}));
});}
