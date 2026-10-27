import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const ok = data => ({ status: 200, data: { data } });
const originalToken = 'A'.repeat(43), nextToken = 'B'.repeat(43);
const session = (profile = { id: 'member-a', displayName: '合成账户' }) => ({
  token: originalToken, expiresAt: 1793046600000, environment: 'development', profile
});
function harness() {
  const replies = [], calls = [];
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', transport: async request => {
    calls.push(request);
    if (request.url.endsWith('/account/recovery')) return ok({ recoveryFormat: 1, ownerId: 'member-a', environment: 'development',
      serverTime: 1793044800000, available: true, epoch: 'e'.repeat(32), version: 0, intent: null });
    assert.ok(replies.length, 'each non-recovery reply is explicitly arranged');
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  } });
  return { client, replies, calls };
}
async function connect(h) {
  h.replies.push(ok(session())); await h.client.loginDevelopment('synthetic-account');
  h.replies.push(ok(mobileSnapshot())); await h.client.load();
}

// Removing any corresponding DTO check must allow the replacement session to
// overwrite the original private account, which makes this behavior test fail.
const corruptions = [
  ['missing expiry', value => { delete value.expiresAt; }],
  ['negative expiry', value => { value.expiresAt = -1; }],
  ['zero expiry', value => { value.expiresAt = 0; }],
  ['fractional expiry', value => { value.expiresAt = 123.5; }],
  ['unsafe expiry', value => { value.expiresAt = Number.MAX_SAFE_INTEGER + 1; }],
  ['string expiry', value => { value.expiresAt = '1793046600000'; }],
  ['empty token', value => { value.token = ''; }],
  ['short token', value => { value.token = 'short'; }],
  ['token control suffix', value => { value.token = nextToken + '\n'; }],
  ['token alphabet', value => { value.token = '!'.repeat(43); }],
  ['missing display name', value => { delete value.profile.displayName; }],
  ['empty display name', value => { value.profile.displayName = ''; }],
  ['non-text display name', value => { value.profile.displayName = {}; }],
  ['non-text account ID', value => { value.profile.id = 123; }],
  ['account ID control suffix', value => { value.profile.id = 'member-b\n'; }],
  ['unbounded account ID', value => { value.profile.id = 'b'.repeat(129); }],
  ['extra session field', value => { value.rawOpenid = 'not-part-of-session'; }],
  ['extra profile field', value => { value.profile.rawOpenid = 'not-part-of-profile'; }],
  ['inherited session fields', value => Object.setPrototypeOf(value, { inherited: true })],
  ['inherited profile fields', value => Object.setPrototypeOf(value.profile, { inherited: true })],
  ['non-enumerable session field', value => Object.defineProperty(value, 'token', { enumerable: false })],
  ['symbol session field', value => { value[Symbol('extra')] = true; }]
];
for (const [name, corrupt] of corruptions) {
  test(`malformed login (${name}) preserves the existing session and private view`, async () => {
    const h = harness(); await connect(h);
    const profile = h.client.profile, snapshot = h.client.snapshot;
    const invalid = { ...session({ id: 'member-b', displayName: '另一合成账户' }), token: nextToken };
    corrupt(invalid);
    const count = h.calls.length;
    h.replies.push(ok(invalid));
    await assert.rejects(h.client.loginDevelopment('other-synthetic-account'), { code: 'INVALID_SESSION' });
    assert.equal(h.client.profile, profile); assert.equal(h.client.snapshot, snapshot);
    assert.equal(h.client.authenticated, true); assert.equal(h.client.recoveryDiscovery, 'clear');
    assert.equal(h.calls.length, count + 1, 'an invalid session cannot start recovery under a new identity');
    h.replies.push(ok(mobileSnapshot())); await h.client.load();
    assert.equal(h.calls.at(-1).headers.Authorization, 'Bearer ' + originalToken);
  });
}

test('session accessors are rejected without invoking their getters', async () => {
  const h = harness(); await connect(h); const profile = h.client.profile;
  let reads = 0;
  const invalid = session();
  Object.defineProperty(invalid, 'token', { enumerable: true, get() { reads++; return nextToken; } });
  h.replies.push(ok(invalid));
  await assert.rejects(h.client.loginDevelopment('synthetic-account'), { code: 'INVALID_SESSION' });
  assert.equal(reads, 0); assert.equal(h.client.profile, profile);
});

test('a malformed same-account reply cannot replace the token or erase an uncertain checkout', async () => {
  const h = harness(); await connect(h);
  h.replies.push(new Error('synthetic lost response'));
  await assert.rejects(h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  const original = h.calls.at(-1), snapshot = h.client.snapshot;
  const invalid = { ...session(), token: nextToken }; delete invalid.expiresAt;
  h.replies.push(ok(invalid));
  await assert.rejects(h.client.loginDevelopment('synthetic-account'), { code: 'INVALID_SESSION' });
  assert.equal(h.client.hasPending(), true); assert.equal(h.client.snapshot, snapshot);
  h.replies.push(ok(mobileSnapshot({ revision: 4 }))); await h.client.retryPending();
  const retried = h.calls.at(-1);
  assert.equal(retried.headers.Authorization, original.headers.Authorization);
  assert.equal(retried.headers['Idempotency-Key'], original.headers['Idempotency-Key']);
  assert.deepEqual(retried.body, original.body);
});

test('accepted session data is detached from the transport-owned profile', async () => {
  const h = harness(), reply = session(); h.replies.push(ok(reply));
  await h.client.loginDevelopment('synthetic-account');
  reply.profile.id = 'member-b'; reply.profile.displayName = 'changed outside client';
  assert.equal(h.client.profile.id, 'member-a');
  assert.equal(h.client.profile.displayName, '合成账户');
});

test('a complete session accepts an existing safe ID without treating the device clock as authoritative', async () => {
  const h = harness(), reply = session(); reply.expiresAt = 1000;
  h.replies.push(ok(reply)); await h.client.loginDevelopment('synthetic-account');
  assert.equal(h.client.authenticated, true); assert.equal(h.client.profile.id, 'member-a');
});

test('an older valid login cannot supersede the latest rejected login or the original account', async () => {
  const h = harness(); await connect(h); const profile = h.client.profile, snapshot = h.client.snapshot;
  let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; }));
  const older = h.client.loginDevelopment('older-synthetic-account');
  const invalid = { ...session({ id: 'member-c', displayName: '最新合成账户' }), token: nextToken }; delete invalid.expiresAt;
  h.replies.push(ok(invalid));
  await assert.rejects(h.client.loginDevelopment('latest-synthetic-account'), { code: 'INVALID_SESSION' });
  finish(ok({ ...session({ id: 'member-b', displayName: '较早合成账户' }), token: nextToken }));
  await assert.rejects(older, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.profile, profile); assert.equal(h.client.snapshot, snapshot);
  h.replies.push(ok(mobileSnapshot())); await h.client.load();
  assert.equal(h.calls.at(-1).headers.Authorization, 'Bearer ' + originalToken);
});

test('a delayed valid login cannot restore a session after logout', async () => {
  const h = harness(); await connect(h);
  let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; }));
  const delayed = h.client.loginDevelopment('delayed-synthetic-account');
  h.replies.push(ok({})); await h.client.logout();
  const calls = h.calls.length;
  finish(ok({ ...session({ id: 'member-b', displayName: '迟到合成账户' }), token: nextToken }));
  await assert.rejects(delayed, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.authenticated, false); assert.equal(h.client.profile, null); assert.equal(h.client.snapshot, null);
  assert.equal(h.calls.length, calls, 'an obsolete reply cannot launch recovery after logout');
});
