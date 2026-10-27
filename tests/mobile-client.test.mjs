import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import { syntheticSession } from './helpers/session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarmClient as actualCreateFarmClient } from '../apps/mobile/src/core/client.mjs';
const createFarmClient = options => actualCreateFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport) });
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

function harness() {
  const calls = [], replies = [];
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => 'request-fixed-123',
    transport: async (request) => {
      calls.push(structuredClone(request));
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      assert.ok(reply, 'a response is explicitly arranged');
      return reply;
    } });
  return { client, calls, replies };
}
const success = (data) => ({ status: 200, data: { data: data?.revision !== undefined ? mobileSnapshot(data) : data } });
async function login(h, id = 'member-a') {
  h.replies.push(success(syntheticSession({ environment: 'development', token: 'private-session-token', expiresAt: 9999999999999, profile: { id, displayName: '田园新友' } })));
  await h.client.loginDevelopment('reviewer');
  h.replies.push(success({ revision: 3, wallet: { points: 80 }, profile: { id } }));
  await h.client.load();
}

test('mobile transport rejects remote plain HTTP and works without configured service', async () => {
  assert.throws(() => createFarmClient({ baseURL: 'http://remote.example', transport() {} }), /HTTPS/);
  const client = createFarmClient({ baseURL: '', transport() { throw new Error('must not send'); } });
  await assert.rejects(() => client.load(), { code: 'SERVICE_UNCONFIGURED' });
});
test('response-loss retry preserves the exact key and expected revision and blocks a new mutation', async () => {
  const h = harness(); await login(h);
  h.replies.push(new Error('timeout including internal detail'));
  await assert.rejects(() => h.client.mutate('/checkout', { couponId: 'welcome-20' }), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.hasPending(), true);
  await assert.rejects(() => h.client.mutate('/activities/sign-in'), { code: 'PENDING_OPERATION' });
  assert.equal(h.calls.length, 3);
  h.replies.push(success({ revision: 4, wallet: { points: 40 }, profile: { id: 'member-a' } }));
  await h.client.retryPending();
  assert.deepEqual(h.calls[2], h.calls[3]);
  assert.equal(h.calls[3].body.expectedRevision, 3);
  assert.equal(h.client.snapshot.revision, 4);
  assert.equal(h.client.hasPending(), false);
});

for (const [status, code] of [
  [503, 'SERVICE_DRAINING'], [503, 'CAPABILITY_UNAVAILABLE'], [503, 'PROXY_UNAVAILABLE'],
  [429, 'RATE_LIMITED'], [403, 'ORIGIN_FORBIDDEN'], [404, 'NOT_FOUND'], [400, 'INVALID_REQUEST'],
  [409, 'REVISION_CONFLICT'], [422, 'BUSINESS_RULE'],
]) test(`an uncertain asset retry retains its original request after non-definitive ${status} ${code}`, async () => {
  const h = harness(); await login(h);
  h.replies.push(new Error('checkout result was lost'));
  await assert.rejects(() => h.client.mutate('/checkout', { couponId: 'welcome-20' }), { code: 'RESULT_UNKNOWN' });
  h.replies.push({ status, data: { error: { code, message: 'request temporarily rejected before receipt lookup' } } });
  await assert.rejects(() => h.client.retryPending(), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.hasPending(), true);
  assert.deepEqual(h.calls[3].body, h.calls[2].body);
  assert.equal(h.calls[3].headers['Idempotency-Key'], h.calls[2].headers['Idempotency-Key']);
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'PENDING_OPERATION' });
  h.replies.push(success({ revision: 4, wallet: { points: 40 }, profile: { id: 'member-a' } }));
  await h.client.retryPending();
  assert.equal(h.client.hasPending(), false);
  assert.equal(h.calls[4].headers['Idempotency-Key'], h.calls[2].headers['Idempotency-Key']);
  assert.deepEqual(h.calls[4].body, h.calls[2].body);
  assert.equal(h.client.snapshot.wallet.points, 40);
});

for (const code of ['SERVICE_DRAINING', 'CAPABILITY_UNAVAILABLE', 'PROXY_UNAVAILABLE']) {
  test(`an initial structured 503 ${code} cannot certify that an asset operation did not commit`, async () => {
    const h = harness(); await login(h);
    h.replies.push({ status: 503, data: { error: { code, message: 'upstream operation could not be confirmed' } } });
    await assert.rejects(() => h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
    assert.equal(h.client.hasPending(), true);
    h.replies.push(success({ revision: 4, wallet: { points: 50 } })); await h.client.retryPending();
    assert.equal(h.client.hasPending(), false);
    assert.deepEqual(h.calls[2].body, h.calls[3].body);
    assert.equal(h.calls[2].headers['Idempotency-Key'], h.calls[3].headers['Idempotency-Key']);
  });
}

for (const [status, code] of [[409, 'IDEMPOTENCY_CONFLICT'], [409, 'REVISION_CONFLICT'],
  [422, 'BUSINESS_RULE'], [503, 'CAPABILITY_UNAVAILABLE']]) {
  test(`a validated same-account post-receipt ${status} ${code} ends uncertain reconciliation`, async () => {
    const h = harness(); await login(h);
    h.replies.push(new Error('checkout result was lost'));
    await assert.rejects(() => h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
    h.replies.push({ status, data: { error: { code, message: 'authoritative request refusal' },
      data: mobileSnapshot({ revision: 8, wallet: { points: 30 } }) } });
    await assert.rejects(() => h.client.retryPending(), { code, status });
    assert.equal(h.client.hasPending(), false);
    assert.equal(h.client.snapshot.revision, 8); assert.equal(h.client.snapshot.wallet.points, 30);
  });
}

for (const [name, status, code, snapshot] of [
  ['unknown code', 409, 'UNVERIFIED_REJECTION', mobileSnapshot({ revision: 8 })],
  ['foreign account', 422, 'BUSINESS_RULE', mobileSnapshot({ revision: 8, profile: { id: 'member-b' }, wallet: { points: 999 } })],
  ['malformed data', 503, 'CAPABILITY_UNAVAILABLE', { revision: 8, profile: { id: 'member-a' } }],
]) test(`a retry does not trust a rejection with ${name} as a terminal receipt`, async () => {
  const h = harness(); await login(h);
  h.replies.push(new Error('checkout result was lost'));
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  h.replies.push({ status, data: { error: { code, message: 'unverified refusal' }, data: snapshot } });
  await assert.rejects(() => h.client.retryPending(), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.hasPending(), true);
  assert.equal(h.client.snapshot.profile.id, 'member-a');
  assert.notEqual(h.client.snapshot.wallet.points, 999);
});

test('an expired asset-retry session keeps the original operation available to the original account', async () => {
  const h = harness(); await login(h);
  h.replies.push(new Error('checkout result was lost'));
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  h.replies.push({ status: 401, data: { error: { code: 'UNAUTHENTICATED', message: 'login expired before lookup' } } });
  await assert.rejects(() => h.client.retryPending(), { code: 'UNAUTHENTICATED', status: 401 });
  assert.equal(h.client.authenticated, false); assert.equal(h.client.snapshot, null); assert.equal(h.client.hasPending(), true);
  await login(h, 'member-a');
  h.replies.push(success({ revision: 4, wallet: { points: 50 } })); await h.client.retryPending();
  const requests = h.calls.filter(call => call.url.endsWith('/checkout'));
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.headers['Idempotency-Key'], requests[0].headers['Idempotency-Key']);
    assert.deepEqual(request.body, requests[0].body);
  }
  assert.equal(h.client.hasPending(), false); assert.equal(h.client.snapshot.wallet.points, 50);
});
test('version conflict updates the current view and requires a fresh human decision', async () => {
  const h = harness(); await login(h);
  h.replies.push({ status: 409, data: { error: { code: 'VERSION_CONFLICT', message: '资产已更新，请重新核对' }, data: mobileSnapshot({ revision: 8, wallet: { points: 30 } }) } });
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'VERSION_CONFLICT' });
  assert.equal(h.calls.length, 3, 'no automatic second checkout');
  assert.equal(h.client.snapshot.revision, 8);
  assert.equal(h.client.hasPending(), false);
});
test('expired session clears the in-memory token and blocks unauthenticated writes', async () => {
  const h = harness(); await login(h);
  h.replies.push({ status: 401, data: { error: { code: 'SESSION_EXPIRED', message: '请重新登录' } } });
  await assert.rejects(() => h.client.load(), { code: 'SESSION_EXPIRED' });
  assert.equal(h.client.authenticated, false);
  assert.equal(h.client.snapshot, null, 'expired accounts must not leave private assets rendered');
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'SESSION_REQUIRED' });
  assert.equal(h.calls.length, 3);
  assert.ok(!JSON.stringify(h.client).includes(syntheticSession({ token: 'private-session-token', profile: { id: 'member-a' } }).token));
});
test('an uncertain operation rejects an account switch before replacing the recoverable session', async () => {
  const h = harness(); await login(h);
  h.replies.push(new Error('lost response'));
  await assert.rejects(() => h.client.mutate('/checkout'));
  h.replies.push(success(syntheticSession({ environment: 'development', token: 'second-token', expiresAt: 9999999999999, profile: { id: 'member-b', displayName: '另一用户' } })));
  await assert.rejects(() => h.client.loginDevelopment('second-reviewer'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(h.client.profile.id, 'member-a');
  assert.equal(h.client.snapshot.wallet.points, 80);
  assert.equal(h.client.hasPending(), true);
  assert.equal(h.calls.length, 4);
  h.replies.push(success({ revision: 4, wallet: { points: 50 }, profile: { id: 'member-a' } }));
  await h.client.retryPending();
  assert.equal(h.calls[4].headers.Authorization, h.calls[2].headers.Authorization);
  assert.equal(h.calls[4].headers['Idempotency-Key'], h.calls[2].headers['Idempotency-Key']);
  assert.equal(h.client.hasPending(), false);
});
test('a checkout proposal cannot silently use a newer revision than the user confirmed', async () => {
  const h = harness(); await login(h);
  await assert.rejects(() => h.client.mutate('/checkout', { expectedRevision: 2 }), { code: 'VERSION_CONFLICT' });
  assert.equal(h.calls.length, 2, 'no transaction was sent for a stale confirmation');
});
test('a replayed old success cannot replace a more recent server snapshot', async () => {
  const h = harness(); await login(h);
  h.replies.push(new Error('response was lost'));
  await assert.rejects(() => h.client.mutate('/checkout'));
  h.replies.push(success({ revision: 8, wallet: { points: 25 }, profile: { id: 'member-a' } })); await h.client.load();
  h.replies.push(success({ revision: 4, wallet: { points: 50 }, profile: { id: 'member-a' } })); await h.client.retryPending();
  assert.equal(h.client.snapshot.revision, 8);
  assert.equal(h.client.snapshot.wallet.points, 25);
  assert.equal(h.client.hasPending(), false);
});
test('a previous account success arriving after login cannot replace the new account snapshot', async () => {
  const h = harness(); await login(h);
  let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.load();
  await login(h, 'member-b');
  finish(success({ revision: 100, profile: { id: 'member-a' }, wallet: { points: 999 } }));
  await assert.rejects(() => old, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.profile.id, 'member-b'); assert.equal(h.client.snapshot.profile.id, 'member-b');
});
test('a previous account 401 arriving late cannot revoke the new account session', async () => {
  const h = harness(); await login(h);
  let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.load();
  await login(h, 'member-b');
  finish({ status: 401, data: { error: { code: 'SESSION_EXPIRED', message: 'expired old session' } } });
  await assert.rejects(() => old, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.authenticated, true); assert.equal(h.client.profile.id, 'member-b');
});
test('out-of-order login replies preserve the last requested account', async () => {
  const h = harness(); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loginDevelopment('member-first');
  h.replies.push(success(syntheticSession({ environment: 'development', token: 'new-token', profile: { id: 'member-b' } }))); await h.client.loginDevelopment('member-last');
  finish(success(syntheticSession({ environment: 'development', token: 'old-token', profile: { id: 'member-a' } })));
  await assert.rejects(() => old, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.profile.id, 'member-b');
});
test('account switching is blocked while a transaction response is in flight', async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const transaction = h.client.mutate('/checkout');
  await assert.rejects(() => h.client.loginDevelopment('other-member'), { code: 'PENDING_OPERATION' });
  assert.equal(h.calls.length, 3);
  finish(success({ revision: 4, profile: { id: 'member-a' }, wallet: { points: 50 } })); await transaction;
});
test('a successful payload for a foreign account is rejected without displaying its balance', async () => {
  const h = harness(); await login(h);
  h.replies.push(success({ revision: 8, profile: { id: 'member-b' }, wallet: { points: 999 } }));
  await assert.rejects(() => h.client.load(), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.snapshot.wallet.points, 80);
});
test('a transaction cannot start under an old account while a new login is in flight', async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const switching = h.client.loginDevelopment('next-account');
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'PENDING_OPERATION' });
  assert.equal(h.calls.length, 3);
  finish(success(syntheticSession({ environment: 'development', token: 'next-token', profile: { id: 'member-b' } }))); await switching;
});
test('an obsolete login rejection cannot clear a newer authenticated account', async () => {
  const h = harness(); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loginPlatform('weixin', 'older-code');
  await login(h, 'member-b');
  finish({ status: 401, data: { error: { code: 'PLATFORM_CODE_REJECTED', message: 'old code rejected' } } });
  await assert.rejects(() => old, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.authenticated, true); assert.equal(h.client.snapshot.profile.id, 'member-b');
});
for (const [name, corrupt] of [
  ['missing level', s => { delete s.level; }],
  ['missing system', s => { delete s.system; }],
  ['wrong catalog type', s => { s.catalog = {}; }],
  ['negative balance', s => { s.wallet.feed = -1; }],
  ['missing farm collection', s => { delete s.farm.animals; }],
  ['missing capabilities', s => { delete s.capabilities; }],
  ['invalid sign-in index', s => { s.signIn.nextIndex = 7; }],
  ['incomplete sign-in rewards', s => { s.signIn.rewards.pop(); }],
  ['task with zero target', s => { s.tasks = [{ id: 'browse', title: '逛商城', description: '浏览', progress: 1, target: 0, claimed: false, ready: true, reward: { points: 10 } }]; }],
  ['missing inventory', s => { delete s.system.inventory; }],
  ['invalid product cost', s => { s.catalog = [{ id: 'feed-pack', title: '饲料', description: '饲料', category: 'supplies', cost: -1, limit: 5, art: 'feed' }]; }],
  ['malformed purchase', s => { s.system.purchases = [{}]; }],
  ['incorrect environment', s => { s.environment = 'unknown'; }],
  ['missing server time', s => { delete s.serverTime; }]
]) test(`invalid API snapshot is rejected without replacing known assets: ${name}`, async () => {
  const h = harness(); await login(h);
  const invalid = mobileSnapshot({ revision: 9 }); corrupt(invalid);
  h.replies.push({ status: 200, data: { data: invalid } });
  await assert.rejects(() => h.client.load(), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.snapshot.revision, 3);
});
test('a malformed successful mutation is uncertain and preserves its original key for reconciliation', async () => {
  const h = harness(); await login(h);
  h.replies.push({ status: 200, data: { data: { revision: 4, profile: { id: 'member-a' }, wallet: { points: 40 } } } });
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.hasPending(), true); assert.equal(h.client.snapshot.wallet.points, 80);
  h.replies.push(success({ revision: 4, wallet: { points: 40 } })); await h.client.retryPending();
  assert.deepEqual(h.calls[2], h.calls[3]); assert.equal(h.client.snapshot.wallet.points, 40);
});
