import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest, createServer } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { normalizeConfig, configFromEnvironment } from '../src/config.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

const API = '/api/v1';
const cliFile = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-operations-test-'));
  const databasePath = path.join(directory, 'farm.sqlite');
  const settings = { mode: 'development', allowDevelopmentAuth: true, databasePath, ...options };
  let app = createApp(settings), base;
  const listen = async () => { base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}`; };
  await listen();
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(databasePath), directory);
    assert.equal(directory.startsWith(path.join(tmpdir(), 'farm-operations-test-')), true);
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (route, { body, token, key, headers = {} } = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  };
  const login = async () => {
    const result = await request(API + '/auth/development', { body: { account: 'operations-tester' } });
    assert.equal(result.status, 200); return result.json.data;
  };
  return { directory, databasePath, request, login, get app() { return app; }, get base() { return base; },
    async restart() { await app.close(); app = createApp(settings); await listen(); } };
}

function incompleteRequest(base, route, { token, key = 'operations-slow-body', body = '{"expectedRevision":' } = {}) {
  let outgoing;
  const completed = new Promise(resolve => {
    outgoing = httpRequest(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Idempotency-Key': key } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks)) }));
      response.on('aborted', () => resolve({ aborted: true }));
    });
    outgoing.on('error', () => resolve({ aborted: true }));
  });
  outgoing.write(body);
  return { outgoing, completed };
}

test('health remains available after business limiting and liveness never touches SQLite or the business clock', async t => {
  const f = await fixture(t, { requestRateLimit: { maxRequests: 1 } });
  assert.equal((await f.request(API + '/bootstrap')).status, 401);
  assert.equal((await f.request(API + '/bootstrap')).status, 429);
  f.app.store.serverNow = () => { throw new Error('secret-clock-diagnostic'); };
  for (const route of ['/livez', '/readyz', '/healthz']) {
    const result = await f.request(route);
    assert.equal(result.status, 200, route); assert.equal(result.json.data.status, 'ok');
  }
  f.app.store.close();
  assert.equal((await f.request('/livez')).status, 200);
  for (const route of ['/readyz', '/healthz']) {
    const result = await f.request(route);
    assert.equal(result.status, 503); assert.equal(result.json.error.code, 'NOT_READY');
    assert.equal(JSON.stringify(result.json).includes('secret'), false);
  }
});

test('readiness probes the actual database read-only and refuses a missing required clock row', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.databasePath);
  try {
    const before = db.prepare('SELECT last_time FROM server_clock').get().last_time;
    assert.equal((await f.request('/readyz')).status, 200);
    assert.equal(db.prepare('SELECT last_time FROM server_clock').get().last_time, before);
    db.exec('DELETE FROM server_clock');
    assert.equal((await f.request('/readyz')).status, 503);
    assert.equal((await f.request('/livez')).status, 200);
  } finally { db.close(); }
});

test('diagnostics use server request IDs, safe route templates and bounded labels for hostile requests', async t => {
  const logs = [], f = await fixture(t, { logger: event => logs.push(event), requestRateLimit: { maxRequests: 1000 } });
  const marker = 'secret-user-token-code-proof';
  const first = await f.request(API + '/activities/tasks/' + marker + '/claim', { headers: {
    Authorization: `Bearer ${marker}`, 'X-Request-Id': marker,
  } });
  assert.match(first.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  await f.request('/unknown/' + marker + '?token=' + marker);
  await f.request('/healthz', { headers: { Origin: 'https://' + marker + '.example' } });
  for (let i = 0; i < 60; i++) await f.request('/unknown/' + marker + i);
  await pause(5);
  assert.ok(logs.length >= 63, 'the injected logger observes completed real HTTP requests');
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(marker), false);
  for (const event of logs.filter(event => event.event === 'request')) {
    assert.deepEqual(Object.keys(event).sort(), ['durationMs', 'event', 'method', 'outcome', 'requestId', 'route', 'status'].sort());
    assert.ok(event.durationMs >= 0); assert.ok(Number.isFinite(event.durationMs));
  }
  assert.equal(typeof f.app.metrics, 'function');
  const metrics = f.app.metrics();
  assert.equal(metrics.completed, 63); assert.equal(metrics.aborted, 0);
  assert.ok(metrics.requests.length <= 4); assert.equal(JSON.stringify(metrics).includes(marker), false);
  assert.equal((await f.request('/metrics')).status, 404);
  metrics.requests.length = 0;
  assert.ok(f.app.metrics().requests.length > 0, 'a caller cannot mutate internal metric storage');
});

test('throwing and rejected loggers cannot break committed assets or health responses', async t => {
  for (const logger of [() => { throw new Error('secret sink failure'); }, async () => { throw new Error('secret async sink failure'); }]) {
    const f = await fixture(t, { logger });
    const { token } = await f.login();
    assert.equal((await f.request(API + '/activities/sign-in', { token, key: 'logger-signin-key', body: { expectedRevision: 0 } })).status, 200);
    assert.equal((await f.request('/healthz')).status, 200);
    assert.equal((await f.request(API + '/bootstrap', { token })).json.data.signIn.todayClaimed, true);
  }
});

test('expired or revoked deletion capability retains its real HTTP 410 in logs and metrics', async t => {
  const logs = [], f = await fixture(t, { logger: event => logs.push(event) });
  const result = await f.request(API + '/account/deletion/confirm', { body: { confirmationToken: 'X'.repeat(43) } });
  assert.equal(result.status, 410); assert.equal(result.json.error.code, 'DELETION_INVALID');
  await pause(5);
  assert.equal(logs.find(event => event.event === 'request').status, 410);
  assert.equal(f.app.metrics().requests[0].status, 410);
});

test('double close returns one promise and force closes an incomplete body within the configured deadline', async t => {
  const f = await fixture(t, { shutdownTimeoutMs: 120 });
  const { token } = await f.login();
  const observed = once(f.app.server, 'request');
  const slow = incompleteRequest(f.base, API + '/activities/sign-in', { token });
  await observed;
  const started = performance.now(), closing = f.app.close();
  assert.equal(f.app.close(), closing);
  await closing;
  assert.ok(performance.now() - started < 1500, 'slow body must not hold the database open until body timeout');
  assert.equal((await slow.completed).aborted, true);
  assert.equal(f.app.metrics().aborted, 1);
  await f.restart();
  assert.equal((await f.request(API + '/bootstrap', { token })).json.data.revision, 0);
});

test('a logger reentering close during its draining event receives the same shutdown promise', async t => {
  let reentered = false, inside;
  const f = await fixture(t, { logger: event => {
    if (event.phase === 'draining' && !reentered) { reentered = true; inside = f.app.close(); }
  } });
  const outside = f.app.close();
  assert.equal(inside, outside); await outside;
});

test('forced shutdown aborts a pending identity provider without waiting for its longer timeout or touching a closed store', async t => {
  let providerSignal, started;
  const called = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { shutdownTimeoutMs: 100, providerTimeoutMs: 600,
    platformProviders: { weixin: ({ signal }) => { providerSignal = signal; started(); return new Promise(() => {}); } } });
  const pending = f.request(API + '/auth/platform', { body: { platform: 'weixin', code: 'shutdown-private-code' } }).catch(() => null);
  await called;
  const before = performance.now(); await f.app.close();
  assert.ok(performance.now() - before < 400, 'provider timeout must not extend the shutdown deadline');
  assert.equal(providerSignal.aborted, true); await pending;
  const db = new DatabaseSync(f.databasePath);
  try {
    assert.equal(db.prepare('SELECT status FROM code_claims').get().status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM users').get().total, 0);
  } finally { db.close(); }
});

test('forced shutdown remains bounded when an external SQLite writer locks a pending provider finalization', async t => {
  let started;
  const called = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { shutdownTimeoutMs: 100, providerTimeoutMs: 8000,
    platformProviders: { weixin: () => { started(); return new Promise(() => {}); } } });
  const pending = f.request(API + '/auth/platform', { body: { platform: 'weixin', code: 'locked-provider-private-code' } }).catch(() => null);
  await called;
  const lock = new DatabaseSync(f.databasePath);
  lock.exec('BEGIN IMMEDIATE');
  try {
    const before = performance.now(); await f.app.close();
    assert.ok(performance.now() - before < 1000, 'SQLite busy_timeout must not extend forced shutdown by five seconds');
    await pending;
  } finally { lock.exec('ROLLBACK'); lock.close(); }
});

test('an accepted body finishing during drain cannot wait five seconds for an external SQLite write lock', async t => {
  const f = await fixture(t, { shutdownTimeoutMs: 100 });
  const { token } = await f.login(), observed = once(f.app.server, 'request');
  const slow = incompleteRequest(f.base, API + '/activities/sign-in', { token });
  await observed;
  const lock = new DatabaseSync(f.databasePath); lock.exec('BEGIN IMMEDIATE');
  try {
    const before = performance.now(), closing = f.app.close();
    slow.outgoing.end('0}'); await closing;
    assert.ok(performance.now() - before < 1000, 'a draining SQLite write must fail promptly under lock');
    await slow.completed;
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  await f.restart();
  assert.equal((await f.request(API + '/bootstrap', { token })).json.data.revision, 0);
});

test('close cancels a real pending localhost DNS listen before closing SQLite and cannot reopen later', async () => {
  const app = createApp({ databasePath: ':memory:' });
  try {
    app.server.listen(0, 'localhost');
    await app.close(); await pause(100);
    assert.equal(app.server.listening, false, 'a late DNS callback must not open a listener after close resolves');
    assert.equal(app.store.readiness(), false);
  } finally {
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    await app.close();
  }
});

test('draining rejects pipelined new business and readiness but allows its already accepted mutation to complete', async t => {
  const f = await fixture(t, { shutdownTimeoutMs: 1500 });
  const { token } = await f.login();
  const socket = net.connect(new URL(f.base).port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let received = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { received += chunk; });
  const observed = once(f.app.server, 'request');
  const body = '{"expectedRevision":0}';
  socket.write(`POST ${API}/activities/sign-in HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nIdempotency-Key: draining-signin-key\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n` + body.slice(0, -1));
  await observed;
  const closing = f.app.close();
  const socketClosed = once(socket, 'close');
  socket.write(body.slice(-1) + `GET /readyz HTTP/1.1\r\nHost: localhost\r\n\r\nGET ${API}/bootstrap HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  await closing; await socketClosed;
  assert.match(received, /HTTP\/1\.1 200/);
  assert.equal((received.match(/HTTP\/1\.1 503/g) ?? []).length, 2);
  assert.match(received, /SERVICE_DRAINING/); assert.match(received, /NOT_READY/);
  await f.restart();
  assert.equal((await f.request(API + '/bootstrap', { token })).json.data.signIn.todayClaimed, true);
});

test('truncated confirmed checkout response survives shutdown and restarts with exactly one debit and original-key replay', async t => {
  const f = await fixture(t), { token } = await f.login();
  assert.equal((await f.request(API + '/cart/items', { token, key: 'truncated-cart-key', body: { sku: 'feed-pack', delta: 2, expectedRevision: 0 } })).status, 200);
  const body = { couponId: 'welcome-20', expectedRevision: 1 };
  await new Promise((resolve, reject) => {
    const outgoing = httpRequest(f.base + API + '/checkout', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Idempotency-Key': 'truncated-checkout-key', 'Content-Type': 'application/json',
    } }, response => { assert.equal(response.statusCode, 200); response.destroy(); resolve(); });
    outgoing.on('error', reject); outgoing.end(JSON.stringify(body));
  });
  await f.app.close(); await f.restart();
  const replay = await f.request(API + '/checkout', { token, key: 'truncated-checkout-key', body });
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  const snapshot = (await f.request(API + '/bootstrap', { token })).json.data;
  assert.deepEqual([snapshot.revision, snapshot.wallet.points, snapshot.wallet.feed], [2, 40, 12]);
  assert.equal(snapshot.wallet.receipts.length, 1);
});

test('shutdown configuration validates embedded and environment deadlines before creating the service', () => {
  assert.equal(normalizeConfig().shutdownTimeoutMs, 10000);
  for (const shutdownTimeoutMs of [99, 60001, 1.5, '100', NaN]) assert.throws(() => normalizeConfig({ shutdownTimeoutMs }));
  assert.equal(normalizeConfig({ shutdownTimeoutMs: 100 }).shutdownTimeoutMs, 100);
  assert.equal(normalizeConfig({ shutdownTimeoutMs: 60000 }).shutdownTimeoutMs, 60000);
  assert.equal(configFromEnvironment({ FARM_SHUTDOWN_TIMEOUT_MS: '250' }).shutdownTimeoutMs, 250);
  assert.throws(() => createApp({ databasePath: ':memory:', logger: 'invalid' }));
});

test('JSON diagnostic sink bounds queued bytes when its output is blocked and survives sink failure', async () => {
  const operations = await import('../src/operations.mjs').catch(() => ({}));
  assert.equal(typeof operations.createJsonLineLogger, 'function');
  const { Writable } = await import('node:stream');
  const blocked = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {} });
  const logger = operations.createJsonLineLogger(blocked, { maxBufferedBytes: 1024 });
  for (let i = 0; i < 10000; i++) logger({ event: 'lifecycle', phase: 'listening' });
  assert.ok(blocked.writableLength <= 1024); assert.ok(logger.dropped() > 0);
  blocked.destroy(); assert.doesNotThrow(() => logger({ event: 'lifecycle', phase: 'listening' }));
});

async function cliFixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-operations-cli-'));
  const reservation = createServer();
  const port = await listenOnFetchSafePort(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const environment = { ...process.env, NODE_ENV: 'development', FARM_MODE: 'development',
    FARM_ALLOW_DEVELOPMENT_AUTH: 'true', FARM_DATABASE_PATH: path.join(directory, 'farm.sqlite'),
    FARM_HOST: '127.0.0.1', FARM_PORT: String(port), FARM_SHUTDOWN_TIMEOUT_MS: '150', ...extra };
  let child, exited, stdout, stderr;
  const launch = () => {
    child = spawn(process.execPath, [cliFile], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    stdout = ''; stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk; });
    exited = once(child, 'close');
  };
  launch();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    assert.equal(directory.startsWith(path.join(tmpdir(), 'farm-operations-cli-')), true);
    await rm(directory, { recursive: true, force: true });
  });
  return { get child() { return child; }, get exited() { return exited; }, base: `http://127.0.0.1:${port}`,
    get stdout() { return stdout; }, get stderr() { return stderr; }, restart: launch };
}

async function waitForListening(f) {
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    if (f.stdout.split('\n').some(line => { try { return JSON.parse(line).phase === 'listening'; } catch { return false; } })) return;
    if (f.child.exitCode !== null) break;
    await pause(15);
  }
  assert.fail('CLI did not emit its structured listening event');
}

test('actual CLI emits safe JSON diagnostics and fails startup with a nonzero status', async t => {
  const f = await cliFixture(t); await waitForListening(f);
  assert.equal((await fetch(f.base + '/livez')).status, 200);
  await pause(15);
  const events = f.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === 'request' && event.route === '/livez'));
  assert.equal(f.stdout.includes(f.base), false);
  const failed = await cliFixture(t, { FARM_SHUTDOWN_TIMEOUT_MS: 'secret-invalid-timeout' });
  const [code] = await failed.exited;
  assert.equal(code, 1); assert.equal((failed.stdout + failed.stderr).includes('secret-invalid-timeout'), false);
});

test('actual CLI listen failure exits nonzero with safe diagnostics', async t => {
  const occupied = createServer(); const port = await listenOnFetchSafePort(occupied);
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await cliFixture(t, { FARM_PORT: String(port) });
  const [code] = await f.exited; assert.equal(code, 1);
  assert.equal(f.stdout.includes('EADDRINUSE'), false); assert.equal(f.stderr.includes('EADDRINUSE'), false);
});

for (const signalName of ['SIGTERM', 'SIGINT']) test(`actual CLI ${signalName} bounds slow-body shutdown and preserves original-key checkout replay after restart`, {
  skip: process.platform === 'win32' ? 'Windows process.kill does not deliver catchable POSIX SIGTERM/SIGINT; CI runs this contract on Linux' : false,
}, async t => {
  const f = await cliFixture(t); await waitForListening(f);
  const login = await fetch(f.base + API + '/auth/development', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"account":"signal-tester"}' });
  const { token } = (await login.json()).data;
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const cart = await fetch(f.base + API + '/cart/items', { method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': 'signal-cart-key' },
    body: '{"sku":"feed-pack","delta":2,"expectedRevision":0}' });
  assert.equal(cart.status, 200); await cart.text();
  const checkoutBody = '{"couponId":"welcome-20","expectedRevision":1}';
  const checkout = await fetch(f.base + API + '/checkout', { method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': 'signal-checkout-key' }, body: checkoutBody });
  assert.equal(checkout.status, 200); await checkout.body.cancel();
  const pending = incompleteRequest(f.base, API + '/activities/sign-in', { token });
  await pause(30); const started = performance.now();
  f.child.kill(signalName);
  const [code, signal] = await f.exited;
  assert.equal(code, 0); assert.equal(signal, null); assert.ok(performance.now() - started < 1500);
  assert.equal((await pending.completed).aborted, true);
  assert.ok(f.stdout.trim().split('\n').map(line => JSON.parse(line)).some(event => event.phase === 'stopped'));
  assert.equal(f.stdout.includes(token), false);
  f.restart(); await waitForListening(f);
  const replay = await fetch(f.base + API + '/checkout', { method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': 'signal-checkout-key' }, body: checkoutBody });
  const replayed = await replay.json();
  assert.equal(replay.status, 200); assert.equal(replayed.replayed, true);
  const snapshot = await fetch(f.base + API + '/bootstrap', { headers: authHeaders });
  const { data } = await snapshot.json();
  assert.deepEqual([data.revision, data.wallet.points, data.wallet.feed, data.wallet.receipts.length], [2, 40, 12, 1]);
});
