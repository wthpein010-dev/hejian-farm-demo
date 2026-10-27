import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../services/api/src/server.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';

async function fixture(t, options = {}) {
  let now = Date.parse('2026-10-27T04:00:00Z'), serial = 0, drop = false;
  const calls = [], app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true, clock: () => now, ...options });
  await listenOnFetchSafePort(app.server); t.after(() => app.close());
  const baseURL = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => createFarmClient({ baseURL, generateKey: () => `friends-http-${++serial}`, transport: async request => {
    calls.push(structuredClone(request));
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    const reply = { status: response.status, data: await response.json() };
    if (drop && request.url.endsWith('/friends/commands')) { drop = false; throw new Error('lost after actual server commit'); }
    return reply;
  } });
  async function connect(account) { const value = client(); await value.loginDevelopment(account); await value.load(); await value.loadFriends(); return value; }
  async function command(value, input) { await value.loadFriends(); return value.commandFriends(input); }
  return { connect, command, calls, dropNext() { drop = true; }, advance(milliseconds) { now += milliseconds; } };
}

test('real two-account client recovers the original request receipt after the peer has already accepted and removed it', async t => {
  const h = await fixture(t), a = await h.connect('friends-client-a'), b = await h.connect('friends-client-b');
  await a.commandFriends({ action: 'enable' }); await b.commandFriends({ action: 'enable' }); await a.loadFriends(); await b.loadFriends();
  const before = a.snapshot, code = b.friendsView.profile.code;
  h.dropNext(); await assert.rejects(a.commandFriends({ action: 'request', code }), { code: 'RESULT_UNKNOWN' });
  const original = h.calls.at(-1); await b.loadFriends(); const peerId = b.friendsView.incoming[0].peerId;
  await b.commandFriends({ action: 'accept', peerId }); await h.command(b, { action: 'remove', peerId });
  const result = await a.retryPending(); assert.equal(result.outcome, 'applied'); assert.equal(result.action, 'request');
  assert.deepEqual(Object.keys(result).sort(), ['friendsFormat', 'ownerId', 'environment', 'operationKey', 'action', 'outcome', 'code', 'completedAt'].sort());
  assert.equal(a.friendsView, null, 'historical receipt does not pretend to be a current relationship');
  assert.deepEqual(h.calls.at(-1), original); assert.equal(a.snapshot, before);
  await a.loadFriends(); assert.equal(a.friendsView.friends.length, 0); assert.equal(a.friendsView.outgoing.length, 0); assert.equal(a.hasPending(), false);
});

test('real rate-limited reconciliation retains original enable key/version and does not mint a second profile', async t => {
  const h = await fixture(t, { requestRateLimit: { maxRequests: 4, windowMs: 60000 } }), a = await h.connect('friends-client-rate');
  h.dropNext(); await assert.rejects(a.commandFriends({ action: 'enable' }), { code: 'RESULT_UNKNOWN' });
  const original = h.calls.at(-1); await assert.rejects(a.retryPending(), { code: 'RESULT_UNKNOWN' }); assert.equal(a.hasPending(), true);
  h.advance(60001); assert.equal((await a.retryPending()).outcome, 'applied');
  assert.deepEqual(h.calls.at(-1), original); await a.loadFriends(); assert.equal(a.friendsView.version, 1); assert.equal(a.friendsView.enabled, true);
});

test('real stale recipient decision is refused after cancel and re-apply; current request requires a new decision', async t => {
  const h = await fixture(t), a = await h.connect('friends-client-stale-a'), b = await h.connect('friends-client-stale-b');
  await a.commandFriends({ action: 'enable' }); await b.commandFriends({ action: 'enable' }); await b.loadFriends();
  const code = b.friendsView.profile.code; await h.command(a, { action: 'request', code }); await b.loadFriends();
  const oldVersion = b.friendsView.version, peerId = b.friendsView.incoming[0].peerId;
  await a.loadFriends(); await a.commandFriends({ action: 'cancel', peerId: a.friendsView.outgoing[0].peerId }); await h.command(a, { action: 'request', code });
  const refusal = await b.commandFriends({ action: 'accept', peerId });
  assert.equal(refusal.code, 'FRIENDS_CHANGED'); assert.equal(h.calls.at(-1).body.expectedVersion, oldVersion);
  assert.equal(b.hasPending(), false); await b.loadFriends(); assert.equal(b.friendsView.friends.length, 0); assert.equal(b.friendsView.incoming.length, 1);
  assert.equal((await b.commandFriends({ action: 'accept', peerId })).outcome, 'applied'); await a.loadFriends(); assert.equal(a.friendsView.friends.length, 1);
});

test('real expired social session only recovers in its original account and replays the original command body', async t => {
  const h = await fixture(t, { sessionTtlMs: 1000 }), a = await h.connect('friends-client-expiry');
  h.dropNext(); await assert.rejects(a.commandFriends({ action: 'enable' }), { code: 'RESULT_UNKNOWN' }); const original = h.calls.at(-1);
  h.advance(1001); await assert.rejects(a.retryPending(), { status: 401 }); assert.equal(a.friendsView, null); assert.equal(a.hasPending(), true);
  await assert.rejects(a.loginDevelopment('different-synthetic'), { code: 'ACCOUNT_MISMATCH' });
  await a.loginDevelopment('friends-client-expiry'); await a.load(); assert.equal((await a.retryPending()).outcome, 'applied');
  assert.deepEqual(h.calls.at(-1).body, original.body); assert.equal(h.calls.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key']);
  await a.loadFriends(); assert.equal(a.friendsView.version, 1);
});
