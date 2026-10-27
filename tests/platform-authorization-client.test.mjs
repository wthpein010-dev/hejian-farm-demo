import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { syntheticSession } from './helpers/session-fixture.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const ok = data => ({ status: 200, data: { data } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const calls = [], replies = [];
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', transport: async request => {
    calls.push(request);
    if (request.url.endsWith('/account/recovery')) return ok({ recoveryFormat: 1, ownerId: client.profile.id,
      environment: 'development', serverTime: 1793044800000, available: true,
      epoch: 'e'.repeat(32), version: 0, intent: null });
    assert.ok(replies.length, 'every non-recovery response is explicitly arranged');
    const response = replies.shift();
    if (response instanceof Error) throw response;
    return response;
  } });
  return { client, calls, replies };
}
async function connect(h, id = 'member-a') {
  h.replies.push(ok(syntheticSession({ token: id, profile: { id } })));
  await h.client.loginDevelopment('synthetic-account');
  h.replies.push(ok(mobileSnapshot({ profile: { id } }))); await h.client.load();
}

test('authorization waiting is part of the client login attempt and blocks new asset writes', async () => {
  const h = harness(); await connect(h); const code = deferred(), before = h.calls.length;
  const login = h.client.authorizePlatform('weixin', () => code.promise);
  assert.equal(h.client.mutationBlocked, true);
  await assert.rejects(h.client.mutate('/checkout'), { code: 'PENDING_OPERATION' });
  assert.equal(h.calls.length, before, 'no HTTP login starts before an authorization code exists');
  h.replies.push(ok(syntheticSession({ token: 'new-session', profile: { id: 'member-a' } })));
  code.resolve('synthetic-authorized-code'); await login;
  const request = h.calls.findLast(call => call.url.endsWith('/auth/platform'));
  assert.deepEqual(request.body, { platform: 'weixin', code: 'synthetic-authorized-code' });
  assert.equal(h.client.authenticated, true); assert.equal(h.client.mutationBlocked, false);
});

test('logout while native authorization waits makes a late code unable to start HTTP login', async () => {
  const h = harness(); await connect(h); const code = deferred();
  let nativeCalls = 0;
  const login = h.client.authorizePlatform('weixin', () => { nativeCalls++; return code.promise; });
  const rejected = assert.rejects(login, { code: 'SESSION_CHANGED' });
  await Promise.resolve(); assert.equal(nativeCalls, 1, 'the native request has already started');
  h.replies.push(ok({ loggedOut: true })); await h.client.logout(); const before = h.calls.length;
  code.resolve('late-synthetic-code');
  await rejected;
  assert.equal(h.calls.length, before); assert.equal(h.client.authenticated, false);
  assert.equal(h.client.profile, null); assert.equal(h.client.snapshot, null);
});

test('a newer login invalidates the earlier native wait before a late code can cross the network', async () => {
  const h = harness(); await connect(h); const code = deferred();
  let nativeCalls = 0;
  const old = h.client.authorizePlatform('weixin', () => { nativeCalls++; return code.promise; });
  const rejected = assert.rejects(old, { code: 'SESSION_CHANGED' });
  await Promise.resolve(); assert.equal(nativeCalls, 1);
  await connect(h, 'member-b'); const current = h.client.profile, snapshot = h.client.snapshot, before = h.calls.length;
  code.resolve('older-synthetic-code'); await rejected;
  assert.equal(h.calls.length, before); assert.equal(h.client.profile, current); assert.equal(h.client.snapshot, snapshot);
});

test('only the latest of two authorization attempts may submit its code', async () => {
  const h = harness(); await connect(h); const a = deferred(), b = deferred();
  const old = h.client.authorizePlatform('weixin', () => a.promise);
  const rejected = assert.rejects(old, { code: 'SESSION_CHANGED' });
  await Promise.resolve();
  const current = h.client.authorizePlatform('weixin', () => b.promise);
  h.replies.push(ok(syntheticSession({ token: 'latest-session', profile: { id: 'member-a' } })));
  b.resolve('newer-synthetic-code'); await current;
  const before = h.calls.length; a.resolve('older-synthetic-code');
  await rejected; assert.equal(h.calls.length, before);
  assert.equal(h.calls.filter(call => call.url.endsWith('/auth/platform')).length, 1);
});

for (const [label, value] of [['empty', ''], ['missing', undefined], ['object', { code: 'synthetic-code' }],
  ['control', 'synthetic\ncode'], ['oversized', 'c'.repeat(4097)]]) {
  test(`invalid authorization code (${label}) preserves the session without starting HTTP login`, async () => {
    const h = harness(); await connect(h); const current = h.client.profile, snapshot = h.client.snapshot, before = h.calls.length;
    await assert.rejects(h.client.authorizePlatform('weixin', async () => value), { code: 'INVALID_PLATFORM_CODE' });
    assert.equal(h.calls.length, before); assert.equal(h.client.profile, current); assert.equal(h.client.snapshot, snapshot);
    assert.equal(h.client.mutationBlocked, false);
  });
}

test('authorization failures are fixed and do not expose the native exception', async () => {
  const h = harness(); await connect(h); const current = h.client.profile, snapshot = h.client.snapshot, before = h.calls.length;
  await assert.rejects(h.client.authorizePlatform('weixin', async () => { throw new Error('synthetic-private-native-result'); }), failure => {
    assert.equal(failure.code, 'PLATFORM_AUTHORIZATION_FAILED');
    assert.equal(failure.message.includes('synthetic-private'), false); assert.equal(failure.cause, undefined); return true;
  });
  assert.equal(h.calls.length, before); assert.equal(h.client.profile, current); assert.equal(h.client.snapshot, snapshot);
  assert.equal(h.client.mutationBlocked, false);
});

test('an unknown checkout survives a different identity returned after authorization', async () => {
  const h = harness(); await connect(h);
  h.replies.push(new Error('synthetic lost response')); await assert.rejects(h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  const operation = h.calls.at(-1), current = h.client.profile, snapshot = h.client.snapshot;
  h.replies.push(ok(syntheticSession({ token: 'other-identity', profile: { id: 'member-b' } })));
  await assert.rejects(h.client.authorizePlatform('weixin', async () => 'synthetic-different-identity-code'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(h.client.profile, current); assert.equal(h.client.snapshot, snapshot); assert.equal(h.client.hasPending(), true);
  h.replies.push(ok(mobileSnapshot({ revision: 4 }))); await h.client.retryPending();
  const retry = h.calls.at(-1);
  assert.equal(retry.headers.Authorization, operation.headers.Authorization);
  assert.equal(retry.headers['Idempotency-Key'], operation.headers['Idempotency-Key']); assert.deepEqual(retry.body, operation.body);
});

test('an active asset mutation refuses authorization before invoking the native request', async () => {
  const h = harness(); await connect(h); const response = deferred(); let nativeCalls = 0;
  h.replies.push(response.promise); const checkout = h.client.mutate('/checkout');
  await assert.rejects(h.client.authorizePlatform('weixin', async () => { nativeCalls++; return 'synthetic-code'; }), { code: 'PENDING_OPERATION' });
  assert.equal(nativeCalls, 0);
  response.resolve(ok(mobileSnapshot({ revision: 4 }))); await checkout;
});

test('logout releases the obsolete authorization wait without needing a native callback', async () => {
  const h = harness(); await connect(h); const code = deferred();
  const old = h.client.authorizePlatform('weixin', () => code.promise).then(() => 'accepted', failure => failure.code);
  h.replies.push(ok({ loggedOut: true })); await h.client.logout();
  assert.equal(await Promise.race([old, new Promise(resolve => setTimeout(() => resolve('still-waiting'), 25))]), 'SESSION_CHANGED');
  await connect(h, 'member-b'); assert.equal(h.client.mutationBlocked, false);
  const before = h.calls.length; code.resolve('late-synthetic-code'); await Promise.resolve();
  assert.equal(h.calls.length, before); assert.equal(h.client.profile.id, 'member-b');
});

test('a newer login releases the obsolete authorization write lock before the SDK returns', async () => {
  const h = harness(); await connect(h); const code = deferred();
  const old = h.client.authorizePlatform('weixin', () => code.promise).then(() => 'accepted', failure => failure.code);
  await connect(h, 'member-b');
  assert.equal(await Promise.race([old, new Promise(resolve => setTimeout(() => resolve('still-waiting'), 25))]), 'SESSION_CHANGED');
  assert.equal(h.client.mutationBlocked, false);
  const before = h.calls.length; code.resolve('obsolete-synthetic-code'); await Promise.resolve();
  assert.equal(h.calls.length, before);
});

test('an unconfigured service refuses authorization before opening the native SDK', async () => {
  let nativeCalls = 0;
  const client = createFarmClient({ transport: async () => { throw new Error('must not request'); } });
  await assert.rejects(client.authorizePlatform('weixin-app', async () => { nativeCalls++; return 'synthetic-code'; }), { code: 'SERVICE_UNCONFIGURED' });
  assert.equal(nativeCalls, 0); assert.equal(client.authenticated, false);
});

for (const [platform, requestCode] of [['unknown', async () => 'synthetic-code'], ['weixin', undefined]]) {
  test(`unsupported authorization configuration (${platform}/${typeof requestCode}) cannot start a request`, async () => {
    const h = harness(); await connect(h); const before = h.calls.length, current = h.client.profile;
    await assert.rejects(h.client.authorizePlatform(platform, requestCode), { code: 'INVALID_AUTHORIZATION_REQUEST' });
    assert.equal(h.calls.length, before); assert.equal(h.client.profile, current); assert.equal(h.client.mutationBlocked, false);
  });
}
