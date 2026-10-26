import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../services/api/src/server.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';

async function fixture(t, options = {}) {
  const app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true, ...options });
  await listenOnFetchSafePort(app.server);
  t.after(() => app.close());
  const baseURL = `http://127.0.0.1:${app.server.address().port}`;
  let count = 0, loseCheckoutReply = false;
  const transport = async request => {
    const response = await fetch(request.url, { method: request.method, headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    const result = { status: response.status, data: await response.json() };
    if (loseCheckoutReply && request.url.endsWith('/checkout')) { loseCheckoutReply = false; throw new Error('response dropped after server committed'); }
    return result;
  };
  return { client: () => createFarmClient({ baseURL, transport, generateKey: () => `joint-request-${++count}` }), loseNextCheckout() { loseCheckoutReply = true; } };
}

test('mobile client and real API share persistent account assets and isolate another member', async t => {
  const h = await fixture(t), first = h.client();
  await first.loginDevelopment('member-one'); await first.load();
  await first.mutate('/cart/items', { sku: 'feed-pack', delta: 2 });
  await first.mutate('/checkout', { couponId: 'welcome-20' });
  assert.equal(first.snapshot.wallet.points, 40); assert.equal(first.snapshot.wallet.feed, 12);
  const reopened = h.client(); await reopened.loginDevelopment('member-one'); await reopened.load();
  assert.equal(reopened.snapshot.wallet.points, 40); assert.equal(reopened.snapshot.wallet.feed, 12);
  await reopened.mutate('/activities/sign-in'); assert.equal(reopened.snapshot.wallet.points, 60);
  const other = h.client(); await other.loginDevelopment('member-two'); await other.load();
  assert.equal(other.snapshot.wallet.points, 80); assert.equal(other.snapshot.wallet.feed, 6);
  await other.mutate('/cart/items', { sku: 'fertilizer', delta: 1 });
  await other.mutate('/checkout'); // No coupon is a genuinely supported API path.
  assert.equal(other.snapshot.wallet.points, 60);
  await first.load(); assert.equal(first.snapshot.wallet.points, 60);
});

test('a lost checkout response is recovered using the same real server receipt', async t => {
  const h = await fixture(t), client = h.client();
  await client.loginDevelopment('lost-reply'); await client.load();
  await client.mutate('/cart/items', { sku: 'feed-pack', delta: 1 });
  h.loseNextCheckout();
  await assert.rejects(() => client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  await client.retryPending();
  assert.equal(client.snapshot.wallet.points, 50); assert.equal(client.snapshot.wallet.feed, 9);
  assert.equal(client.snapshot.system.purchases.length, 1);
  assert.equal(client.hasPending(), false);
});

test('expired uncertain checkout rejects another identity and recovers the original account without a second debit', async t => {
  let now = Date.now();
  const h = await fixture(t, { clock: () => now, sessionTtlMs: 60000 }), client = h.client();
  await client.loginDevelopment('recovery-original'); await client.load();
  const originalId = client.profile.id;
  await client.mutate('/cart/items', { sku: 'feed-pack', delta: 1 });
  h.loseNextCheckout();
  await assert.rejects(() => client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  now += 60001;
  await assert.rejects(() => client.load(), { status: 401 });
  assert.equal(client.authenticated, false);
  await assert.rejects(() => client.loginDevelopment('recovery-other'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(client.authenticated, false, 'the sign-in form must remain available for the original identity');
  assert.equal(client.profile.id, originalId);
  assert.equal(client.snapshot, null);
  assert.equal(client.hasPending(), true);
  await client.loginDevelopment('recovery-original'); await client.load();
  await client.retryPending();
  assert.equal(client.snapshot.wallet.points, 50);
  assert.equal(client.snapshot.wallet.feed, 9);
  assert.equal(client.snapshot.system.purchases.length, 1);
  assert.equal(client.hasPending(), false);
  await client.logout();
  assert.equal(client.authenticated, false);
});
