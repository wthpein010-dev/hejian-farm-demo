import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

let api = {};
try { api = await import('../src/server.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const NOW = Date.parse('2026-10-27T04:00:00Z');
let serial = 0;
const key = () => `test-request-${++serial}`;

async function start(t, options = {}) {
  assert.equal(typeof api.createApp, 'function', 'createApp must expose a real HTTP/SQLite service');
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-api-test-'));
  const file = path.join(directory, 'farm.sqlite');
  let instant = NOW;
  let app = api.createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true,
    clock: () => instant, allowedOrigins: ['http://127.0.0.1:5173'], ...options });
  const listen = async () => {
    const port = await listenOnFetchSafePort(app.server);
    return `http://127.0.0.1:${port}/api/v1`;
  };
  let base = await listen();
  const request = async (route, { token, body, idempotencyKey, method = body === undefined ? 'GET' : 'POST', headers = {}, raw } = {}) => {
    const response = await fetch(base + route, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...headers,
    }, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers, text };
  };
  const login = async (account = 'farm-tester') => {
    const r = await request('/auth/development', { body: { account } });
    assert.equal(r.status, 200, r.text);
    return r.json.data;
  };
  const snapshot = async token => {
    const r = await request('/bootstrap', { token });
    assert.equal(r.status, 200, r.text);
    return r.json.data;
  };
  const mutate = (token, route, body, idempotencyKey = key()) => request(route, { token, body, idempotencyKey });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(file), directory);
    assert.equal(directory.startsWith(path.join(tmpdir(), 'farm-api-test-')), true);
    await rm(directory, { recursive: true, force: true });
  });
  return { request, login, snapshot, mutate, file, directory,
    setTime: value => { instant = value; }, getApp: () => app,
    restart: async () => {
      await app.close();
      app = api.createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true,
        clock: () => instant, allowedOrigins: ['http://127.0.0.1:5173'], ...options });
      base = await listen();
    }, getBase: () => base,
  };
}

async function finishBodyAfter(fixture, token, route, advanceClock) {
  const server = fixture.getApp().server;
  const observed = new Promise(resolve => {
    const listener = request => { if (request.url === '/api/v1' + route) { server.off('request', listener); resolve(); } };
    server.on('request', listener);
  });
  let outgoing;
  const completed = new Promise((resolve, reject) => {
    outgoing = httpRequest(fixture.getBase() + route, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key(),
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject);
  });
  outgoing.write('{"expectedRevision":');
  await observed; advanceClock(); outgoing.end('0}');
  return completed;
}

test('explicit development identity returns an authoritative bootstrap with restricted capabilities', async t => {
  const f = await start(t), auth = await f.login();
  assert.match(auth.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(auth.expiresAt > NOW);
  const s = await f.snapshot(auth.token);
  assert.equal(s.serverTime, NOW); assert.equal(s.revision, 0);
  assert.equal(s.environment, 'development'); assert.equal(s.profile.id, auth.profile.id);
  assert.deepEqual([s.wallet.points, s.wallet.feed], [80, 6]);
  assert.equal(s.catalog.length, 8); assert.equal(s.tasks.length, 3);
  assert.equal(s.achievements.length, 4); assert.equal(s.signIn.todayClaimed, false);
  assert.deepEqual(s.farm, { plots: [], animals: [] });
  assert.deepEqual(s.capabilities, { pointShop: true, activities: true, care: false, adoption: false,
    live: false, shipping: false, payments: false, advertising: false });
});

test('production rejects development-auth configuration and unavailable platform identity returns 503', async t => {
  assert.equal(typeof api.createApp, 'function', 'createApp must exist');
  assert.throws(() => api.createApp({ databasePath: ':memory:', mode: 'production', allowDevelopmentAuth: true }), /development|开发/i);
  const f = await start(t, { mode: 'production', allowDevelopmentAuth: false, allowedOrigins: [] });
  assert.equal((await f.request('/auth/development', { body: { account: 'tester' } })).status, 503);
  const r = await f.request('/auth/platform', { body: { platform: 'weixin', code: 'one-use-platform-code' } });
  assert.equal(r.status, 503); assert.equal(r.json.error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(r.text.includes('one-use-platform-code'), false);
});

test('an injected verified provider creates a production account with zero assets and closed business gates', async t => {
  const f = await start(t, { mode: 'production', allowDevelopmentAuth: false, allowedOrigins: ['https://farm.example'],
    platformProviders: { weixin: async ({ code }) => { assert.equal(code, 'verified-code'); return { subject: 'verified-test-user' }; } } });
  const r = await f.request('/auth/platform', { body: { platform: 'weixin', code: 'verified-code' } });
  assert.equal(r.status, 200);
  const s = await f.snapshot(r.json.data.token);
  assert.equal(s.wallet.points, 0); assert.equal(s.wallet.feed, 0); assert.equal(s.system.xp, 0);
  assert.deepEqual(s.system.coupons, []); assert.ok(Object.values(s.system.inventory).every(n => n === 0));
  assert.ok(Object.values(s.capabilities).every(enabled => enabled === false));
  assert.equal((await f.mutate(r.json.data.token, '/activities/sign-in', { expectedRevision: 0 })).status, 503);
});

test('SQLite persists the same account, session and checkout across an actual service restart', async t => {
  const f = await start(t), auth = await f.login('persistent-account');
  const cart = await f.mutate(auth.token, '/cart/items', { sku: 'feed-pack', delta: 2, expectedRevision: 0 });
  assert.equal(cart.status, 200);
  const paid = await f.mutate(auth.token, '/checkout', { couponId: 'welcome-20', expectedRevision: 1 }, 'restart-checkout');
  assert.equal(paid.status, 200); assert.deepEqual([paid.json.data.wallet.points, paid.json.data.wallet.feed], [40, 12]);
  await f.restart();
  assert.deepEqual(await f.snapshot(auth.token), paid.json.data);
  const again = await f.login('persistent-account');
  assert.equal(again.profile.id, auth.profile.id); assert.notEqual(again.token, auth.token);
  assert.deepEqual((await f.snapshot(again.token)).wallet, paid.json.data.wallet);
  const db = new DatabaseSync(f.file, { readOnly: true });
  const sessions = db.prepare('SELECT token_hash FROM sessions').all();
  assert.equal(sessions.some(row => row.token_hash === createHash('sha256').update(auth.token).digest('hex')), true);
  assert.equal(sessions.some(row => row.token_hash === auth.token), false);
  db.close();
});

test('users cannot read or mutate another account and identical idempotency keys are user scoped', async t => {
  const f = await start(t), a = await f.login('first-user'), b = await f.login('second-user');
  assert.notEqual(a.profile.id, b.profile.id);
  assert.equal((await f.request('/bootstrap')).status, 401);
  assert.equal((await f.request('/bootstrap', { token: 'invalid-token' })).status, 401);
  const forged = await f.mutate(a.token, '/cart/items', { sku: 'feed-pack', delta: 1, expectedRevision: 0, userId: b.profile.id });
  assert.equal(forged.status, 400);
  for (const user of [a, b]) {
    const r = await f.mutate(user.token, '/activities/sign-in', { expectedRevision: 0 }, 'same-key-users');
    assert.equal(r.status, 200); assert.equal(r.json.data.profile.id, user.profile.id); assert.equal(r.json.data.wallet.points, 100);
  }
  const read = await f.request('/bootstrap', { token: a.token, headers: { 'X-User-Id': b.profile.id } });
  assert.equal(read.json.data.profile.id, a.profile.id);
});

test('successful replay precedes version checks and preserves its original result after subsequent writes', async t => {
  const f = await start(t), { token } = await f.login();
  const first = await f.mutate(token, '/activities/sign-in', { expectedRevision: 0 }, 'signin-replay-key');
  assert.equal(first.status, 200);
  await f.mutate(token, '/cart/items', { sku: 'fertilizer', delta: 1, expectedRevision: 1 });
  const replay = await f.mutate(token, '/activities/sign-in', { expectedRevision: 0 }, 'signin-replay-key');
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.data, first.json.data);
  const altered = await f.mutate(token, '/activities/sign-in', { expectedRevision: 2 }, 'signin-replay-key');
  assert.equal(altered.status, 409); assert.equal(altered.json.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(altered.json.data.revision, 2); assert.equal((await f.snapshot(token)).wallet.points, 100);
});

test('concurrent distinct writes with the same revision commit once and return the current conflict snapshot', async t => {
  const f = await start(t), { token } = await f.login();
  const results = await Promise.all([f.mutate(token, '/activities/sign-in', { expectedRevision: 0 }), f.mutate(token, '/activities/sign-in', { expectedRevision: 0 })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const conflict = results.find(r => r.status === 409);
  assert.equal(conflict.json.error.code, 'REVISION_CONFLICT'); assert.equal(conflict.json.data.revision, 1);
  const s = await f.snapshot(token);
  assert.equal(s.wallet.points, 100); assert.equal(s.system.signedDays.length, 1);
});

test('concurrent identical writes replay one successful transaction instead of granting twice', async t => {
  const f = await start(t), { token } = await f.login();
  const results = await Promise.all([f.mutate(token, '/activities/sign-in', { expectedRevision: 0 }, 'parallel-same-key'), f.mutate(token, '/activities/sign-in', { expectedRevision: 0 }, 'parallel-same-key')]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(results.filter(r => r.json.replayed).length, 1);
  assert.equal((await f.snapshot(token)).wallet.points, 100);
});

test('lost checkout response can be retried with the same key after restart without a second debit', async t => {
  const f = await start(t), { token } = await f.login();
  await f.mutate(token, '/cart/items', { sku: 'feed-pack', delta: 2, expectedRevision: 0 });
  const response = await fetch(f.getBase() + '/checkout', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'lost-response-checkout',
  }, body: JSON.stringify({ couponId: 'welcome-20', expectedRevision: 1 }) });
  assert.equal(response.status, 200); await response.body.cancel();
  await f.restart();
  const replay = await f.mutate(token, '/checkout', { couponId: 'welcome-20', expectedRevision: 1 }, 'lost-response-checkout');
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  const s = await f.snapshot(token);
  assert.deepEqual([s.wallet.points, s.wallet.feed, s.system.purchases.length, s.revision], [40, 12, 1, 2]);
});

test('invalid stock, insufficient points and invalid coupons leave economic state unchanged', async t => {
  const f = await start(t), { token } = await f.login();
  assert.equal((await f.mutate(token, '/cart/items', { sku: 'feed-pack', delta: 6, expectedRevision: 0 })).status, 422);
  let r = await f.mutate(token, '/cart/items', { sku: 'feed-pack', delta: 5, expectedRevision: 0 });
  assert.equal(r.status, 200); const before = r.json.data;
  r = await f.mutate(token, '/checkout', { expectedRevision: 1 });
  assert.equal(r.status, 422); assert.deepEqual(await f.snapshot(token), before);
  r = await f.mutate(token, '/checkout', { expectedRevision: 1, couponId: 'missing-coupon' });
  assert.equal(r.status, 422); assert.deepEqual(await f.snapshot(token), before);
});

test('server-owned shop event and task rewards are once daily and forged care or harvest cannot award assets', async t => {
  const f = await start(t), { token } = await f.login();
  let r = await f.mutate(token, '/events/shop-visit', { expectedRevision: 0 });
  assert.equal(r.status, 200); assert.equal(r.json.data.tasks.find(task => task.id === 'browse').ready, true);
  let s = r.json.data;
  r = await f.mutate(token, '/events/shop-visit', { expectedRevision: s.revision });
  assert.equal(r.status, 200); assert.equal(r.json.data.system.xp, s.system.xp); s = r.json.data;
  r = await f.mutate(token, '/activities/tasks/browse/claim', { expectedRevision: s.revision });
  assert.equal(r.status, 200); assert.equal(r.json.data.wallet.points, 90); s = r.json.data;
  assert.equal((await f.mutate(token, '/activities/tasks/browse/claim', { expectedRevision: s.revision })).status, 422);
  for (const route of ['/events/care', '/events/harvest', '/activities/tasks/care/claim', '/activities/season/claim']) {
    const denied = await f.mutate(token, route, { expectedRevision: s.revision });
    assert.ok([404, 422].includes(denied.status), denied.text);
  }
  assert.deepEqual((await f.snapshot(token)).wallet, s.wallet);
});

test('Shanghai daily state and token expiry never move backwards with server clock rollback', async t => {
  const f = await start(t, { sessionTtlMs: 8 * 86400000 });
  f.setTime(Date.parse('2026-10-27T15:59:59Z'));
  const { token } = await f.login();
  let r = await f.mutate(token, '/activities/sign-in', { expectedRevision: 0 });
  assert.equal(r.json.data.system.daily.day, '2026-10-27');
  const next = Date.parse('2026-10-27T16:00:00Z'); f.setTime(next);
  let s = await f.snapshot(token);
  assert.equal(s.system.daily.day, '2026-10-28'); assert.equal(s.revision, 2);
  f.setTime(NOW);
  assert.deepEqual(await f.snapshot(token), s);
  r = await f.mutate(token, '/activities/sign-in', { expectedRevision: s.revision });
  assert.equal(r.status, 200); assert.equal(r.json.data.wallet.points, 130); assert.equal(r.json.data.serverTime, next);
  await f.restart(); assert.equal((await f.snapshot(token)).serverTime, next);
});

test('three server-dated sign-ins unlock one achievement without client completion fields', async t => {
  const f = await start(t, { sessionTtlMs: 8 * 86400000 }), { token } = await f.login();
  for (let day = 0; day < 3; day++) {
    f.setTime(NOW + day * 86400000);
    const s = await f.snapshot(token);
    const r = await f.mutate(token, '/activities/sign-in', { expectedRevision: s.revision });
    assert.equal(r.status, 200);
  }
  let s = await f.snapshot(token);
  assert.equal(s.achievements.find(a => a.id === 'three-checkins').ready, true);
  const r = await f.mutate(token, '/activities/achievements/three-checkins/claim', { expectedRevision: s.revision });
  assert.equal(r.status, 200); assert.deepEqual([r.json.data.wallet.points, r.json.data.wallet.feed], [155, 7]);
  s = r.json.data;
  assert.equal((await f.mutate(token, '/activities/achievements/three-checkins/claim', { expectedRevision: s.revision })).status, 422);
});

test('logout and expiry revoke only the affected high-entropy session', async t => {
  const f = await start(t, { sessionTtlMs: 1000 }), a = await f.login(), b = await f.login();
  assert.equal((await f.request('/auth/logout', { token: a.token, body: {} })).status, 200);
  assert.equal((await f.request('/bootstrap', { token: a.token })).status, 401);
  assert.equal((await f.request('/bootstrap', { token: b.token })).status, 200);
  f.setTime(NOW + 1001);
  assert.equal((await f.request('/bootstrap', { token: b.token })).status, 401);
  f.setTime(NOW);
  assert.equal((await f.request('/bootstrap', { token: b.token })).status, 401);
});

test('JSON boundary rejects unknown fields, invalid types, oversized bodies and injected asset values safely', async t => {
  const f = await start(t), { token } = await f.login();
  for (const body of [
    { sku: 'feed-pack', delta: 1, expectedRevision: 0, points: 99999 },
    { sku: 'feed-pack', delta: 1, expectedRevision: '0' },
    { sku: 'feed-pack', delta: 0.5, expectedRevision: 0 },
    { sku: 'feed-pack', delta: 1, expectedRevision: 0, now: NOW + 86400000 },
    ['feed-pack'],
  ]) assert.equal((await f.mutate(token, '/cart/items', body)).status, 400);
  const infinity = await f.request('/cart/items', { token, method: 'POST', idempotencyKey: key(), raw: '{"sku":"feed-pack","delta":1,"expectedRevision":1e309}' });
  assert.equal(infinity.status, 400);
  const poison = await f.request('/cart/items', { token, method: 'POST', idempotencyKey: key(), raw: '{"__proto__":{"polluted":true},"sku":"feed-pack","delta":1,"expectedRevision":0}' });
  assert.equal(poison.status, 400); assert.equal({}.polluted, undefined);
  assert.equal((await f.request('/auth/development', { method: 'POST', raw: '{broken-json-secret' })).status, 400);
  const oversized = await f.request('/auth/development', { body: { account: 'a'.repeat(17000) } });
  assert.equal(oversized.status, 413); assert.ok(oversized.text.length < 500);
  assert.equal((await f.request('/auth/development', { body: { account: 'valid-account' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.deepEqual([(await f.snapshot(token)).wallet.points, (await f.snapshot(token)).revision], [80, 0]);
});

test('private responses are no-store and CORS allows only configured origins and headers', async t => {
  const f = await start(t), { token } = await f.login();
  const r = await f.request('/bootstrap', { token, headers: { Origin: 'http://127.0.0.1:5173' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.match(r.headers.get('cache-control'), /no-store/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.json.requestId, /^[A-Za-z0-9-]{20,}$/); assert.equal(r.headers.get('x-request-id'), r.json.requestId);
  assert.equal((await f.request('/bootstrap', { token, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const preflight = await f.request('/checkout', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.request('/checkout', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-untrusted' } })).status, 403);
});

test('development login rate limit ignores forged proxy headers and resets only after server time advances', async t => {
  const f = await start(t, { developmentAuthLimit: { maxAttempts: 2, windowMs: 60000 } });
  await f.login('limit-one'); await f.login('limit-two');
  const denied = await f.request('/auth/development', { body: { account: 'limit-three' }, headers: { 'X-Forwarded-For': '192.0.2.1' } });
  assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('retry-after')) > 0);
  f.setTime(NOW + 60001); assert.equal((await f.request('/auth/development', { body: { account: 'limit-three' } })).status, 200);
});

test('production cannot accept a previously issued development session even when sharing a database file', async t => {
  const f = await start(t), { token } = await f.login('environment-isolation');
  // Both connections share the persisted monotonic clock. Wall time here
  // would expire the synthetic development session once NOW + 30m passes.
  const production = api.createApp({ databasePath: f.file, mode: 'production', allowedOrigins: [], clock: () => NOW });
  try {
    await listenOnFetchSafePort(production.server);
    const response = await fetch(`http://127.0.0.1:${production.server.address().port}/api/v1/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401); await response.body.cancel();
    const after = await f.snapshot(token);
    assert.equal(after.profile.id.length, 36); assert.equal(after.serverTime, NOW);
  } finally { await production.close(); }
});

test('all HTTP requests are limited and malformed idempotency keys cannot mutate state', async t => {
  const f = await start(t), { token } = await f.login();
  for (const idempotencyKey of [undefined, 'short', 'contains spaces', 'a'.repeat(101)]) {
    const r = await f.request('/activities/sign-in', { token, body: { expectedRevision: 0 }, idempotencyKey });
    assert.equal(r.status, 400);
  }
  assert.equal((await f.snapshot(token)).revision, 0);
  const limited = await start(t, { requestRateLimit: { maxRequests: 2, windowMs: 60000 } });
  const auth = await limited.login(); await limited.snapshot(auth.token);
  const denied = await limited.request('/bootstrap', { token: auth.token, headers: { 'X-Forwarded-For': '192.0.2.2' } });
  assert.equal(denied.status, 429);
});

test('unsafe deployment configuration and future database schema fail at startup', async t => {
  assert.equal(typeof api.createApp, 'function', 'createApp must exist');
  assert.throws(() => api.createApp({ databasePath: ':memory:', clock: 'client-time' }), /clock|时钟/i);
  assert.throws(() => api.createApp({ databasePath: ':memory:', allowedOrigins: ['*'] }), /CORS/i);
  const { configFromEnvironment } = await import('../src/config.mjs');
  assert.throws(() => configFromEnvironment({ NODE_ENV: 'production', FARM_MODE: 'development', FARM_ALLOW_DEVELOPMENT_AUTH: 'true' }), /production|开发/i);
  const f = await start(t);
  const futureFile = path.join(f.directory, 'future.sqlite');
  const db = new DatabaseSync(futureFile); db.exec('PRAGMA user_version = 999'); db.close();
  assert.throws(() => api.createApp({ databasePath: futureFile }), /schema|版本/i);
});

test('a session expiring while a chunked JSON body arrives is rechecked before mutation commit', async t => {
  const f = await start(t, { sessionTtlMs: 1000 }), { token } = await f.login();
  const r = await finishBodyAfter(f, token, '/activities/sign-in', () => f.setTime(NOW + 1001));
  assert.equal(r.status, 401);
  const newSession = await f.login();
  assert.deepEqual([(await f.snapshot(newSession.token)).wallet.points, (await f.snapshot(newSession.token)).revision], [80, 0]);
});

test('a body completing after Shanghai midnight receives a current revision conflict without a backdated reward', async t => {
  const f = await start(t, { sessionTtlMs: 8 * 86400000 });
  f.setTime(Date.parse('2026-10-27T15:59:59Z'));
  const { token } = await f.login();
  const r = await finishBodyAfter(f, token, '/activities/sign-in', () => f.setTime(Date.parse('2026-10-27T16:00:00Z')));
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'REVISION_CONFLICT');
  assert.equal(r.json.data.system.daily.day, '2026-10-28');
  assert.equal(r.json.data.wallet.points, 80); assert.deepEqual(r.json.data.system.signedDays, []);
});

test('workspace startup resolves its default private database relative to the service rather than shell cwd', async t => {
  const f = await start(t), { configFromEnvironment } = await import('../src/config.mjs');
  const previous = process.cwd();
  try {
    process.chdir(f.directory);
    assert.equal(configFromEnvironment({}).databasePath, fileURLToPath(new URL('../data/farm.sqlite', import.meta.url)));
  } finally { process.chdir(previous); }
});

test('one platform code is claimed once across concurrent calls and restart without storing raw provider secrets', async t => {
  const { createPlatformProviders } = await import('../src/providers.mjs').catch(() => ({}));
  assert.equal(typeof createPlatformProviders, 'function', 'real official provider adapter must exist');
  let release, started, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const platformProviders = createPlatformProviders({ weixin: { appId: 'example-application', secret: 'example-server-secret' } }, {
    fetchImpl: async () => { calls++; started(); await gate; return new Response(JSON.stringify({ openid: 'example-provider-user', session_key: 'example-provider-session-key' })); },
  });
  const f = await start(t, { platformProviders });
  const body = { platform: 'weixin', code: 'example-one-use-code' };
  const first = f.request('/auth/platform', { body }); await entered;
  const concurrent = await f.request('/auth/platform', { body });
  assert.equal(concurrent.status, 409); assert.equal(concurrent.json.error.code, 'IDENTITY_CODE_USED');
  release(); const success = await first; assert.equal(success.status, 200);
  assert.deepEqual([(await f.snapshot(success.json.data.token)).wallet.points, calls], [0, 1]);
  await f.restart();
  assert.equal((await f.request('/auth/platform', { body })).status, 409); assert.equal(calls, 1);
  const db = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  const saved = JSON.stringify([db.prepare('SELECT * FROM code_claims').all(), db.prepare('SELECT * FROM users').all()]);
  for (const raw of [body.code, 'example-server-secret', 'example-provider-session-key', 'example-provider-user']) assert.equal(saved.includes(raw), false);
  db.close();
});

test('failed or uncertain platform exchange is not retried using the same code and never falls back to sandbox login', async t => {
  const { createPlatformProviders } = await import('../src/providers.mjs').catch(() => ({}));
  assert.equal(typeof createPlatformProviders, 'function', 'real official provider adapter must exist');
  let calls = 0;
  const platformProviders = createPlatformProviders({ toutiao: { appId: 'example-app', secret: 'example-provider-secret' } }, {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ err_no: 40017, err_tips: 'raw-example-provider-secret' })); },
  });
  const f = await start(t, { platformProviders }), body = { platform: 'toutiao', code: 'example-failed-code' };
  const denied = await f.request('/auth/platform', { body });
  assert.equal(denied.status, 502); assert.equal(denied.text.includes('example-provider-secret'), false);
  assert.equal((await f.request('/auth/platform', { body })).status, 409); assert.equal(calls, 1);
  const db = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0); db.close();
});

test('schema v1 upgrades preserve existing assets and sessions while creating the one-use code ledger', async t => {
  const f = await start(t), { token } = await f.login('schema-upgrade-account');
  const original = await f.mutate(token, '/activities/sign-in', { expectedRevision: 0 });
  await f.getApp().close();
  const old = new DatabaseSync(f.file);
  old.prepare('UPDATE idempotency SET success_json = ?').run(JSON.stringify(original.json.data));
  old.exec('DROP TABLE forum_commands; DROP TABLE forum_reports; DROP TABLE forum_content; DROP TABLE forum_usage; DROP TABLE forum_moderation; DROP TABLE friends_commands; DROP TABLE friends_blocks; DROP TABLE friends_relations; DROP TABLE friends_profiles; DROP TABLE IF EXISTS farm_record_events; DROP TABLE IF EXISTS farm_records; DROP TABLE IF EXISTS farm_imports; DROP TABLE code_claims; PRAGMA user_version = 1'); old.close();
  await f.restart();
  assert.equal((await f.snapshot(token)).wallet.points, 100);
  const upgraded = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM code_claims').get().count, 0); upgraded.close();
});
