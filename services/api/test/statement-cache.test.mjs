import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Agent, request as httpRequest } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

function observeNativePrepares(t) {
  const original = DatabaseSync.prototype.prepare, connections = new Map();
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    let record = connections.get(this);
    if (!record) { record = { attempts: 0, created: 0, sql: new Map() }; connections.set(this, record); }
    record.attempts++;
    record.sql.set(sql, (record.sql.get(sql) ?? 0) + 1);
    const statement = original.call(this, sql, ...args); record.created++;
    return statement;
  };
  t.after(() => { DatabaseSync.prototype.prepare = original; });
  return { connections, total: () => [...connections.values()].reduce((sum, entry) => sum + entry.created, 0) };
}

async function fixture(t, databasePath = ':memory:') {
  let app, base, agent, serial = 0;
  const start = async () => {
    app = createApp({ databasePath, mode: 'development', allowDevelopmentAuth: true,
      clock: () => Date.parse('2026-10-27T08:00:00Z'),
      requestRateLimit: { maxRequests: 10000, windowMs: 1000 } });
    const port = await listenOnFetchSafePort(app.server); base = `http://127.0.0.1:${port}`;
    agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  };
  const close = async () => { agent.destroy(); await app.close(); };
  await start(); t.after(close);
  const request = async (route, { token, body, key } = {}) => {
    return await new Promise((resolve, reject) => {
      const outgoing = httpRequest(base + route, { method: body === undefined ? 'GET' : 'POST', agent, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      }, signal: AbortSignal.timeout(5000) }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) outgoing.destroy(new Error('test response limit'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const login = async account => {
    const result = await request('/api/v1/auth/development', { body: { account } });
    assert.equal(result.status, 200); return result.json.data;
  };
  const snapshot = async token => {
    const result = await request('/api/v1/bootstrap', { token });
    assert.equal(result.status, 200); return result.json.data;
  };
  const mutate = (token, route, body, key = `statement-request-${++serial}`) => request('/api/v1' + route, { token, body, key });
  return { request, login, snapshot, mutate, app: () => app, close, restart: async () => { await close(); await start(); } };
}

test('two thousand real bootstrap reads reuse prepared SQL without caching account snapshots', { timeout: 15000 }, async t => {
  const observer = observeNativePrepares(t), h = await fixture(t), auth = await h.login('statement-reader');
  const first = await h.snapshot(auth.token), warmed = observer.total();
  for (let index = 0; index < 2000; index++) {
    const current = await h.snapshot(auth.token);
    assert.equal(current.profile.id, auth.profile.id);
    assert.equal(current.revision, 0); assert.equal(current.wallet.points, 80); assert.equal(current.wallet.feed, 6);
    assert.ok(current.serverTime >= first.serverTime);
  }
  assert.equal(observer.total() - warmed, 0, 'warmed bootstrap SQL must not create one native statement per request');
  assert.equal(observer.connections.size, 1);
});

test('two thousand real mutations rebind account, SKU, key and revision while native statement creation stays bounded', { timeout: 20000 }, async t => {
  const observer = observeNativePrepares(t), h = await fixture(t);
  const accounts = [await h.login('statement-buyer-a'), await h.login('statement-buyer-b')];
  assert.notEqual(accounts[0].profile.id, accounts[1].profile.id);
  await h.mutate(accounts[0].token, '/cart/items', { sku: 'feed-pack', delta: 2, expectedRevision: 0 });
  const first = await h.mutate(accounts[0].token, '/checkout', { couponId: 'welcome-20', expectedRevision: 1 });
  assert.equal(first.status, 200);
  await h.mutate(accounts[1].token, '/cart/items', { sku: 'fertilizer', delta: 1, expectedRevision: 0 });
  const second = await h.mutate(accounts[1].token, '/checkout', { expectedRevision: 1 });
  assert.equal(second.status, 200);
  const revisions = [2, 2], points = [40, 60], feed = [12, 6], fertilizer = [2, 3], warmed = observer.total();
  for (let index = 0; index < 1000; index++) {
    const selected = index % 2, token = accounts[selected].token, sku = index % 3 ? 'feed-pack' : 'fertilizer';
    const added = await h.mutate(token, '/cart/items', { sku, delta: 1, expectedRevision: revisions[selected] });
    assert.equal(added.status, 200); revisions[selected]++;
    assert.deepEqual(added.json.data.system.cart, { [sku]: 1 });
    const removed = await h.mutate(token, '/cart/items', { sku, delta: -1, expectedRevision: revisions[selected] });
    assert.equal(removed.status, 200); revisions[selected]++;
    assert.equal(removed.json.data.profile.id, accounts[selected].profile.id);
    assert.equal(removed.json.data.wallet.points, points[selected]); assert.equal(removed.json.data.wallet.feed, feed[selected]);
    assert.equal(removed.json.data.system.inventory.fertilizer, fertilizer[selected]);
    assert.deepEqual(removed.json.data.system.cart, {});
  }
  for (let selected = 0; selected < 2; selected++) {
    const current = await h.snapshot(accounts[selected].token);
    assert.equal(current.revision, 1002); assert.equal(current.wallet.points, points[selected]);
    assert.equal(current.system.purchases.length, 1); assert.equal(current.system.receipts.length, 1);
  }
  assert.equal(observer.total() - warmed, 0, 'parameters and new idempotency keys must not become statement cache keys');
});

test('a real failed prepare is retried after SQLite schema recovery and does not poison the cached query', async t => {
  const observer = observeNativePrepares(t), h = await fixture(t);
  const [connection, record] = [...observer.connections][0];
  connection.exec('DROP TABLE server_clock');
  assert.equal((await h.request('/readyz')).status, 503);
  connection.exec('CREATE TABLE server_clock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_time INTEGER NOT NULL); INSERT INTO server_clock VALUES (1, 0)');
  assert.equal((await h.request('/readyz')).status, 200);
  assert.equal((await h.request('/readyz')).status, 200);
  assert.equal(record.sql.get('SELECT last_time FROM server_clock WHERE singleton = 1'), 2, 'only the failed prepare and successful retry may reach SQLite');
});

test('a cached statement survives a real transaction failure without stale bindings, partial debit or a false replay', async t => {
  const observer = observeNativePrepares(t), h = await fixture(t), auth = await h.login('statement-rollback');
  const connection = [...observer.connections.keys()][0];
  await h.mutate(auth.token, '/cart/items', { sku: 'feed-pack', delta: 2, expectedRevision: 0 });
  connection.exec("CREATE TRIGGER statement_fail_once BEFORE UPDATE OF state_json ON users BEGIN SELECT RAISE(ABORT, 'isolated transaction failure'); END");
  const body = { couponId: 'welcome-20', expectedRevision: 1 }, key = 'statement-recover-checkout';
  assert.equal((await h.mutate(auth.token, '/checkout', body, key)).status, 500);
  let current = await h.snapshot(auth.token);
  assert.equal(current.wallet.points, 80); assert.equal(current.wallet.feed, 6); assert.equal(current.revision, 1);
  assert.deepEqual(current.system.cart, { 'feed-pack': 2 }); assert.equal(current.system.purchases.length, 0);
  connection.exec('DROP TRIGGER statement_fail_once');
  const recovered = await h.mutate(auth.token, '/checkout', body, key);
  assert.equal(recovered.status, 200); assert.equal(recovered.json.replayed, false);
  assert.equal(recovered.json.data.wallet.points, 40); assert.equal(recovered.json.data.wallet.feed, 12);
  const replay = await h.mutate(auth.token, '/checkout', body, key);
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  assert.deepEqual(replay.json.data, recovered.json.data);
  const signIn = await h.mutate(auth.token, '/activities/sign-in', { expectedRevision: 2 });
  assert.equal(signIn.status, 200); assert.equal(signIn.json.data.wallet.points, 60);
  current = await h.snapshot(auth.token);
  assert.equal(current.system.purchases.length, 1); assert.equal(current.revision, 3);
});

test('separate stores and a closed/reopened SQLite connection never share statements or previous parameter values', async t => {
  const observer = observeNativePrepares(t), root = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(root, 'farm-statements-')), file = path.join(directory, 'isolated.sqlite');
  let persisted, other;
  t.after(async () => {
    await persisted?.close(); await other?.close();
    assert.equal(path.isAbsolute(directory), true); assert.equal(path.dirname(directory), root);
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: false });
  });
  persisted = await fixture(t, file); other = await fixture(t);
  const a = await persisted.login('same-fixed-account'), b = await other.login('same-fixed-account');
  assert.notEqual(a.profile.id, b.profile.id);
  await persisted.mutate(a.token, '/cart/items', { sku: 'feed-pack', delta: 1, expectedRevision: 0 });
  assert.equal((await persisted.mutate(a.token, '/checkout', { expectedRevision: 1 }, 'statement-original-key')).status, 200);
  assert.equal((await other.snapshot(b.token)).wallet.points, 80);
  const firstConnectionCount = observer.connections.size;
  await persisted.restart();
  assert.equal(observer.connections.size, firstConnectionCount + 1);
  const reopened = await persisted.login('same-fixed-account');
  assert.equal(reopened.profile.id, a.profile.id);
  const current = await persisted.snapshot(reopened.token);
  assert.equal(current.wallet.points, 50); assert.equal(current.wallet.feed, 9); assert.equal(current.system.purchases.length, 1);
  const replay = await persisted.mutate(reopened.token, '/checkout', { expectedRevision: 1 }, 'statement-original-key');
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  const warmed = observer.total();
  for (let index = 0; index < 20; index++) {
    assert.equal((await persisted.snapshot(reopened.token)).wallet.points, 50);
    assert.equal((await other.snapshot(b.token)).wallet.points, 80);
  }
  assert.equal(observer.total(), warmed, 'each reopened connection must reuse only its own warmed SQL');
  await persisted.app().close(); await persisted.app().close();
  assert.throws(() => persisted.app().store.serverNow());
});
