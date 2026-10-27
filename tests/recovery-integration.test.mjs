import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../services/api/src/server.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';
const NOW = Date.parse('2026-10-27T04:00:00Z');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-recovery-http-')), file = path.join(directory, 'farm.sqlite');
  let now = NOW, app, base, key = 0; const logs = [];
  async function start() { app = createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true, clock: () => now,
    requestRateLimit: { maxRequests: 10000, windowMs: 60000 }, logger: item => logs.push(item), ...options });
    base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`; }
  await start();
  t.after(async () => { await app.close(); assert.equal(path.dirname(file), directory); await rm(directory, { recursive: true, force: true }); });
  async function request(route, auth, body, operationKey = `recovery-http-${++key}`, method = body === undefined ? 'GET' : 'POST') {
    const reply = await fetch(base + route, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': operationKey }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: reply.status, json: await reply.json(), headers: reply.headers };
  }
  async function ok(route, auth, body, operationKey) { const r = await request(route, auth, body, operationKey); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; }
  const login = account => ok('/auth/development', null, { account });
  const current = auth => ok('/account/recovery', auth);
  const detail = (auth, id) => ok('/account/recovery/intent/' + id, auth);
  async function prepare(auth, command, audience = 'customer', view) {
    view ??= await current(auth); return ok('/account/recovery/prepare', auth, { expectedEpoch: view.epoch, expectedVersion: view.version, audience, command });
  }
  const act = (operation, auth, id) => ok('/account/recovery/' + operation, auth, { intentId: id });
  function database(work) { const db = new DatabaseSync(file); try { return work(db); } finally { db.close(); } }
  async function seed() {
    const a = await login('recovery-customer'), b = await login('recovery-neighbor'), dispatch = await login('recovery-dispatch'), worker = await login('recovery-worker');
    app.store.importFarmBatch({ formatVersion: 1, batchId: 'batch-recovery-001', source: 'synthetic-field', entries: [{ expectedVersion: 0,
      record: { id: 'plot-recovery-01', ownerId: a.profile.id, kind: 'plot', name: '合成番茄', unitLabel: '地块1', cycleRef: 'synthetic-cycle',
        status: 'planned', startedAt: null, expectedHarvestAt: null, observedAt: NOW - 100, measurements: {} } }] }, app.store.serverNow());
    app.store.provisionPlanting({ recordId: 'plot-recovery-01', recordVersion: 1, expectedPlanVersion: 0, enabled: true, notBefore: NOW,
      staff: [{ accountId: dispatch.profile.id, role: 'dispatch' }, { accountId: worker.profile.id, role: 'execute' }] }, app.store.serverNow());
    return { a, b, dispatch, worker };
  }
  return { request, ok, login, current, detail, prepare, act, database, seed, logs, get app() { return app; }, get base() { return base; },
    get now() { return now; }, advance(ms) { now += ms; }, restart: async () => { await app.close(); await start(); } };
}
const plantingRequest = () => ({ action: 'request', recordId: 'plot-recovery-01', expectedRecordVersion: 1 });

test('recovery discovery is authenticated/read-only; prepare persists original intent without executing work', async t => {
  const f = await fixture(t), { a, b } = await f.seed(); assert.equal(a.environment, 'development');
  assert.equal((await f.request('/account/recovery')).status, 401);
  const before = await f.ok('/bootstrap', a), view = await f.current(a);
  assert.equal(view.intent, null); assert.equal(view.version, 0); assert.equal(view.available, true);
  const r = await f.prepare(a, plantingRequest(), 'customer', view); assert.equal(r.code, 'OK'); assert.equal(r.intent.phase, 'prepared');
  assert.deepEqual(r.intent.command, plantingRequest()); assert.equal(r.intent.operationKey, 'intent-' + r.intent.id);
  assert.equal((await f.ok('/planting/orders/start', a)).items.length, 0);
  assert.deepEqual(await f.ok('/bootstrap', a), before);
  assert.equal((await f.current(a)).intent.id, r.intent.id);
  const denied = await f.request('/account/recovery/intent/' + r.intent.id, b), absent = await f.request('/account/recovery/intent/' + 'a'.repeat(32), b);
  assert.equal(denied.status, 404); assert.deepEqual(denied.json.error, absent.json.error);
  assert.match((await f.request('/account/recovery', a)).headers.get('cache-control'), /no-store/);
  assert.equal((await f.request('/account/recovery/prepare', a, { expectedEpoch: view.epoch, expectedVersion: 0, audience: 'customer', command: { ...plantingRequest(), ownerId: b.profile.id } })).status, 400);
});

test('lost prepare and execute replies survive service restart, preserving one original key and exact old receipt', async t => {
  const f = await fixture(t), { a, dispatch } = await f.seed(), v = await f.current(a);
  const prepared = await f.prepare(a, plantingRequest(), 'customer', v); // deliberately discard its response before restart
  await f.restart();
  const recovered = await f.current(a); assert.equal(recovered.intent.id, prepared.intent.id);
  assert.equal((await f.prepare(a, plantingRequest(), 'customer', v)).intent.id, prepared.intent.id);
  const applied = await f.act('execute', a, prepared.intent.id); assert.equal(applied.intent.receipt.outcome, 'applied');
  const original = structuredClone(applied.intent.receipt), orderId = original.orderId;
  await f.ok('/staff/planting/commands', dispatch, { action: 'accept', orderId, expectedOrderVersion: 1 });
  await f.restart();
  assert.deepEqual((await f.detail(a, prepared.intent.id)).intent.receipt, original);
  assert.deepEqual((await f.act('execute', a, prepared.intent.id)).intent.receipt, original);
  assert.equal((await f.ok('/planting/orders/start', a)).items.length, 1);
  assert.equal((await f.ok('/planting/order/' + orderId, a)).order.status, 'accepted');
});

test('old ack and delayed prepare cannot close or recreate a later account slot', async t => {
  const f = await fixture(t), { a } = await f.seed(), firstView = await f.current(a);
  const first = (await f.prepare(a, plantingRequest(), 'customer', firstView)).intent;
  await f.act('execute', a, first.id); await f.act('ack', a, first.id); // lose ack reply, then a different session starts another operation
  const next = (await f.prepare(a, { action: 'cancel', orderId: (await f.detail(a, first.id)).intent.receipt.orderId, expectedOrderVersion: 1 })).intent;
  const ack = await f.act('ack', a, first.id); assert.equal(ack.intent.id, first.id); assert.notEqual(ack.intent.closedAt, null);
  assert.equal(ack.currentIntentId, next.id); assert.equal((await f.current(a)).intent.id, next.id);
  const delayed = await f.prepare(a, plantingRequest(), 'customer', firstView);
  assert.equal(delayed.intent.id, first.id); assert.equal(delayed.currentIntentId, next.id);
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM planting_intents').get().n), 2);
});

test('two sessions CAS one prepare; execute versus abandon has one terminal truth', async t => {
  const f = await fixture(t), { a } = await f.seed(), view = await f.current(a);
  const [one, two] = await Promise.all([f.prepare(a, plantingRequest(), 'customer', view),
    f.prepare(a, { ...plantingRequest(), recordId: 'plot-doesnotexist' }, 'customer', view)]);
  assert.equal([one, two].filter(v => v.code === 'OK').length, 1);
  const intent = [one, two].find(v => v.code === 'OK').intent;
  const results = await Promise.all([f.act('execute', a, intent.id), f.act('abandon', a, intent.id)]);
  const final = (await f.detail(a, intent.id)).intent;
  assert.ok(['settled', 'abandoned'].includes(final.phase)); assert.ok(results.every(v => v.intent.phase === final.phase));
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM planting_commands WHERE key = ?').get(intent.operationKey).n), final.phase === 'settled' ? 1 : 0);
});

test('raw commands cannot poison reserved intent keys and original legacy receipts still replay before recovery guards', async t => {
  const f = await fixture(t), { a } = await f.seed();
  const raw = await f.ok('/planting/commands', a, plantingRequest(), 'legacy-recovery-001');
  await f.ok('/planting/commands', a, { action: 'cancel', orderId: raw.orderId, expectedOrderVersion: 1 });
  const prepared = (await f.prepare(a, plantingRequest())).intent;
  for (const cmd of [plantingRequest(), { action: 'cancel', orderId: raw.orderId, expectedOrderVersion: 2 }]) {
    const refusal = await f.request('/planting/commands', a, cmd, prepared.operationKey);
    assert.equal(refusal.status, 409); assert.equal(refusal.json.error.code, 'RESERVED_OPERATION_KEY');
  }
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM planting_commands WHERE key = ?').get(prepared.operationKey).n), 0);
  assert.deepEqual(await f.ok('/planting/commands', a, plantingRequest(), 'legacy-recovery-001'), raw);
  const blocked = await f.ok('/planting/commands', a, plantingRequest(), 'legacy-blocked-001'); assert.equal(blocked.code, 'INTENT_PENDING');
  const applied = await f.act('execute', a, prepared.id); assert.equal(applied.intent.receipt.outcome, 'applied');
  await f.act('ack', a, prepared.id);
  assert.deepEqual(await f.ok('/planting/commands', a, plantingRequest(), 'legacy-blocked-001'), blocked);
});

test('prepared operations invalidate deletion preparation and block deletion until safely abandoned', async t => {
  const f = await fixture(t), { a } = await f.seed();
  const old = await f.ok('/account/deletion/prepare', a, { expectedRevision: 0 });
  const intent = (await f.prepare(a, plantingRequest())).intent;
  assert.equal((await f.request('/account/deletion/confirm', null, { confirmationToken: old.confirmationToken })).status, 410);
  const blocked = await f.request('/account/deletion/prepare', a, { expectedRevision: 0 }); assert.equal(blocked.status, 409); assert.equal(blocked.json.error.code, 'RECOVERY_PENDING');
  await f.act('abandon', a, intent.id);
  const fresh = await f.ok('/account/deletion/prepare', a, { expectedRevision: 0 });
  assert.equal((await f.ok('/account/deletion/confirm', null, { confirmationToken: fresh.confirmationToken })).deleted, true);
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM planting_intents').get().n), 0);
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM recovery_slots').get().n), 0);
});

test('slow recovery bodies revalidate the existing session before preparing; request logs retain templates only', async t => {
  const f = await fixture(t, { sessionTtlMs: 1000 }), { a } = await f.seed(), v = await f.current(a);
  const body = JSON.stringify({ expectedEpoch: v.epoch, expectedVersion: v.version, audience: 'customer', command: plantingRequest() });
  let observedResolve; const observed = new Promise(resolve => { observedResolve = resolve; }); f.app.server.once('request', observedResolve);
  let outgoing; const response = new Promise((resolve, reject) => {
    outgoing = httpRequest(f.base + '/account/recovery/prepare', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json' } }, reply => {
      const chunks = []; reply.on('data', c => chunks.push(c)); reply.on('end', () => resolve(reply.statusCode)); }); outgoing.on('error', reject);
  }); outgoing.write(body.slice(0, -1)); await observed; f.advance(1001); outgoing.end('}'); assert.equal(await response, 401);
  const auth = await f.login('recovery-customer'); const intent = (await f.prepare(auth, plantingRequest())).intent;
  await f.detail(auth, intent.id);
  const text = JSON.stringify(f.logs); for (const secret of [a.token, auth.token, auth.profile.id, intent.id, intent.operationKey, 'plot-recovery-01']) assert.equal(text.includes(secret), false);
  assert.ok(f.logs.some(v => v.route === '/api/v1/account/recovery/intent/:intentId'));
});

test('production identity receives explicit closed availability and cannot create recovery intentions', async t => {
  const f = await fixture(t, { mode: 'production', allowDevelopmentAuth: false });
  const auth = f.app.store.createIdentity('weixin', 'synthetic-production-recovery', f.app.store.serverNow()); assert.equal(auth.environment, 'production');
  const v = await f.current(auth); assert.equal(v.available, false); assert.equal(v.intent, null);
  const result = await f.prepare(auth, plantingRequest(), 'customer', v); assert.equal(result.code, 'RECOVERY_UNAVAILABLE');
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM planting_intents').get().n), 0);
});
