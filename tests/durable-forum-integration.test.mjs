import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../services/api/src/server.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';

async function fixture(t, options = {}) {
  let now = Date.parse('2026-10-27T04:00:00Z'), serial = 0, drop = false;
  const app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true, clock: () => now, ...options });
  await listenOnFetchSafePort(app.server); t.after(() => app.close());
  const calls = [], baseURL = `http://127.0.0.1:${app.server.address().port}`;
  async function connect(account) {
    const client = createFarmClient({ baseURL, generateKey: () => `forum-http-operation-${++serial}`, transport: async request => {
      calls.push(structuredClone(request)); const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
      const value = { status: response.status, data: await response.json() };
      if (drop && request.url.endsWith('/forum/commands')) { drop = false; throw new Error('lost after commit'); } return value;
    } });
    await client.loginDevelopment(account); await client.load(); await client.loadFriends();
    return client;
  }
  const enable = async client => { await client.commandFriends({ action: 'enable' }); await client.loadFriends(); };
  const moderate = (content, decision = 'approve') => app.store.applyForumModeration({ formatVersion: 1, batchId: `forum-batch-${++serial}`, operatorId: 'synthetic-operator', decisions: [{ kind: 'content', id: content.id, expectedVersion: content.version, decision, reason: 'other' }] }, ++now);
  return { app, connect, enable, moderate, calls, dropNext() { drop = true; }, advance(ms) { now += ms; } };
}
const post = { action: 'submit-post', circle: 'harvest', title: '今天的合成田间收获', body: '用于自动测试的合成内容，分享新鲜蔬菜的生长。' };

test('real client premoderation reads isolate pending posts/comments; original submit replay cannot revive withdrawn text', async t => {
  const h = await fixture(t), a = await h.connect('forum-client-author'), b = await h.connect('forum-client-reader'); await h.enable(a); await h.enable(b);
  const financial = a.snapshot; h.dropNext(); await assert.rejects(a.commandForum(post), { code: 'RESULT_UNKNOWN' }); const original = h.calls.at(-1);
  assert.equal((await b.loadForumPage()).items.length, 0); const pending = (await a.loadForumPage('mine')).items[0]; assert.equal(pending.state, 'pending');
  await assert.rejects(b.loadForumDetail(pending.id), { status: 404 }); h.moderate(pending);
  assert.equal((await b.loadForumPage()).items[0].id, pending.id); const parent = (await b.loadForumDetail(pending.id)).post;
  await b.commandForum({ action: 'submit-comment', postId: parent.id, expectedVersion: parent.version, body: '这是一条合成的待审核评论。' });
  assert.equal((await a.loadForumDetail(parent.id)).comments.length, 0); const comment = (await b.loadForumPage('mine')).items[0]; h.moderate(comment); assert.equal((await a.loadForumDetail(parent.id)).comments.length, 1);
  const mirror = await h.connect('forum-client-author'); const current = (await mirror.loadForumDetail(parent.id)).post;
  await mirror.commandForum({ action: 'withdraw', contentId: parent.id, expectedVersion: current.version });
  const replay = await a.retryPending(); assert.equal(replay.outcome, 'applied'); assert.equal(replay.contentId, parent.id); assert.deepEqual(h.calls.at(-1), original); assert.equal(a.snapshot, financial);
  assert.equal((await b.loadForumPage()).items.length, 0); const tombstone = (await a.loadForumPage('mine')).items[0]; assert.equal(tombstone.state, 'withdrawn'); assert.equal(tombstone.body, ''); assert.equal(tombstone.title, '');
});
test('real stranger block removes public visibility and fixed reports are separate minimal history', async t => {
  const h = await fixture(t), a = await h.connect('forum-client-block-author'), b = await h.connect('forum-client-block-reader'); await h.enable(a); await h.enable(b);
  await a.commandForum(post); const pending = (await a.loadForumPage('mine')).items[0]; h.moderate(pending);
  const visible = (await b.loadForumDetail(pending.id)).post;
  assert.equal((await b.commandForum({ action: 'report', contentId: visible.id, expectedVersion: visible.version, reason: 'spam' })).outcome, 'applied');
  const report = (await b.loadForumReports()).items[0]; assert.equal(report.status, 'open'); assert.equal(Object.hasOwn(report, 'body'), false); assert.equal(Object.hasOwn(report, 'author'), false);
  await b.commandForum({ action: 'block-author', contentId: visible.id, expectedVersion: visible.version });
  assert.equal((await b.loadForumPage()).items.length, 0); await assert.rejects(b.loadForumDetail(visible.id), { status: 404 });
  assert.equal((await b.loadFriends()).blocked.length, 1); assert.equal((await a.loadForumPage('mine')).items[0].id, visible.id);
});
test('real expired forum pending retains full original command across original-account recovery', async t => {
  const h = await fixture(t, { sessionTtlMs: 1000 }), a = await h.connect('forum-client-expiry'); await h.enable(a);
  h.dropNext(); await assert.rejects(a.commandForum(post), { code: 'RESULT_UNKNOWN' }); const original = h.calls.at(-1);
  h.advance(1001); await assert.rejects(a.retryPending(), { status: 401 }); assert.equal(a.forumPage, null); assert.equal(a.hasPending(), true);
  await assert.rejects(a.loginDevelopment('different-forum-account'), { code: 'ACCOUNT_MISMATCH' }); await a.loginDevelopment('forum-client-expiry'); await a.load();
  await a.retryPending(); assert.deepEqual(h.calls.at(-1).body, original.body); assert.equal(h.calls.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key']); assert.equal((await a.loadForumPage('mine')).items.length, 1);
});
