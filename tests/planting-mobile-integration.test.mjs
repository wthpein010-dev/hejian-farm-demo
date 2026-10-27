import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../services/api/src/server.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
const NOW = Date.parse('2026-10-27T04:00:00Z'), recordId = 'plot-mobile-001';
async function fixture(t, extra = {}) {
  let now = NOW, serial = 0, drop = false;
  const directory = await mkdtemp(path.join(tmpdir(), 'planting-mobile-')), calls = [];
  const app = createApp({ databasePath: path.join(directory, 'synthetic.sqlite'), mode: 'development', allowDevelopmentAuth: true, clock: () => now, requestRateLimit: { maxRequests: 10000, windowMs: 60000 }, ...extra });
  const baseURL = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const create = () => createFarmClient({ baseURL, generateKey: () => `planting-mobile-${++serial}`, transport: async request => {
    calls.push(structuredClone(request)); const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    const reply = { status: response.status, data: await response.json() };
    if (drop && request.url.endsWith('/planting/commands')) { drop = false; throw new Error('lost after SQLite commit'); }
    return reply;
  } });
  const connect = async account => { const client = create(); await client.loginDevelopment(account); await client.load(); return client; };
  const owner = await connect('plant-mobile-owner'), dispatcher = await connect('plant-mobile-dispatch'), worker = await connect('plant-mobile-worker');
  app.store.importFarmBatch({ formatVersion: 1, batchId: 'planting-mobile-batch', source: 'synthetic-field', entries: [{ expectedVersion: 0, record: { id: recordId, ownerId: owner.profile.id, kind: 'plot', name: '合成番茄', unitLabel: '地块1', cycleRef: 'synthetic-cycle', status: 'planned', startedAt: null, expectedHarvestAt: now + 100, observedAt: now - 1000, measurements: { areaM2: 12, moisturePercent: 41 } } }] }, now);
  const provision = (overrides = {}) => app.store.provisionPlanting({ recordId, expectedPlanVersion: 0, recordVersion: 1, enabled: true, notBefore: NOW, staff: [{ accountId: dispatcher.profile.id, role: 'dispatch' }, { accountId: worker.profile.id, role: 'execute' }], ...overrides }, now);
  provision();
  return { app, owner, dispatcher, worker, calls, connect, provision, drop() { drop = true; }, advance(ms = 2000) { now += ms; }, get now() { return now; } };
}
test('actual SQLite/HTTP client reconciles original request after dispatch progressed, then completes exactly one farm history', async t => {
  const h = await fixture(t), before = h.owner.snapshot;
  await h.owner.loadPlantingRecord(recordId); h.drop(); await assert.rejects(h.owner.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 }), { code: 'RESULT_UNKNOWN' });
  const original = h.calls.at(-1), orders = await h.dispatcher.loadPlantingPage('staff'), id = orders.items[0].id;
  await h.dispatcher.commandPlanting({ action: 'accept', orderId: id, expectedOrderVersion: 1 }, 'staff'); const accepted = await h.dispatcher.loadPlantingDetail(id, 'staff');
  const ref = accepted.candidates[0].ref; await h.dispatcher.commandPlanting({ action: 'assign', orderId: id, expectedOrderVersion: 2, assigneeRef: ref }, 'staff');
  assert.equal((await h.owner.retryPending()).action, 'request'); assert.deepEqual(h.calls.at(-1), original); assert.equal(h.owner.plantingDetail, null);
  assert.equal((await h.owner.loadPlantingDetail(id)).order.status, 'assigned');
  await h.worker.loadPlantingDetail(id, 'staff'); await h.worker.commandPlanting({ action: 'start', orderId: id, expectedOrderVersion: 3 }, 'staff'); h.advance();
  await h.worker.loadPlantingDetail(id, 'staff'); h.drop(); await assert.rejects(h.worker.commandPlanting({ action: 'complete', orderId: id, expectedOrderVersion: 4, expectedRecordVersion: 1, performedAt: h.now }, 'staff'), { code: 'RESULT_UNKNOWN' });
  const completion = h.calls.at(-1); await h.worker.retryPending(); assert.deepEqual(h.calls.at(-1), completion);
  const farm = await h.owner.loadFarmDetail(recordId); assert.equal(farm.record.version, 2); assert.equal(farm.record.status, 'growing'); assert.equal(farm.events.length, 2); assert.equal(farm.record.measurements.moisturePercent, undefined); assert.equal(farm.record.expectedHarvestAt, null);
  assert.equal(h.owner.snapshot, before); assert.equal((await h.owner.loadPlantingDetail(id)).order.status, 'completed');
});
test('cold client sees current active order and new key cannot double request; revoked worker cannot act from old detail', async t => {
  const h = await fixture(t), request = await h.owner.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 });
  const cold = await h.connect('plant-mobile-owner'); assert.equal(cold.hasPending(), false); assert.equal((await cold.loadPlantingRecord(recordId)).currentOrderId, request.orderId);
  assert.equal((await cold.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 })).code, 'ACTIVE_ORDER_EXISTS');
  await h.dispatcher.commandPlanting({ action: 'accept', orderId: request.orderId, expectedOrderVersion: 1 }, 'staff'); const detail = await h.dispatcher.loadPlantingDetail(request.orderId, 'staff');
  h.provision({ expectedPlanVersion: 1, staff: [] });
  const refusal = await h.dispatcher.commandPlanting({ action: 'assign', orderId: request.orderId, expectedOrderVersion: 2, assigneeRef: detail.candidates[0].ref }, 'staff'); assert.equal(refusal.outcome, 'refused'); assert.equal(h.dispatcher.plantingDetail, null); assert.equal((await h.dispatcher.loadPlantingStatus()).hasStaffAccess, false);
  await assert.rejects(h.dispatcher.loadPlantingDetail(request.orderId, 'staff'), { status: 404 }); assert.equal(h.dispatcher.plantingDetail, null);
});
