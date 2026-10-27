import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import test from 'node:test';
import { syntheticSession } from './helpers/session-fixture.mjs';
import assert from 'node:assert/strict';
import { createFarmClient as actualCreateFarmClient } from '../apps/mobile/src/core/client.mjs';
const createFarmClient = options => actualCreateFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport) });
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const now = 1793044800000, peerId = 'b'.repeat(32), code = 'c'.repeat(32);
const ok = data => ({ status: 200, data: { data } });
const view = (extra = {}) => ({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, version: 1,
  available: true, enabled: true, profile: { code, alias: '农友aaaaaaaa' }, friends: [], incoming: [], outgoing: [], blocked: [], ...extra });
const receipt = (action = 'request', extra = {}) => ({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'friends-operation-1', action, outcome: 'applied', code: 'OK', completedAt: now, ...extra });
function harness() {
  const calls = [], replies = []; let serial = 0;
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => `friends-operation-${++serial}`, transport: async request => {
    calls.push(structuredClone(request)); const result = replies.shift(); assert.ok(result, 'explicit response required'); if (result instanceof Error) throw result; return await result;
  } });
  return { client, calls, replies };
}
async function login(h, id = 'member-a') {
  h.replies.push(ok(syntheticSession({ environment: 'development', token: `token-${id}`, profile: { id } }))); await h.client.loginDevelopment('synthetic-account');
  h.replies.push(ok(mobileSnapshot({ profile: { id } }))); await h.client.load();
  h.replies.push(ok(view({ ownerId: id }))); await h.client.loadFriends();
}

test('friends use a strict account-scoped view and minimal receipt without parsing financial snapshots', async () => {
  const h = harness(); assert.equal(typeof h.client.loadFriends, 'function'); await login(h);
  h.replies.push(ok(view())); await h.client.loadFriends();
  h.replies.push(ok(receipt())); assert.deepEqual(await h.client.commandFriends({ action: 'request', code }), receipt());
  assert.equal(h.client.snapshot.revision, 3); assert.equal(h.client.snapshot.wallet.points, 80); assert.equal(h.client.friendsView, null);
  assert.deepEqual(h.calls.at(-1).body, { action: 'request', code, expectedVersion: 1 }); assert.equal(h.client.hasPending(), false);
  h.replies.push(ok(view({ version: 2, outgoing: [{ peerId, alias: '农友bbbbbbbb', createdAt: now }] }))); await h.client.loadFriends();
  assert.equal(h.client.friendsView.outgoing.length, 1);
  for (const bad of [view({ ownerId: 'member-b' }), view({ environment: 'production' }), view({ version: 0 })]) {
    h.replies.push(ok(bad)); await assert.rejects(h.client.loadFriends(), e => ['SERVER_UNAVAILABLE', 'READ_SUPERSEDED'].includes(e.code));
    assert.equal(h.client.friendsView.version, 2);
  }
  await assert.rejects(h.client.commandFriends({ action: 'request', code: code.toUpperCase() }), { code: 'INVALID_REQUEST' });
});

for (const status of [400, 403, 404, 409, 422, 429, 500, 503]) test(`unknown friend command retains its exact key/body through ${status} and shares the unique pending slot`, async () => {
  const h = harness(); await login(h); h.replies.push(new Error('lost committed reply'));
  await assert.rejects(h.client.commandFriends({ action: 'request', code }), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.pendingKind, 'friends');
  await assert.rejects(h.client.mutate('/checkout'), { code: 'PENDING_OPERATION' });
  await assert.rejects(h.client.prepareAccountDeletion(), { code: 'PENDING_OPERATION' });
  await assert.rejects(h.client.logout(), { code: 'PENDING_OPERATION' });
  h.replies.push({ status, data: { error: { code: 'REVISION_CONFLICT', message: '暂未到达命令账' }, data: mobileSnapshot({ revision: 99, wallet: { points: 999 } }) } });
  await assert.rejects(h.client.retryPending(), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.hasPending(), true); assert.equal(h.client.snapshot.wallet.points, 80); assert.equal(h.client.snapshot.revision, 3);
  h.replies.push(ok(receipt())); await h.client.retryPending();
  assert.deepEqual(h.calls[3], h.calls[4]); assert.deepEqual(h.calls[3], h.calls[5]); assert.equal(h.client.hasPending(), false);
});

test('a legal refusal settles a friend command but malformed, wrong-key and financial replies keep it unknown', async () => {
  for (const invalid of [mobileSnapshot(), receipt('enable'), receipt('request', { operationKey: 'foreign-operation-1' }), receipt('request', { ownerId: 'member-b' })]) {
    const h = harness(); await login(h); h.replies.push(ok(invalid));
    await assert.rejects(h.client.commandFriends({ action: 'request', code }), { code: 'RESULT_UNKNOWN' }); assert.equal(h.client.hasPending(), true);
    h.replies.push(ok(receipt('request', { outcome: 'refused', code: 'PEER_UNAVAILABLE' })));
    assert.equal((await h.client.retryPending()).code, 'PEER_UNAVAILABLE'); assert.equal(h.client.hasPending(), false);
  }
});

test('expired friends recovery clears private views and only the original account can reconcile', async () => {
  const h = harness(); await login(h); h.replies.push(ok(view())); await h.client.loadFriends();
  h.replies.push(new Error('lost')); await assert.rejects(h.client.commandFriends({ action: 'request', code }));
  h.replies.push({ status: 401, data: { error: { code: 'UNAUTHENTICATED', message: '重新登录原账户' } } });
  await assert.rejects(h.client.retryPending(), { code: 'UNAUTHENTICATED' });
  assert.equal(h.client.authenticated, false); assert.equal(h.client.friendsView, null); assert.equal(h.client.hasPending(), true);
  h.replies.push(ok(syntheticSession({ environment: 'development', token: 'other-token', profile: { id: 'member-b' } })));
  await assert.rejects(h.client.loginDevelopment('other-account'), { code: 'ACCOUNT_MISMATCH' });
  await login(h); h.replies.push(ok(receipt())); await h.client.retryPending();
  assert.equal(h.client.hasPending(), false); assert.equal(h.calls.at(-1).headers['Idempotency-Key'], 'friends-operation-1');
});

test('late reads cannot overwrite a newer version, command, or account and commands block concurrent login', async () => {
  const h = harness(); await login(h); let oldRead;
  h.replies.push(new Promise(resolve => { oldRead = resolve; })); const old = h.client.loadFriends();
  h.replies.push(ok(receipt('enable'))); await h.client.commandFriends({ action: 'enable' });
  h.replies.push(ok(view({ version: 8 }))); await h.client.loadFriends(); oldRead(ok(view({ version: 1 })));
  await assert.rejects(old, { code: 'READ_SUPERSEDED' }); assert.equal(h.client.friendsView.version, 8);
  let late; h.replies.push(new Promise(resolve => { late = resolve; })); const reading = h.client.loadFriends();
  await login(h, 'member-b'); late(ok(view())); await assert.rejects(reading, { code: 'SESSION_CHANGED' }); assert.equal(h.client.friendsView.ownerId, 'member-b');
  let finish; h.replies.push(new Promise(resolve => { finish = resolve; })); const command = h.client.commandFriends({ action: 'enable' });
  await assert.rejects(h.client.loginDevelopment('third-account'), { code: 'PENDING_OPERATION' });
  finish(ok(receipt('enable', { ownerId: 'member-b', operationKey: 'friends-operation-2' }))); await command;
});

test('friend commands pin the displayed version and a changed-relation refusal requires a fresh human decision', async () => {
  const h = harness(); await login(h); h.replies.push(ok(view({ version: 12, incoming: [{ peerId, alias: '农友bbbbbbbb', createdAt: now }] }))); await h.client.loadFriends();
  h.replies.push(ok(receipt('accept', { outcome: 'refused', code: 'FRIENDS_CHANGED' })));
  assert.equal((await h.client.commandFriends({ action: 'accept', peerId })).code, 'FRIENDS_CHANGED');
  assert.deepEqual(h.calls.at(-1).body, { action: 'accept', peerId, expectedVersion: 12 });
  await assert.rejects(h.client.commandFriends({ action: 'accept', peerId }), { code: 'FRIENDS_VIEW_REQUIRED' });
  assert.equal(h.calls.filter(call => call.url.endsWith('/friends/commands')).length, 1, 'no automatic acceptance of a replacement request');
});
test('a fresh GET cannot roll back the last social version after a confirmed command invalidates its display', async () => {
  const h = harness(); await login(h); h.replies.push(ok(view({ version: 8 }))); await h.client.loadFriends();
  h.replies.push(ok(receipt('disable'))); await h.client.commandFriends({ action: 'disable' });
  h.replies.push(ok(view({ version: 1 }))); await assert.rejects(h.client.loadFriends(), { code: 'READ_SUPERSEDED' });
  assert.equal(h.client.friendsView, null);
});
