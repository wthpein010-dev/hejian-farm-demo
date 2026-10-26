import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createApp } from '../services/api/src/server.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';

async function fixture(t, options = {}) {
  const { withGateway = false, ...apiOptions } = options;
  const app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true, ...apiOptions });
  await listenOnFetchSafePort(app.server);
  const upstreamBase = `http://127.0.0.1:${app.server.address().port}`;
  let baseURL = upstreamBase, gateway = null, nextRejection = null, nextReplyReplacement = null;
  if (withGateway) {
    gateway = createServer((incoming, outgoing) => {
      if (nextRejection && incoming.url === '/api/v1/checkout') {
        const { status, code } = nextRejection; nextRejection = null; incoming.resume();
        outgoing.writeHead(status, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: { code, message: 'gateway rejected this attempt before receipt lookup' } }));
        return;
      }
      const request = httpRequest(upstreamBase + incoming.url, { method: incoming.method, headers: incoming.headers,
        signal: AbortSignal.timeout(5000) }, response => {
        if (nextReplyReplacement && incoming.url === '/api/v1/checkout') {
          const { status, code } = nextReplyReplacement; nextReplyReplacement = null;
          response.resume(); response.on('end', () => {
            outgoing.writeHead(status, { 'Content-Type': 'application/json' });
            outgoing.end(JSON.stringify({ error: { code, message: 'gateway could not confirm the completed upstream response' } }));
          });
          return;
        }
        outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
      });
      request.on('error', () => { if (!outgoing.writableEnded) { outgoing.writeHead(502); outgoing.end('{}'); } });
      incoming.pipe(request);
    });
    baseURL = `http://127.0.0.1:${await listenOnFetchSafePort(gateway)}`;
  }
  t.after(async () => { if (gateway) await new Promise(resolve => gateway.close(resolve)); await app.close(); });
  let count = 0, loseCheckoutReply = false, lostCheckoutSnapshot = null;
  const checkoutRequests = [];
  const transport = async request => {
    if (request.url.endsWith('/checkout')) checkoutRequests.push({ key: request.headers['Idempotency-Key'], body: structuredClone(request.body) });
    const response = await fetch(request.url, { method: request.method, headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    const result = { status: response.status, data: await response.json() };
    if (loseCheckoutReply && request.url.endsWith('/checkout')) {
      loseCheckoutReply = false; lostCheckoutSnapshot = structuredClone(result.data.data);
      throw new Error('response dropped after server committed');
    }
    return result;
  };
  return { client: () => createFarmClient({ baseURL, transport, generateKey: () => `joint-request-${++count}` }),
    get lostCheckoutSnapshot() { return lostCheckoutSnapshot; },
    checkoutRequests, loseNextCheckout() { loseCheckoutReply = true; },
    rejectNextCheckout(status, code) { assert.ok(gateway, 'the test must explicitly create a real HTTP gateway'); nextRejection = { status, code }; },
    replaceNextCheckoutReply(status, code) { assert.ok(gateway, 'the test must explicitly create a real HTTP gateway'); nextReplyReplacement = { status, code }; } };
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

for (const [status, code] of [[503, 'SERVICE_DRAINING'], [503, 'CAPABILITY_UNAVAILABLE'], [429, 'RATE_LIMITED'],
  [403, 'ORIGIN_FORBIDDEN'], [404, 'NOT_FOUND'], [400, 'INVALID_REQUEST']]) {
  test(`real committed checkout survives a gateway ${status} ${code} during receipt reconciliation`, async t => {
    const h = await fixture(t, { withGateway: true, clock: () => Date.parse('2026-10-27T08:00:00Z') }), client = h.client();
    await client.loginDevelopment('gateway-recovery'); await client.load();
    await client.mutate('/cart/items', { sku: 'feed-pack', delta: 2 });
    h.loseNextCheckout();
    await assert.rejects(() => client.mutate('/checkout', { couponId: 'welcome-20' }), { code: 'RESULT_UNKNOWN' });
    h.rejectNextCheckout(status, code);
    await assert.rejects(() => client.retryPending(), { code: 'RESULT_UNKNOWN' });
    assert.equal(client.hasPending(), true);
    await assert.rejects(() => client.mutate('/activities/sign-in'), { code: 'PENDING_OPERATION' });
    const observer = h.client(); await observer.loginDevelopment('gateway-recovery'); await observer.load();
    assert.equal(observer.snapshot.wallet.points, 40); assert.equal(observer.snapshot.wallet.feed, 12);
    assert.equal(observer.snapshot.system.purchases.length, 1);
    await client.retryPending();
    assert.equal(client.hasPending(), false);
    assert.equal(client.snapshot.wallet.points, 40); assert.equal(client.snapshot.wallet.feed, 12);
    assert.equal(client.snapshot.system.purchases.length, 1);
    assert.deepEqual(client.snapshot, h.lostCheckoutSnapshot, 'the original committed response is recovered, not a replacement operation');
    assert.equal(h.checkoutRequests.length, 3);
    assert.deepEqual(h.checkoutRequests[1], h.checkoutRequests[0]);
    assert.deepEqual(h.checkoutRequests[2], h.checkoutRequests[0]);
  });
}

test('an actual 401 during receipt retry preserves the original checkout across reauthentication', async t => {
  let now = Date.parse('2026-10-27T08:00:00Z');
  const h = await fixture(t, { clock: () => now, sessionTtlMs: 60000 }), client = h.client();
  await client.loginDevelopment('retry-expired-original'); await client.load();
  await client.mutate('/cart/items', { sku: 'feed-pack', delta: 1 });
  h.loseNextCheckout();
  await assert.rejects(() => client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  now += 60001;
  await assert.rejects(() => client.retryPending(), { code: 'UNAUTHENTICATED', status: 401 });
  assert.equal(client.authenticated, false); assert.equal(client.hasPending(), true);
  await client.loginDevelopment('retry-expired-original'); await client.load(); await client.retryPending();
  assert.equal(client.hasPending(), false);
  assert.equal(client.snapshot.wallet.points, 50); assert.equal(client.snapshot.wallet.feed, 9);
  assert.equal(client.snapshot.system.purchases.length, 1);
  assert.equal(h.checkoutRequests.length, 3);
  assert.deepEqual(h.checkoutRequests[1], h.checkoutRequests[0]);
  assert.deepEqual(h.checkoutRequests[2], h.checkoutRequests[0]);
});

test('a gateway structured 503 replacing an initial committed success still requires receipt reconciliation', async t => {
  const h = await fixture(t, { withGateway: true, clock: () => Date.parse('2026-10-27T08:00:00Z') }), client = h.client();
  await client.loginDevelopment('initial-gateway-recovery'); await client.load();
  await client.mutate('/cart/items', { sku: 'feed-pack', delta: 1 });
  h.replaceNextCheckoutReply(503, 'SERVICE_DRAINING');
  await assert.rejects(() => client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  assert.equal(client.hasPending(), true);
  const observer = h.client(); await observer.loginDevelopment('initial-gateway-recovery'); await observer.load();
  assert.equal(observer.snapshot.wallet.points, 50); assert.equal(observer.snapshot.wallet.feed, 9);
  assert.equal(observer.snapshot.system.purchases.length, 1);
  await client.retryPending();
  assert.equal(client.hasPending(), false);
  assert.equal(client.snapshot.wallet.points, 50); assert.equal(client.snapshot.wallet.feed, 9);
  assert.equal(client.snapshot.system.purchases.length, 1);
  assert.equal(h.checkoutRequests.length, 2); assert.deepEqual(h.checkoutRequests[1], h.checkoutRequests[0]);
});
