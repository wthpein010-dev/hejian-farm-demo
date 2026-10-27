import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createApp } from '../services/api/src/server.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const record = (ownerId, id = 'plot-00000001') => ({ id, ownerId, kind: 'plot', name: '合成秋蔬', unitLabel: '地块1',
  cycleRef: 'synthetic-cycle', status: 'planned', startedAt: null, expectedHarvestAt: NOW + 100,
  observedAt: NOW - 1000, measurements: { areaM2: 12, moisturePercent: 41 } });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-planting-http-')), file = path.join(directory, 'farm.sqlite');
  let now = NOW, app, base, serial = 0;
  const logs = [];
  async function start() {
    app = createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true, clock: () => now,
      logger: entry => logs.push(entry), requestRateLimit: { maxRequests: 10000, windowMs: 60000 }, ...options });
    base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`;
  }
  await start();
  t.after(async () => { await app.close(); assert.equal(path.dirname(file), directory); await rm(directory, { recursive: true, force: true }); });
  async function request(route, token, body, key = `planting-test-${++serial}`, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const login = async name => {
    const response = await request('/auth/development', '', { account: name });
    assert.equal(response.status, 200); return response.data.data;
  };
  const command = async (auth, input, audience = 'customer', key) => {
    const response = await request(`${audience === 'staff' ? '/staff' : ''}/planting/commands`, auth.token, input, key);
    assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data.data;
  };
  const detail = async (auth, id, audience = 'customer') => {
    const response = await request(`${audience === 'staff' ? '/staff' : ''}/planting/order/${id}`, auth.token);
    assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data.data;
  };
  const put = (ownerId, id = 'plot-00000001', batchId = 'batch-planting-001') => {
    app.store.importFarmBatch({ formatVersion: 1, batchId, source: 'synthetic-field', entries: [{ expectedVersion: 0, record: record(ownerId, id) }] }, app.store.serverNow());
  };
  const provision = (owner, dispatcher, worker, overrides = {}) => {
    assert.equal(typeof app.store.provisionPlanting, 'function', 'Store must expose the trusted narrow provisioning seam');
    return app.store.provisionPlanting({ recordId: 'plot-00000001', expectedPlanVersion: 0, recordVersion: 1,
      enabled: true, notBefore: NOW + 1000, staff: [{ accountId: dispatcher.profile.id, role: 'dispatch' },
        { accountId: worker.profile.id, role: 'execute' }], ...overrides }, app.store.serverNow());
  };
  async function actors() {
    const a = await login('plant-owner'), b = await login('plant-neighbor'), dispatch = await login('plant-dispatch'), worker = await login('plant-worker');
    put(a.profile.id); provision(a, dispatch, worker); return { a, b, dispatch, worker };
  }
  return { request, login, command, detail, put, provision, actors, logs, get app() { return app; }, get base() { return base; },
    get now() { return now; }, advance(ms = 1001) { now += ms; }, restart: async () => { await app.close(); await start(); } };
}

async function assign(f, a, dispatch, worker) {
  const receipt = await f.command(a, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 });
  const id = receipt.orderId;
  assert.equal(receipt.outcome, 'applied');
  assert.equal((await f.command(dispatch, { action: 'accept', orderId: id, expectedOrderVersion: 1 }, 'staff')).outcome, 'applied');
  const view = await f.detail(dispatch, id, 'staff'); assert.equal(view.candidates.length, 1);
  const ref = view.candidates[0].ref;
  assert.equal((await f.command(dispatch, { action: 'assign', orderId: id, expectedOrderVersion: 2, assigneeRef: ref }, 'staff')).outcome, 'applied');
  return id;
}

test('real HTTP planting requires sessions, exact body and current record ownership; no public grant API', async t => {
  const f = await fixture(t), { a, b, dispatch } = await f.actors();
  assert.equal((await f.request('/planting/status')).status, 401);
  assert.equal((await f.request('/planting/status', a.token)).data.data.available, true);
  assert.equal((await f.request('/planting/status', dispatch.token)).data.data.hasStaffAccess, true);
  assert.equal((await f.request('/planting/status', a.token)).data.data.hasStaffAccess, false);
  const mine = await f.request('/planting/record/plot-00000001', a.token); assert.equal(mine.data.data.enabled, true);
  const other = await f.request('/planting/record/plot-00000001', b.token), missing = await f.request('/planting/record/plot-99999999', b.token);
  assert.equal(other.status, 404); assert.deepEqual(other.data.error, missing.data.error);
  assert.equal((await f.command(b, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 })).outcome, 'refused');
  assert.equal((await f.request('/planting/commands', a.token, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1, ownerId: b.profile.id })).status, 400);
  assert.equal((await f.request('/planting/commands', a.token, { action: 'accept', orderId: 'a'.repeat(32), expectedOrderVersion: 1 })).status, 400);
  assert.equal((await f.request('/planting/grants', a.token, { role: 'dispatch' })).status, 404);
  assert.equal((await f.request('/planting/orders/BAD', a.token)).status, 400);
  assert.equal((await f.request('/planting/status?ownerId=other', a.token)).status, 400);
});

test('two-client requests and dispatch races apply once, old keys restore original results after cancellation and restart', async t => {
  const f = await fixture(t), { a, dispatch } = await f.actors();
  const input = { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 };
  const results = await Promise.all([f.command(a, input, 'customer', 'planting-original-001'), f.command(a, input)]);
  assert.equal(results.filter(r => r.outcome === 'applied').length, 1);
  const original = results[0], id = results.find(r => r.outcome === 'applied').orderId;
  const decisions = await Promise.all([f.command(dispatch, { action: 'accept', orderId: id, expectedOrderVersion: 1 }, 'staff'),
    f.command(dispatch, { action: 'accept', orderId: id, expectedOrderVersion: 1 }, 'staff')]);
  assert.equal(decisions.filter(r => r.outcome === 'applied').length, 1);
  await f.command(a, { action: 'cancel', orderId: id, expectedOrderVersion: 2 });
  await f.restart();
  assert.deepEqual(await f.command(a, input, 'customer', 'planting-original-001'), original);
  assert.equal((await f.detail(a, id)).order.status, 'cancelled');
  assert.equal((await f.request('/planting/record/plot-00000001', a.token)).data.data.currentOrderId, null);
  const fresh = await f.command(a, input); assert.equal(fresh.outcome, 'applied'); assert.notEqual(fresh.orderId, id);
  assert.equal((await f.request('/planting/record/plot-00000001', a.token)).data.data.currentOrderId, fresh.orderId);
});

test('authorized completion atomically changes one record history, strips stale observations and leaves financial state unchanged', async t => {
  const f = await fixture(t), { a, b, dispatch, worker } = await f.actors();
  const before = (await f.request('/bootstrap', a.token)).data.data, id = await assign(f, a, dispatch, worker);
  assert.equal((await f.command(worker, { action: 'start', orderId: id, expectedOrderVersion: 3 }, 'staff')).code, 'TOO_EARLY');
  f.advance();
  assert.equal((await f.command(worker, { action: 'start', orderId: id, expectedOrderVersion: 3 }, 'staff')).outcome, 'applied');
  assert.equal((await f.command(b, { action: 'complete', orderId: id, expectedOrderVersion: 4, expectedRecordVersion: 1, performedAt: f.now }, 'staff')).outcome, 'refused');
  const complete = { action: 'complete', orderId: id, expectedOrderVersion: 4, expectedRecordVersion: 1, performedAt: f.now };
  const results = await Promise.all([f.command(worker, complete, 'staff', 'planting-complete-001'), f.command(worker, complete, 'staff')]);
  assert.equal(results.filter(r => r.outcome === 'applied').length, 1);
  assert.deepEqual(await f.command(worker, complete, 'staff', 'planting-complete-001'), results[0]);
  const data = (await f.request('/farm/record/plot-00000001/0', a.token)).data.data;
  assert.equal(data.record.status, 'growing'); assert.equal(data.record.startedAt, f.now); assert.equal(data.record.observedAt, f.now);
  assert.equal(data.record.expectedHarvestAt, null); assert.deepEqual(data.record.measurements, {});
  assert.equal(data.record.version, 2); assert.equal(data.events.length, 2);
  assert.equal(data.events[1].record.measurements.moisturePercent, 41);
  const after = (await f.request('/bootstrap', a.token)).data.data;
  for (const k of ['revision', 'wallet', 'system', 'capabilities']) assert.deepEqual(after[k], before[k], k);
  assert.equal((await f.command(a, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 2 })).outcome, 'refused');
});

test('active record imports refuse fresh edits but keep original batch replay semantics', async t => {
  const f = await fixture(t), { a } = await f.actors();
  await f.command(a, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 });
  const original = { formatVersion: 1, batchId: 'batch-planting-001', source: 'synthetic-field', entries: [{ expectedVersion: 0, record: record(a.profile.id) }] };
  assert.equal(f.app.store.importFarmBatch(original, f.app.store.serverNow()).replayed, true);
  assert.throws(() => f.app.store.importFarmBatch({ ...original, batchId: 'batch-planting-edit', entries: [{ expectedVersion: 1,
    record: { ...record(a.profile.id), observedAt: f.now, measurements: { moisturePercent: 99 } } }] }, f.app.store.serverNow()));
  assert.equal((await f.request('/farm/record/plot-00000001/0', a.token)).data.data.record.version, 1);
});

test('revoked staff cannot use stale pages; original receipts remain readable; dispatch can explicitly record manual stop', async t => {
  const f = await fixture(t), { a, dispatch, worker } = await f.actors(), id = await assign(f, a, dispatch, worker);
  f.advance(); const start = { action: 'start', orderId: id, expectedOrderVersion: 3 };
  const original = await f.command(worker, start, 'staff', 'planting-staff-start'); assert.equal(original.outcome, 'applied');
  f.provision(a, dispatch, worker, { expectedPlanVersion: 1, staff: [{ accountId: dispatch.profile.id, role: 'dispatch' }] });
  assert.equal((await f.request(`/staff/planting/order/${id}`, worker.token)).status, 404);
  assert.equal((await f.command(worker, { action: 'complete', orderId: id, expectedOrderVersion: 4, expectedRecordVersion: 1, performedAt: f.now }, 'staff')).outcome, 'refused');
  assert.deepEqual(await f.command(worker, start, 'staff', 'planting-staff-start'), original);
  assert.equal((await f.command(dispatch, { action: 'cancel-work', orderId: id, expectedOrderVersion: 4, stoppedAt: f.now,
    reason: 'farm-confirmed-stop' }, 'staff')).outcome, 'applied');
  assert.equal((await f.detail(a, id)).order.status, 'cancelled');
  assert.equal((await f.request('/planting/record/plot-00000001', a.token)).data.data.enabled, false);
  assert.equal((await f.command(a, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 })).outcome, 'refused');
});

test('workflow changes invalidate prepared deletion and active customer or assignee cannot be silently deleted', async t => {
  const f = await fixture(t), { a, dispatch, worker } = await f.actors();
  const prep = async auth => f.request('/account/deletion/prepare', auth.token, { expectedRevision: 0 });
  const old = (await prep(a)).data.data.confirmationToken, staffOld = (await prep(worker)).data.data.confirmationToken;
  const id = await assign(f, a, dispatch, worker);
  for (const confirmationToken of [old, staffOld]) assert.equal((await f.request('/account/deletion/confirm', '', { confirmationToken })).status, 410);
  for (const auth of [a, worker]) {
    const response = await prep(auth); assert.equal(response.status, 409); assert.equal(response.data.error.code, 'ACTIVE_PLANTING_WORK');
  }
  await f.command(a, { action: 'cancel', orderId: id, expectedOrderVersion: 3 });
  const token = (await prep(worker)).data.data.confirmationToken;
  assert.equal((await f.request('/account/deletion/confirm', '', { confirmationToken: token })).status, 200);
  assert.equal((await f.detail(a, id)).order.status, 'cancelled');
});

test('slow command bodies revalidate session before writing and logs never include account, order or record values', async t => {
  const f = await fixture(t, { sessionTtlMs: 1000 }), { a } = await f.actors();
  const route = '/planting/commands', body = JSON.stringify({ action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 });
  let observedResolve; const observed = new Promise(resolve => { observedResolve = resolve; });
  f.app.server.once('request', observedResolve);
  let outgoing;
  const response = new Promise((resolve, reject) => {
    outgoing = httpRequest(f.base + route, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'planting-slow-command' } }, reply => {
      const chunks = []; reply.on('data', c => chunks.push(c)); reply.on('end', () => resolve({ status: reply.statusCode, json: JSON.parse(Buffer.concat(chunks)) }));
    }); outgoing.on('error', reject);
  });
  outgoing.write(body.slice(0, -1)); await observed; f.advance(1001); outgoing.end('}');
  assert.equal((await response).status, 401);
  const auth = await f.login('plant-owner'); assert.equal((await f.request('/planting/orders/start', auth.token)).data.data.items.length, 0);
  await f.request('/planting/record/plot-00000001', auth.token);
  const text = JSON.stringify(f.logs);
  assert.equal(text.includes(auth.token), false); assert.equal(text.includes(auth.profile.id), false); assert.equal(text.includes('plot-00000001'), false);
  assert.ok(f.logs.some(entry => entry.route === '/api/v1/planting/record/:recordId'));
});

test('production platform identities expose no planting capability and cannot gain development grants', async t => {
  const f = await fixture(t, { mode: 'production', allowDevelopmentAuth: false });
  const auth = f.app.store.createIdentity('weixin', 'synthetic-production-user', f.app.store.serverNow());
  const status = await f.request('/planting/status', auth.token); assert.equal(status.status, 200);
  assert.equal(status.data.data.available, false); assert.equal(status.data.data.hasStaffAccess, false);
  assert.equal((await f.request('/planting/orders/start', auth.token)).status, 503);
  assert.equal((await f.request('/planting/record/plot-00000001', auth.token)).status, 503);
  const refusal = await f.command(auth, { action: 'request', recordId: 'plot-00000001', expectedRecordVersion: 1 });
  assert.equal(refusal.code, 'PLANTING_UNAVAILABLE');
});
