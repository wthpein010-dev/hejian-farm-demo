import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../services/api/src/server.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';

async function fixture(t, options = {}) {
  const app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true, ...options });
  await listenOnFetchSafePort(app.server); t.after(() => app.close());
  const baseURL = `http://127.0.0.1:${app.server.address().port}`;
  let serial = 0, drop = false;
  const transport = async request => {
    const response = await fetch(request.url, { method: request.method, headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    const reply = { status: response.status, data: await response.json() };
    if (drop && request.url.endsWith('/account/deletion/confirm')) { drop = false; throw new Error('reply lost after server commit'); }
    return reply;
  };
  return { client: () => createFarmClient({ baseURL, transport, generateKey: () => `privacy-client-${++serial}` }), dropNextConfirmation() { drop = true; } };
}
async function connect(h, account) {
  const client = h.client(); await client.loginDevelopment(account); await client.load(); return client;
}

test('real client can inspect its saved data and cancel deletion without removing its account', async t => {
  const h = await fixture(t), client = await connect(h, 'privacy-cancel');
  const report = await client.loadPrivacy();
  assert.equal(report.profile.id, client.profile.id);
  assert.ok(report.dataCategories.some(v => v.id === 'assets'));
  await client.prepareAccountDeletion(); client.cancelAccountDeletion();
  await client.load(); assert.equal(client.snapshot.wallet.points, 80);
  assert.equal(client.authenticated, true);
});

test('lost deletion reply is recovered without auth and cannot delete a later registration of the same identity', async t => {
  const h = await fixture(t), original = await connect(h, 'privacy-recover');
  const second = await connect(h, 'privacy-recover'), oldId = original.profile.id;
  await original.prepareAccountDeletion(); h.dropNextConfirmation();
  await assert.rejects(() => original.deleteAccount(), { code: 'RESULT_UNKNOWN' });
  assert.equal(original.pendingCanRetryWithoutAuth, true);
  await assert.rejects(() => original.load(), { status: 401 });
  await assert.rejects(() => second.load(), { status: 401 });
  const registered = await connect(h, 'privacy-recover');
  assert.notEqual(registered.profile.id, oldId);
  const receipt = await original.retryPending();
  assert.equal(receipt.deleted, true); assert.equal(original.hasPending(), false);
  assert.equal(original.authenticated, false); assert.equal(original.snapshot, null);
  await registered.load(); assert.equal(registered.snapshot.wallet.points, 80);
});

test('concurrent asset changes reject the stale deletion and require a fresh explicit review', async t => {
  const h = await fixture(t), first = await connect(h, 'privacy-conflict');
  const other = await connect(h, 'privacy-conflict');
  await first.prepareAccountDeletion(); await other.mutate('/activities/sign-in');
  await assert.rejects(() => first.deleteAccount(), { code: 'DELETION_STATE_CHANGED' });
  assert.equal(first.hasPending(), false); assert.equal(first.authenticated, true);
  await first.load(); assert.equal(first.snapshot.wallet.points, 100);
  await first.prepareAccountDeletion(); await first.deleteAccount();
  assert.equal(first.snapshot, null); assert.equal(first.authenticated, false);
  await assert.rejects(() => other.load(), { status: 401 });
});

test('real HTTP rate limiting cannot discard the receipt proof after a committed deletion response is lost', async t => {
  let now = Date.now();
  const h = await fixture(t, { clock: () => now, requestRateLimit: { maxRequests: 4, windowMs: 60000 } });
  const client = await connect(h, 'privacy-rate-limit'); await client.prepareAccountDeletion();
  h.dropNextConfirmation();
  await assert.rejects(() => client.deleteAccount(), { code: 'RESULT_UNKNOWN' });
  await assert.rejects(() => client.retryPending(), { code: 'RESULT_UNKNOWN' });
  assert.equal(client.hasPending(), true);
  assert.equal(client.pendingCanRetryWithoutAuth, true);
  now += 60001;
  assert.equal((await client.retryPending()).deleted, true);
  assert.equal(client.hasPending(), false); assert.equal(client.authenticated, false);
});
