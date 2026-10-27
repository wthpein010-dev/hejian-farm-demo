import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import test from 'node:test';
import { syntheticSession } from './helpers/session-fixture.mjs';
import assert from 'node:assert/strict';
import { createFarmClient as actualCreateFarmClient } from '../apps/mobile/src/core/client.mjs';
const createFarmClient = options => actualCreateFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport) });
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const ok = data => ({ status: 200, data: { data } });
const proof = 'd'.repeat(43);
const report = (id = 'member-a') => ({ profile: { id, displayName: '田园新友' }, createdAt: 1000, updatedAt: 2000,
  dataCategories: [{ id: 'assets', title: '田园资产', description: '积分和物资' }], deletionSupported: true });
function harness() {
  const replies = [], calls = [];
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', transport: async request => {
    calls.push(structuredClone(request));
    const result = replies.shift(); if (result instanceof Error) throw result;
    assert.ok(result, 'explicitly arranged response'); return result;
  } });
  return { client, replies, calls };
}
async function connect(h, id = 'member-a') {
  h.replies.push(ok(syntheticSession({ environment: 'development', token: 'session-a', profile: { id, displayName: '田园新友' } })));
  await h.client.loginDevelopment(id);
  h.replies.push(ok(mobileSnapshot({ profile: { id } }))); await h.client.load();
}
async function prepare(h) {
  h.replies.push(ok({ confirmationToken: proof, serverTime: 2000, expiresAt: 122000 }));
  await h.client.prepareAccountDeletion();
}

test('privacy lookup verifies ownership and never treats another account report as current data', async () => {
  const h = harness(); await connect(h);
  h.replies.push(ok(report())); await h.client.loadPrivacy();
  assert.equal(h.client.privacy.dataCategories[0].title, '田园资产');
  assert.equal(h.calls.at(-1).method, 'GET');
  h.replies.push(ok(report('member-b')));
  await assert.rejects(() => h.client.loadPrivacy(), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.privacy.profile.id, 'member-a');
});

test('deletion preparation and cancellation do not delete or expose the confirmation capability', async () => {
  const h = harness(); await connect(h); await prepare(h);
  assert.equal(h.client.deletionPrepared, true);
  assert.deepEqual(h.calls.at(-1).body, { expectedRevision: 3 });
  assert.ok(!JSON.stringify(h.client).includes(proof));
  h.client.cancelAccountDeletion();
  assert.equal(h.client.deletionPrepared, false);
  await assert.rejects(() => h.client.deleteAccount(), { code: 'DELETION_NOT_PREPARED' });
  assert.equal(h.calls.length, 3, 'cancel must not send any deletion confirmation');
  assert.equal(h.client.authenticated, true);
});

test('confirmed account deletion clears the session, snapshot and privacy report only after a valid receipt', async () => {
  const h = harness(); await connect(h);
  h.replies.push(ok(report())); await h.client.loadPrivacy(); await prepare(h);
  h.replies.push(ok({ deleted: true, completedAt: 3000 })); await h.client.deleteAccount();
  assert.equal(h.client.authenticated, false); assert.equal(h.client.profile, null);
  assert.equal(h.client.snapshot, null); assert.equal(h.client.privacy, null);
  assert.equal(h.client.hasPending(), false); assert.equal(h.client.deletionPrepared, false);
  assert.equal(h.calls.at(-1).url.endsWith('/account/deletion/confirm'), true);
  assert.deepEqual(h.calls.at(-1).body, { confirmationToken: proof });
  assert.equal(h.calls.at(-1).headers.Authorization, undefined, 'the receipt is reconcilable after all sessions are revoked');
});

test('unknown deletion survives session expiry and reconciles without login using the exact original proof', async () => {
  const h = harness(); await connect(h); await prepare(h);
  h.replies.push(new Error('reply lost after deletion committed'));
  await assert.rejects(() => h.client.deleteAccount(), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.hasPending(), true); assert.equal(h.client.pendingCanRetryWithoutAuth, true);
  await assert.rejects(() => h.client.loginDevelopment('member-b'), { code: 'PENDING_OPERATION' });
  await assert.rejects(() => h.client.logout(), { code: 'PENDING_OPERATION' });
  h.replies.push({ status: 401, data: { error: { code: 'UNAUTHENTICATED', message: '登录已失效' } } });
  await assert.rejects(() => h.client.load(), { status: 401 });
  assert.equal(h.client.authenticated, false);
  h.replies.push(ok({ deleted: true, completedAt: 3000 })); await h.client.retryPending();
  assert.deepEqual(h.calls.at(-1), h.calls[3]);
  assert.equal(h.client.hasPending(), false); assert.equal(h.client.profile, null);
});

for (const response of [ok({ deleted: false, completedAt: 3000 }), ok({ deleted: true }),
  { status: 503, data: { error: { code: 'CAPABILITY_UNAVAILABLE', message: '暂不可用' } } }]) {
  test(`unverified deletion reply stays unknown rather than claiming success: ${JSON.stringify(response)}`, async () => {
    const h = harness(); await connect(h); await prepare(h); h.replies.push(response);
    await assert.rejects(() => h.client.deleteAccount(), { code: 'RESULT_UNKNOWN' });
    assert.equal(h.client.hasPending(), true); assert.equal(h.client.authenticated, true);
  });
}

test('expired confirmation is a definitive refusal and allows a fresh review without deleting account data', async () => {
  const h = harness(); await connect(h); await prepare(h);
  h.replies.push({ status: 410, data: { error: { code: 'DELETION_EXPIRED', message: '请重新核对注销' } } });
  await assert.rejects(() => h.client.deleteAccount(), { code: 'DELETION_EXPIRED' });
  assert.equal(h.client.hasPending(), false); assert.equal(h.client.deletionPrepared, false);
  assert.equal(h.client.snapshot.wallet.points, 80); assert.equal(h.client.authenticated, true);
});

test('a stale or cancelled preparation cannot arm a later account for deletion', async () => {
  const h = harness(); await connect(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; }));
  const preparing = h.client.prepareAccountDeletion();
  h.client.cancelAccountDeletion();
  finish(ok({ confirmationToken: proof, serverTime: 2000, expiresAt: 122000 }));
  await assert.rejects(() => preparing, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.deletionPrepared, false);
  await prepare(h); await connect(h, 'member-b');
  assert.equal(h.client.deletionPrepared, false); assert.equal(h.client.privacy, null);
  await assert.rejects(() => h.client.deleteAccount(), { code: 'DELETION_NOT_PREPARED' });
});

test('a newer account revision invalidates a prepared deletion and requires a new confirmation', async () => {
  const h = harness(); await connect(h); await prepare(h);
  h.replies.push(ok(mobileSnapshot({ revision: 4 }))); await h.client.load();
  assert.equal(h.client.deletionPrepared, false);
  await assert.rejects(() => h.client.deleteAccount(), { code: 'DELETION_NOT_PREPARED' });
});

test('malformed preparation and privacy metadata never become usable UI data', async () => {
  const h = harness(); await connect(h);
  h.replies.push(ok({ confirmationToken: proof, serverTime: 2000, expiresAt: 1000 }));
  await assert.rejects(() => h.client.prepareAccountDeletion(), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.deletionPrepared, false);
  h.replies.push(ok({ ...report(), dataCategories: [{ id: 'assets', title: '' }] }));
  await assert.rejects(() => h.client.loadPrivacy(), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.privacy, null);
});

for (const [status, code] of [[429, 'RATE_LIMITED'], [403, 'ORIGIN_FORBIDDEN'], [401, 'UNAUTHENTICATED'], [404, 'NOT_FOUND']]) {
  test(`a blocked reconciliation preserves the original unknown deletion capability: ${status}`, async () => {
    const h = harness(); await connect(h); await prepare(h);
    h.replies.push(new Error('deletion response lost'));
    await assert.rejects(() => h.client.deleteAccount(), { code: 'RESULT_UNKNOWN' });
    h.replies.push({ status, data: { error: { code, message: '请求暂未到达注销结果核对' } } });
    await assert.rejects(() => h.client.retryPending(), { code: 'RESULT_UNKNOWN' });
    assert.equal(h.client.hasPending(), true); assert.equal(h.client.pendingCanRetryWithoutAuth, true);
    await assert.rejects(() => h.client.loginDevelopment('replacement'), { code: 'PENDING_OPERATION' });
    h.replies.push(ok({ deleted: true, completedAt: 3000 })); await h.client.retryPending();
    assert.deepEqual(h.calls.at(-1), h.calls[3]); assert.equal(h.client.hasPending(), false);
  });
}

test('late private metadata from a previous account cannot replace or revoke the current account', async () => {
  for (const reply of [ok(report()), { status: 401, data: { error: { code: 'UNAUTHENTICATED', message: '旧会话失效' } } }]) {
    const h = harness(); await connect(h); let finish;
    h.replies.push(new Promise(resolve => { finish = resolve; })); const reading = h.client.loadPrivacy();
    await connect(h, 'member-b'); finish(reply);
    await assert.rejects(() => reading, { code: 'SESSION_CHANGED' });
    assert.equal(h.client.profile.id, 'member-b'); assert.equal(h.client.privacy, null);
    assert.equal(h.client.authenticated, true);
  }
});

test('privacy categories need explicit string identities rather than coercible missing identifiers', async () => {
  const h = harness(); await connect(h);
  h.replies.push(ok({ ...report(), dataCategories: [{ title: '账户资料', description: '当前账户资料' }] }));
  await assert.rejects(() => h.client.loadPrivacy(), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.privacy, null);
});
