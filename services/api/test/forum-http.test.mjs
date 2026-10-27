import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';
import { request as httpRequest } from 'node:http';

const NOW = Date.parse('2026-10-27T04:00:00Z');
async function fixture(t, options = {}) {
  let now = NOW, n = 0; const logs = [];
  const app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true,
    clock: () => now, logger: x => logs.push(x), requestRateLimit: { maxRequests: 10000 }, ...options });
  const base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`;
  t.after(() => app.close());
  const request = async (route, auth, body, key) => {
    const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json(), headers: r.headers };
  };
  const login = async name => (await request('/auth/development', null, { account: name })).json.data;
  const enable = async a => request('/friends/commands', a, { action: 'enable', expectedVersion: 0 }, `enable-forum-${++n}`);
  const cmd = async (a, body, key = `forum-http-${++n}`) => { const r = await request('/forum/commands', a, body, key); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
  const post = async a => cmd(a, { action: 'submit-post', circle: 'harvest', title: '合成田园分享', body: '只有合成资料，没有真实个人信息。' });
  const moderate = (id, version = 1, decision = 'approve') => app.store.applyForumModeration({ formatVersion: 1, batchId: `forum-moderation-${++n}`, operatorId: 'synthetic-operator', decisions: [{ kind: 'content', id, expectedVersion: version, decision, reason: 'other' }] }, app.store.serverNow());
  return { app, request, login, enable, cmd, post, moderate, logs, base, time: x => { now = x; } };
}

test('forum requires authentication and opt-in for writes, pending content stays private and financial state is unchanged', async t => {
  const f = await fixture(t), a = await f.login('forum-first-a'), b = await f.login('forum-first-b');
  assert.equal((await f.request('/forum/status')).status, 401);
  const before = (await f.request('/bootstrap', a)).json.data;
  const status = await f.request('/forum/status', a); assert.equal(status.status, 200); assert.equal(status.json.data.canPost, false);
  assert.equal((await f.post(a)).code, 'FRIENDS_DISABLED');
  await f.enable(a); const receipt = await f.post(a); assert.equal(receipt.outcome, 'applied');
  assert.equal((await f.request('/forum/posts/all/start', b)).json.data.items.length, 0);
  assert.equal((await f.request(`/forum/post/${receipt.contentId}/start`, b)).status, 404);
  const own = (await f.request(`/forum/post/${receipt.contentId}/start`, a)).json.data.post; assert.equal(own.state, 'pending');
  f.moderate(receipt.contentId);
  const visible = await f.request(`/forum/post/${receipt.contentId}/start`, b); assert.equal(visible.status, 200); assert.equal(visible.json.data.post.state, 'published');
  assert.deepEqual((await f.request('/bootstrap', a)).json.data, before);
  assert.equal(visible.headers.get('cache-control'), 'no-store, private');
  assert.equal(JSON.stringify(f.logs).includes('合成田园分享'), false);
  assert.equal((await f.request('/forum/commands', a, { action: 'submit-post', circle: 'harvest', title: '合成田园分享', body: '这是非法归属字段。', ownerId: b.profile.id }, 'forum-invalid-owner')).status, 400);
});

test('comments require a current published parent and are premoderated independently', async t => {
  const f = await fixture(t), a = await f.login('forum-comment-a'), b = await f.login('forum-comment-b'); await f.enable(a); await f.enable(b);
  const p = await f.post(a);
  assert.equal((await f.cmd(b, { action: 'submit-comment', postId: p.contentId, expectedVersion: 1, body: '合成评论' })).code, 'CONTENT_UNAVAILABLE');
  f.moderate(p.contentId);
  assert.equal((await f.cmd(b, { action: 'submit-comment', postId: p.contentId, expectedVersion: 1, body: '合成评论' })).code, 'CONTENT_CHANGED');
  const c = await f.cmd(b, { action: 'submit-comment', postId: p.contentId, expectedVersion: 2, body: '合成评论' });
  assert.equal((await f.request(`/forum/post/${p.contentId}/start`, a)).json.data.comments.length, 0);
  assert.equal((await f.request(`/forum/post/${p.contentId}/start`, b)).json.data.comments[0].state, 'pending');
  f.moderate(c.contentId);
  assert.equal((await f.request(`/forum/post/${p.contentId}/start`, a)).json.data.comments[0].state, 'published');
});

test('withdraw erases a post and children; replayed submissions and stale moderation cannot revive them, including after friends disabled', async t => {
  const f = await fixture(t), a = await f.login('forum-withdraw-a'), b = await f.login('forum-withdraw-b'); await f.enable(a); await f.enable(b);
  const body = { action: 'submit-post', circle: 'chat', title: '待擦除的合成标题', body: '待擦除的合成正文。' };
  const p = await f.cmd(a, body, 'original-forum-submit'); f.moderate(p.contentId);
  const c = await f.cmd(b, { action: 'submit-comment', postId: p.contentId, expectedVersion: 2, body: '待擦除的子评论' }); f.moderate(c.contentId);
  const fv = (await f.request('/friends', a)).json.data.version;
  await f.request('/friends/commands', a, { action: 'disable', expectedVersion: fv }, 'forum-disable-owner');
  assert.equal((await f.cmd(a, { action: 'withdraw', contentId: p.contentId, expectedVersion: 2 })).outcome, 'applied');
  const tomb = (await f.request(`/forum/post/${p.contentId}/start`, a)).json.data;
  assert.equal(tomb.post.title, ''); assert.equal(tomb.post.body, ''); assert.deepEqual(tomb.comments, []);
  assert.equal((await f.request('/forum/mine/start', b)).json.data.items[0].body, '');
  assert.deepEqual(await f.cmd(a, body, 'original-forum-submit'), p);
  assert.throws(() => f.moderate(p.contentId, 2, 'hide'));
  assert.equal((await f.request(`/forum/post/${p.contentId}/start`, b)).status, 404);
});

test('stranger authors can be blocked only through visible content and both directions are filtered in detail and comments', async t => {
  const f = await fixture(t), a = await f.login('forum-block-a'), b = await f.login('forum-block-b'); await f.enable(a); await f.enable(b);
  const p = await f.post(a); f.moderate(p.contentId);
  assert.equal((await f.cmd(b, { action: 'block-author', contentId: p.contentId, expectedVersion: 2 })).outcome, 'applied');
  assert.equal((await f.request('/friends', b)).json.data.blocked.length, 1);
  assert.equal((await f.request(`/forum/post/${p.contentId}/start`, b)).status, 404);
  assert.equal((await f.request('/forum/posts/all/start', b)).json.data.items.length, 0);
  const bp = await f.post(b); f.moderate(bp.contentId);
  assert.equal((await f.request('/forum/posts/all/start', a)).json.data.items.some(x => x.id === bp.contentId), false);
});

test('report is private and unique; operator hide resolves it, and stale all-or-nothing batches roll back', async t => {
  const f = await fixture(t), a = await f.login('forum-report-a'), b = await f.login('forum-report-b'); await f.enable(a); await f.enable(b);
  const p = await f.post(a); f.moderate(p.contentId);
  assert.equal((await f.cmd(a, { action: 'report', contentId: p.contentId, expectedVersion: 2, reason: 'spam' })).code, 'SELF_REPORT');
  assert.equal((await f.cmd(b, { action: 'report', contentId: p.contentId, expectedVersion: 2, reason: 'spam' })).outcome, 'applied');
  assert.equal((await f.cmd(b, { action: 'report', contentId: p.contentId, expectedVersion: 2, reason: 'privacy' })).code, 'ALREADY_REPORTED');
  const reports = (await f.request('/forum/reports/start', b)).json.data.items; assert.equal(reports[0].status, 'open'); assert.equal('body' in reports[0], false);
  const batch = { formatVersion: 1, batchId: 'report-hide-batch', operatorId: 'synthetic-op', decisions: [{ kind: 'report', id: reports[0].id, expectedVersion: 1, expectedContentVersion: 2, decision: 'hide', reason: 'spam' }] };
  const result = f.app.store.applyForumModeration(batch, NOW); assert.equal(result.applied, 1);
  assert.equal((await f.request(`/forum/post/${p.contentId}/start`, b)).status, 404);
  assert.equal((await f.request('/forum/reports/start', b)).json.data.items[0].resolution, 'hidden');
  assert.equal(f.app.store.applyForumModeration(batch, NOW).replayed, true);
  assert.equal((await f.request('/forum/mine/start', a)).json.data.items[0].state, 'hidden');
});

test('daily post limits survive withdrawal and profile re-opening; replay does not consume twice', async t => {
  const f = await fixture(t), a = await f.login('forum-quota-a'); await f.enable(a);
  for (let i = 0; i < 10; i++) {
    const body = { action: 'submit-post', circle: 'chat', title: '合成额度标题', body: '合成额度正文内容。' }, key = `daily-post-${i}`;
    const p = await f.cmd(a, body, key); assert.equal(p.outcome, 'applied'); assert.deepEqual(await f.cmd(a, body, key), p);
    await f.cmd(a, { action: 'withdraw', contentId: p.contentId, expectedVersion: 1 });
  }
  assert.equal((await f.post(a)).code, 'DAILY_POST_LIMIT');
  assert.equal((await f.request('/forum/status', a)).json.data.usage.posts, 10);
});

test('production and platform identities cannot read or forge forum operations', async t => {
  const f = await fixture(t, { mode: 'production', allowDevelopmentAuth: false });
  const a = f.app.store.createIdentity('weixin', 'synthetic-forum-production', NOW);
  const s = await f.request('/forum/status', a); assert.equal(s.status, 200); assert.equal(s.json.data.available, false);
  assert.deepEqual((await f.request('/forum/posts/all/start', a)).json.data.items, []);
  assert.equal((await f.post(a)).code, 'FORUM_UNAVAILABLE');
  assert.throws(() => f.app.store.forumModerationQueue(NOW));
});

test('a forum command receiving a slow body rechecks session expiry before storing content or a receipt',async t=>{
  const f=await fixture(t,{sessionTtlMs:1000}),a=await f.login('forum-slow-body');await f.enable(a);
  const observed=new Promise(resolve=>{const listener=r=>{if(r.url==='/api/v1/forum/commands'){f.app.server.off('request',listener);resolve();}};f.app.server.on('request',listener);});
  let outgoing;const done=new Promise((resolve,reject)=>{outgoing=httpRequest(f.base+'/forum/commands',{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json','Idempotency-Key':'forum-slow-body-key'}},r=>{let text='';r.setEncoding('utf8');r.on('data',x=>text+=x);r.on('end',()=>resolve({status:r.statusCode,json:JSON.parse(text)}));});outgoing.on('error',reject);});
  outgoing.write('{"action":"submit-post","circle":"chat",');await observed;f.time(NOW+1000);outgoing.end('"title":"合成缓慢标题","body":"合成缓慢正文内容。"}');
  assert.equal((await done).status,401);const current=await f.login('forum-slow-body');assert.equal((await f.request('/forum/mine/start',current)).json.data.items.length,0);
  assert.equal((await f.cmd(current,{action:'submit-post',circle:'chat',title:'合成缓慢标题',body:'合成缓慢正文内容。'},'forum-slow-body-key')).outcome,'applied');
});

test('published comments page independently and a stranger block through a visible comment filters that author before pagination',async t=>{
  const f=await fixture(t),a=await f.login('forum-comments-page-a'),b=await f.login('forum-comments-page-b'),c=await f.login('forum-comments-page-c');for(const auth of[a,b,c])await f.enable(auth);
  const p=await f.post(a);f.moderate(p.contentId);
  for(let i=0;i<23;i++){const r=await f.cmd(b,{action:'submit-comment',postId:p.contentId,expectedVersion:2,body:`合成分页评论${i}`});f.moderate(r.contentId);}
  const first=(await f.request(`/forum/post/${p.contentId}/start`,c)).json.data;assert.equal(first.comments.length,20);assert.ok(first.nextCursor);
  const second=(await f.request(`/forum/post/${p.contentId}/${first.nextCursor}`,c)).json.data;assert.equal(second.comments.length,3);assert.equal(new Set([...first.comments,...second.comments].map(x=>x.id)).size,23);
  assert.equal((await f.cmd(c,{action:'block-author',contentId:first.comments[0].id,expectedVersion:2})).outcome,'applied');
  const filtered=(await f.request(`/forum/post/${p.contentId}/start`,c)).json.data;assert.equal(filtered.comments.length,0);assert.equal(filtered.post.id,p.contentId);
  assert.equal((await f.request(`/forum/post/${p.contentId}/${first.nextCursor}`,c)).status,400);
});
