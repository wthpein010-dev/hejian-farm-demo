import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const now = 1793044800000, id = 'a'.repeat(32), peerId = 'b'.repeat(32);
const ok = data => ({ status: 200, data: { data } });
const scope = { forumFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
const status = (extra = {}) => ({ ...scope, available: true, canPost: true, alias: '农友bbbbbbbb', limits: { posts: 10, comments: 50, reports: 20, active: 200 }, usage: { posts: 0, comments: 0, reports: 0 }, ...extra });
const content = (extra = {}) => ({ id, kind: 'post', parentId: null, circle: 'harvest', author: { peerId, alias: '农友bbbbbbbb', self: false }, title: '田间的新收获', body: '今天收到了新鲜的蔬菜。', state: 'published', version: 2, createdAt: now, updatedAt: now, publishedAt: now, reasonCode: null, ...extra });
const page = (extra = {}) => ({ ...scope, scope: 'public', circle: 'all', items: [content()], nextCursor: null, ...extra });
const receipt = (extra = {}) => ({ forumFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'forum-operation-1', action: 'submit-post', outcome: 'applied', code: 'OK', contentId: id, completedAt: now, ...extra });
const command = { action: 'submit-post', circle: 'harvest', title: '今天的田间收获', body: '今天收获了新鲜的蔬菜，和大家一起分享。' };
const friendView = (extra = {}) => ({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, version: 8, available: true, enabled: true, profile: { code: 'c'.repeat(32), alias: '农友aaaaaaaa' }, friends: [], incoming: [], outgoing: [], blocked: [], ...extra });
const friendReceipt = (extra = {}) => ({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'forum-operation-1', action: 'block', outcome: 'applied', code: 'OK', completedAt: now, ...extra });
function harness() {
  const calls = [], replies = []; let serial = 0;
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => `forum-operation-${++serial}`, transport: async request => {
    calls.push(structuredClone(request)); const reply = replies.shift(); assert.ok(reply, 'explicit response required'); if (reply instanceof Error) throw reply; return await reply;
  } });
  return { client, calls, replies };
}
async function login(h, ownerId = 'member-a') {
  h.replies.push(ok({ token: `token-${ownerId}`, profile: { id: ownerId } })); await h.client.loginDevelopment('synthetic');
  h.replies.push(ok(mobileSnapshot({ profile: { id: ownerId } }))); await h.client.load();
}
test('forum reads strict account DTO and commands settle separately from financial snapshots', async () => {
  const h = harness(); assert.equal(typeof h.client.loadForumStatus, 'function'); await login(h);
  h.replies.push(ok(status()), ok(page())); await h.client.loadForumStatus(); await h.client.loadForumPage(); const before = h.client.snapshot;
  h.replies.push(ok(receipt())); await h.client.commandForum(command);
  assert.equal(h.client.snapshot, before); assert.equal(h.client.forumPage, null); assert.equal(h.client.forumStatus, null); assert.equal(h.client.hasPending(), false);
  assert.deepEqual(h.calls.at(-1).body, command); assert.equal(h.calls.at(-1).url.endsWith('/forum/commands'), true);
});
test('lost forum responses keep the only original key and full in-memory body through generic failures', async () => {
  const h = harness(); await login(h); h.replies.push(new Error('lost')); await assert.rejects(h.client.commandForum(command), { code: 'RESULT_UNKNOWN' }); const original = h.calls.at(-1);
  await assert.rejects(h.client.mutate('/activities/sign-in'), { code: 'PENDING_OPERATION' });
  for (const response of [{ status: 400, data: { error: { code: 'INVALID_REQUEST' } } }, { status: 429, data: {} }, ok(mobileSnapshot()), ok(receipt({ operationKey: 'foreign-key' }))]) {
    h.replies.push(response); await assert.rejects(h.client.retryPending(), { code: 'RESULT_UNKNOWN' }); assert.equal(h.client.hasPending(), true); assert.deepEqual(h.calls.at(-1), original);
  }
  h.replies.push(ok(receipt({ outcome: 'refused', code: 'DAILY_POST_LIMIT', contentId: null }))); await h.client.retryPending(); assert.equal(h.client.hasPending(), false);
});
test('expired forum recovery clears all content and only the original account can reconcile', async () => {
  const h = harness(); await login(h); h.replies.push(ok(page()), new Error('lost')); await h.client.loadForumPage(); await assert.rejects(h.client.commandForum(command));
  h.replies.push({ status: 401, data: { error: { code: 'UNAUTHENTICATED', message: '重新登录' } } }); await assert.rejects(h.client.retryPending(), { status: 401 });
  assert.equal(h.client.forumPage, null); assert.equal(h.client.hasPending(), true);
  h.replies.push(ok({ token: 'other', profile: { id: 'member-b' } })); await assert.rejects(h.client.loginDevelopment('other'), { code: 'ACCOUNT_MISMATCH' });
  await login(h); h.replies.push(ok(receipt())); await h.client.retryPending(); assert.equal(h.client.hasPending(), false);
});
test('old forum reads are invalidated by commands, newer selections and account changes', async () => {
  const h = harness(); await login(h); let finish; h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loadForumPage();
  h.replies.push(ok(receipt())); await h.client.commandForum(command); finish(ok(page())); await assert.rejects(old, { code: 'READ_SUPERSEDED' });
  h.replies.push(ok(page({ ownerId: 'member-b' }))); await assert.rejects(h.client.loadForumPage(), { code: 'SERVER_UNAVAILABLE' });
  h.replies.push(ok(page({ scope: 'mine' }))); await assert.rejects(h.client.loadForumPage(), { code: 'SERVER_UNAVAILABLE' });
});

test('friend block immediately clears both domains and rejects a previously deferred forum read without lowering social version', async () => {
  const h = harness(); await login(h); h.replies.push(ok(friendView()), ok(status()), ok(page())); await h.client.loadFriends(); await h.client.loadForumStatus(); await h.client.loadForumPage();
  let finishRead, finishCommand; h.replies.push(new Promise(resolve => { finishRead = resolve; })); const old = h.client.loadForumPage(); const rejected = assert.rejects(old, { code: 'READ_SUPERSEDED' });
  h.replies.push(new Promise(resolve => { finishCommand = resolve; })); const writing = h.client.commandFriends({ action: 'block', peerId });
  assert.equal(h.client.forumStatus, null); assert.equal(h.client.forumPage, null); assert.equal(h.client.forumDetail, null); assert.equal(h.client.forumReports, null);
  assert.equal(h.client.friendsView, null, 'the old relation must not remain available while its block is unconfirmed');
  finishRead(ok(page())); await rejected; finishCommand(ok(friendReceipt())); await writing;
  h.replies.push(ok(friendView({ version: 7 }))); await assert.rejects(h.client.loadFriends(), { code: 'READ_SUPERSEDED' });
});

test('forum author block immediately clears friends, rejects deferred friend reads and preserves the last known version floor', async () => {
  const h = harness(); await login(h); h.replies.push(ok(friendView())); await h.client.loadFriends();
  let finishRead, finishCommand; h.replies.push(new Promise(resolve => { finishRead = resolve; })); const old = h.client.loadFriends(); const rejected = assert.rejects(old, { code: 'READ_SUPERSEDED' });
  h.replies.push(new Promise(resolve => { finishCommand = resolve; })); const writing = h.client.commandForum({ action: 'block-author', contentId: id, expectedVersion: 2 });
  assert.equal(h.client.friendsView, null, 'the old relation must disappear at the start of the cross-domain block');
  finishRead(ok(friendView())); await rejected; finishCommand(ok(receipt({ action: 'block-author' }))); await writing;
  h.replies.push(ok(friendView({ version: 7 }))); await assert.rejects(h.client.loadFriends(), { code: 'READ_SUPERSEDED' });
  assert.equal(h.client.friendsView, null);
});
