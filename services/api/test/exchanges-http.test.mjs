import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.mjs';
import { createBackup, restoreBackup } from '../tools/sqlite-backup.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const DAY = 86400000;
const exchangeId = (owner, key) => 'shop-api-' + createHash('sha256').update(owner + '\n' + key).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-exchanges-test-'));
  const sourceDirectory = path.join(directory, 'source');
  await mkdir(sourceDirectory);
  const file = path.join(sourceDirectory, 'farm.sqlite'), logs = [], apps = [];
  let instant = NOW, serial = 0;
  async function service(databasePath = file, overrides = {}) {
    const app = createApp({ databasePath, mode: 'development', allowDevelopmentAuth: true,
      clock: () => instant, sessionTtlMs: 30 * DAY, logger: entry => logs.push(entry),
      developmentAuthLimit: { maxAttempts: 1000, windowMs: 60000 },
      requestRateLimit: { maxRequests: 10000, windowMs: 60000 }, ...options, ...overrides });
    apps.push(app);
    const port = await listenOnFetchSafePort(app.server), base = `http://127.0.0.1:${port}/api/v1`;
    const request = async (route, { token, body, key, method = body === undefined ? 'GET' : 'POST', headers = {}, discard = false } = {}) => {
      const response = await fetch(base + route, { method, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }), ...headers,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (discard) { await response.body.cancel(); return { status: response.status }; }
      return { status: response.status, json: await response.json(), headers: response.headers };
    };
    const login = async (account = 'exchange-owner') => {
      const result = await request('/auth/development', { body: { account } });
      assert.equal(result.status, 200); return result.json.data;
    };
    const snapshot = async token => {
      const result = await request('/bootstrap', { token });
      assert.equal(result.status, 200); return result.json.data;
    };
    const mutate = async (token, route, fields = {}, key = `exchange-operation-${++serial}`, extra = {}) => {
      const before = await snapshot(token);
      const result = await request(route, { token, body: { expectedRevision: before.revision, ...fields }, key, ...extra });
      assert.equal(result.status, 200, JSON.stringify(result.json)); return result;
    };
    const checkout = async (token, key, { sku = 'fertilizer', quantity = 1, couponId, discard = false } = {}) => {
      await mutate(token, '/cart/items', { sku, delta: quantity });
      return mutate(token, '/checkout', couponId ? { couponId } : {}, key, { discard });
    };
    return { app, request, login, snapshot, mutate, checkout, base };
  }
  function state(owner, edit) {
    const db = new DatabaseSync(file, { readOnly: !edit });
    try {
      const row = db.prepare('SELECT state_json, revision, updated_at FROM users WHERE id = ?').get(owner);
      if (edit) {
        const value = JSON.parse(row.state_json); edit(value);
        db.prepare('UPDATE users SET state_json = ? WHERE id = ?').run(JSON.stringify(value), owner);
      }
      return { ...row, idempotencyCount: db.prepare('SELECT count(*) AS count FROM idempotency WHERE user_id = ?').get(owner).count };
    } finally { db.close(); }
  }
  t.after(async () => {
    for (const app of apps) await app.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('farm-exchanges-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { service, file, directory, logs, state, setTime: value => { instant = value; } };
}

test('authenticated HTTP exchange pages use stable exclusive cursors while new checkouts append', async t => {
  const f = await fixture(t), s = await f.service(), auth = await s.login(), ids = [];
  for (let i = 0; i < 23; i++) {
    f.setTime(NOW + i * DAY);
    await s.mutate(auth.token, '/activities/sign-in');
    const key = `historical-checkout-${String(i).padStart(2, '0')}`;
    await s.checkout(auth.token, key); ids.push(exchangeId(auth.profile.id, key));
  }
  const before = await s.snapshot(auth.token), raw = f.state(auth.profile.id);
  const first = await s.request('/account/exchanges/start', { token: auth.token });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.data.items.map(item => item.id), ids.slice(3).reverse());
  assert.equal(first.json.data.exchangeFormat, 1); assert.equal(first.json.data.ownerId, auth.profile.id);
  assert.equal(first.json.data.environment, 'development'); assert.equal(first.json.data.serverTime, NOW + 22 * DAY);
  assert.equal(first.json.data.nextCursor, ids[3]); assert.match(first.headers.get('cache-control'), /no-store/);
  assert.equal(first.headers.get('pragma'), 'no-cache');
  assert.deepEqual(f.state(auth.profile.id), raw);
  assert.deepEqual(await s.snapshot(auth.token), before);
  await s.checkout(auth.token, 'new-after-page-checkout');
  const second = await s.request('/account/exchanges/' + first.json.data.nextCursor, { token: auth.token });
  assert.equal(second.status, 200); assert.deepEqual(second.json.data.items.map(item => item.id), ids.slice(0, 3).reverse());
  assert.equal(second.json.data.nextCursor, null);
  assert.equal(new Set([...first.json.data.items, ...second.json.data.items].map(item => item.id)).size, 23);
  const refreshed = await s.request('/account/exchanges/start', { token: auth.token });
  assert.equal(refreshed.json.data.items[0].id, exchangeId(auth.profile.id, 'new-after-page-checkout'));
  assert.deepEqual((await s.request('/account/exchanges/' + ids[0], { token: auth.token })).json.data.items, []);
});

test('HTTP checkout key lookup returns the discarded original receipt after a newer checkout and never reissues assets', async t => {
  const f = await fixture(t), s = await f.service(), auth = await s.login('exchange-lost-result');
  const originalKey = 'private-original-checkout-key';
  await s.checkout(auth.token, originalKey, { sku: 'feed-pack', quantity: 2, couponId: 'welcome-20', discard: true });
  await s.checkout(auth.token, 'newer-checkout-result');
  const before = await s.snapshot(auth.token), raw = f.state(auth.profile.id);
  const old = await s.request('/account/checkout-receipt', { token: auth.token, key: originalKey });
  assert.equal(old.status, 200); assert.equal(old.json.data.ownerId, auth.profile.id); assert.equal(old.json.data.environment, 'development');
  assert.deepEqual(old.json.data.exchange, { id: exchangeId(auth.profile.id, originalKey), day: '2026-10-27',
    items: [{ sku: 'feed-pack', title: '日常饲料包', art: 'feed', quantity: 2, unitPoints: 30, linePoints: 60, grant: { feed: 3 } }],
    count: 2, subtotal: 60, discount: 20, total: 40, couponId: 'welcome-20', received: { feed: 6 } });
  assert.equal(JSON.stringify(old.json).includes(originalKey), false);
  const detail = await s.request('/account/exchange/' + old.json.data.exchange.id, { token: auth.token });
  assert.deepEqual(detail.json.data, old.json.data);
  assert.deepEqual(await s.snapshot(auth.token), before); assert.deepEqual(f.state(auth.profile.id), raw);
  assert.equal(before.wallet.feed, 12); assert.equal(before.wallet.points, 20);
  assert.equal(before.system.coupons.find(coupon => coupon.id === 'welcome-20').used, true);
});

test('exchange reads across Shanghai midnight do not sync daily financial state or advance revisions', async t => {
  const f = await fixture(t), s = await f.service(), auth = await s.login('exchange-midnight');
  await s.checkout(auth.token, 'midnight-checkout-key');
  const before = f.state(auth.profile.id), id = exchangeId(auth.profile.id, 'midnight-checkout-key');
  f.setTime(NOW + DAY);
  for (const [route, key] of [['/account/exchanges/start'], ['/account/exchange/' + id], ['/account/checkout-receipt', 'midnight-checkout-key']]) {
    const result = await s.request(route, { token: auth.token, key });
    assert.equal(result.status, 200); assert.equal(result.json.data.serverTime, NOW + DAY);
  }
  assert.deepEqual(f.state(auth.profile.id), before);
  f.setTime(NOW);
  assert.equal((await s.request('/account/exchanges/start', { token: auth.token })).json.data.serverTime, NOW + DAY);
});

test('missing or foreign exchange details and keys are indistinguishable and foreign cursors cannot page another owner', async t => {
  const f = await fixture(t), s = await f.service(), a = await s.login('exchange-owner-a'), b = await s.login('exchange-owner-b');
  await s.checkout(a.token, 'owner-a-checkout-key');
  const id = exchangeId(a.profile.id, 'owner-a-checkout-key'), missing = 'shop-api-' + '0'.repeat(64);
  const privateDetail = await s.request('/account/exchange/' + id, { token: b.token });
  const missingDetail = await s.request('/account/exchange/' + missing, { token: b.token });
  const foreignKey = await s.request('/account/checkout-receipt', { token: b.token, key: 'owner-a-checkout-key' });
  const missingKey = await s.request('/account/checkout-receipt', { token: b.token, key: 'missing-checkout-key' });
  for (const result of [privateDetail, missingDetail, foreignKey, missingKey]) {
    assert.equal(result.status, 404); assert.equal(result.json.error.code, 'EXCHANGE_NOT_FOUND');
    assert.equal(JSON.stringify(result.json).includes(a.profile.id), false);
    assert.deepEqual(result.json.error, privateDetail.json.error);
  }
  for (const cursor of [id, missing]) {
    const result = await s.request('/account/exchanges/' + cursor, { token: b.token });
    assert.equal(result.status, 400); assert.equal(result.json.error.code, 'EXCHANGE_CURSOR_INVALID');
  }
  const empty = await s.request('/account/exchanges/start', { token: b.token });
  assert.equal(empty.status, 200); assert.deepEqual(empty.json.data.items, []); assert.equal(empty.json.data.nextCursor, null);
});

test('exchange endpoints require bearer sessions, validate parameters and methods, and log only route templates', async t => {
  const f = await fixture(t), s = await f.service(), auth = await s.login('private-exchange-log-account');
  const privateKey = 'private-log-checkout-key';
  await s.checkout(auth.token, privateKey);
  const id = exchangeId(auth.profile.id, privateKey);
  for (const route of ['/account/exchanges/start', '/account/exchange/' + id, '/account/checkout-receipt']) {
    assert.equal((await s.request(route, { key: privateKey })).status, 401);
    assert.equal((await s.request(route, { token: auth.token, key: privateKey, body: {} })).status, 405);
    assert.equal((await s.request(route, { token: auth.token, key: privateKey })).status, 200);
    assert.equal((await s.request(route + '?ownerId=private-query-sentinel', { token: auth.token, key: privateKey })).status, 400);
  }
  for (const cursor of ['BAD', '%20', 'shop-api-' + 'A'.repeat(64)]) {
    const result = await s.request('/account/exchanges/' + cursor, { token: auth.token });
    assert.equal(result.status, 400); assert.equal(result.json.error.code, 'EXCHANGE_CURSOR_INVALID');
  }
  for (const bad of ['BAD', '%20', 'shop-api-' + 'A'.repeat(64)]) {
    assert.equal((await s.request('/account/exchange/' + bad, { token: auth.token })).status, 400);
  }
  for (const key of [undefined, 'short', 'bad key invalid', 'a'.repeat(101)]) {
    assert.equal((await s.request('/account/checkout-receipt', { token: auth.token, key })).status, 400);
  }
  const logs = JSON.stringify(f.logs);
  for (const privateValue of [id, auth.profile.id, auth.token, privateKey, 'private-query-sentinel', 'private-exchange-log-account']) {
    assert.equal(logs.includes(privateValue), false, 'logs must exclude ' + privateValue);
  }
  assert.ok(f.logs.some(entry => entry.route === '/api/v1/account/exchanges/:cursor'));
  assert.ok(f.logs.some(entry => entry.route === '/api/v1/account/exchange/:exchangeId'));
  assert.ok(f.logs.some(entry => entry.route === '/api/v1/account/checkout-receipt'));
  assert.equal((await s.request('/auth/logout', { token: auth.token, body: {} })).status, 200);
  for (const route of ['/account/exchanges/start', '/account/exchange/' + id, '/account/checkout-receipt']) {
    assert.equal((await s.request(route, { token: auth.token, key: privateKey })).status, 401);
  }
});

test('HTTP exchange history projects saved historical fields without consulting the current catalog', async t => {
  const f = await fixture(t), s = await f.service(), auth = await s.login('exchange-old-catalog');
  const key = 'old-catalog-checkout-key';
  await s.checkout(auth.token, key);
  f.state(auth.profile.id, state => {
    const purchase = state.system.purchases[0];
    purchase.items[0].id = 'retired-fertilizer'; purchase.items[0].title = '合成历史养护物资';
    purchase.items[0].cost = 7; purchase.items[0].lineTotal = 7; purchase.items[0].grant = { fertilizer: 4, tools: 2 };
    purchase.subtotal = 7; purchase.total = 7;
  });
  const result = await s.request('/account/exchange/' + exchangeId(auth.profile.id, key), { token: auth.token });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.data.exchange.items[0], { sku: 'retired-fertilizer', title: '合成历史养护物资', art: 'fertilizer',
    quantity: 1, unitPoints: 7, linePoints: 7, grant: { fertilizer: 4, tools: 2 } });
  assert.deepEqual(result.json.data.exchange.received, { fertilizer: 4, tools: 2 });
  assert.equal(result.json.data.exchange.total, 7);
});

test('corrupt stored exchange data fails closed with a fixed error and no private data or financial mutation', async t => {
  const f = await fixture(t), s = await f.service(), auth = await s.login('exchange-corrupt');
  const key = 'corrupt-receipt-checkout-key';
  await s.checkout(auth.token, key);
  f.state(auth.profile.id, state => { state.system.purchases[0].items[0].title = 'private-broken-history-sentinel'; state.system.purchases[0].total = -1; });
  const before = f.state(auth.profile.id);
  for (const [route, lookupKey] of [['/account/exchanges/start'], ['/account/exchange/' + exchangeId(auth.profile.id, key)], ['/account/checkout-receipt', key]]) {
    const result = await s.request(route, { token: auth.token, key: lookupKey });
    assert.equal(result.status, 500); assert.equal(result.json.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(result.json).includes('private-broken-history-sentinel'), false);
    assert.equal(JSON.stringify(result.json).includes(auth.profile.id), false);
  }
  assert.deepEqual(f.state(auth.profile.id), before);
  assert.equal(JSON.stringify(f.logs).includes('private-broken-history-sentinel'), false);
});

test('HTTP history and original-key lookup survive restart and isolated backup restore while old sessions are invalidated', async t => {
  const f = await fixture(t), source = await f.service(), auth = await source.login('exchange-persistence');
  const key = 'persistent-original-checkout-key';
  await source.checkout(auth.token, key);
  await source.checkout(auth.token, 'persistent-new-checkout-key');
  const before = await source.snapshot(auth.token);
  const pageResponse = await source.request('/account/exchanges/start', { token: auth.token });
  assert.equal(pageResponse.status, 200);
  const page = pageResponse.json.data;
  assert.equal(page.items.length, 2);
  const detail = (await source.request('/account/checkout-receipt', { token: auth.token, key })).json.data;
  await source.app.close();
  const restarted = await f.service();
  assert.deepEqual((await restarted.request('/account/exchanges/start', { token: auth.token })).json.data, page);
  assert.deepEqual((await restarted.request('/account/checkout-receipt', { token: auth.token, key })).json.data, detail);
  const backupDirectory = path.join(f.directory, 'backup'), restoredDirectory = path.join(f.directory, 'restored');
  await createBackup({ databasePath: f.file, outputDirectory: backupDirectory });
  await restoreBackup({ backupDirectory, outputDirectory: restoredDirectory });
  const restored = await f.service(path.join(restoredDirectory, 'farm.sqlite'));
  assert.equal((await restored.request('/account/exchanges/start', { token: auth.token })).status, 401);
  const newAuth = await restored.login('exchange-persistence');
  assert.equal(newAuth.profile.id, auth.profile.id);
  assert.deepEqual((await restored.request('/account/exchanges/start', { token: newAuth.token })).json.data, page);
  assert.deepEqual((await restored.request('/account/checkout-receipt', { token: newAuth.token, key })).json.data, detail);
  assert.deepEqual(await restored.snapshot(newAuth.token), before);
});

test('production history stays authenticated and cannot open closed business capabilities or development-environment records', async t => {
  const f = await fixture(t), dev = await f.service(), development = await dev.login('environment-account');
  await dev.checkout(development.token, 'environment-checkout-key');
  const production = await f.service(f.file, { mode: 'production', allowDevelopmentAuth: false,
    platformProviders: { weixin: async () => ({ subject: 'production-subject' }) } });
  assert.equal((await production.request('/account/exchanges/start', { token: development.token })).status, 401);
  const login = await production.request('/auth/platform', { body: { platform: 'weixin', code: 'synthetic-production-code' } });
  assert.equal(login.status, 200);
  const auth = login.json.data, before = await production.snapshot(auth.token);
  const page = await production.request('/account/exchanges/start', { token: auth.token });
  assert.equal(page.status, 200); assert.equal(page.json.data.environment, 'production'); assert.deepEqual(page.json.data.items, []);
  const foreign = await production.request('/account/exchange/' + exchangeId(development.profile.id, 'environment-checkout-key'), { token: auth.token });
  assert.equal(foreign.status, 404); assert.equal(foreign.json.error.code, 'EXCHANGE_NOT_FOUND');
  assert.equal((await production.request('/account/checkout-receipt', { token: auth.token, key: 'environment-checkout-key' })).status, 404);
  assert.deepEqual(await production.snapshot(auth.token), before);
  assert.ok(Object.values(before.capabilities).every(value => value === false));
});
