import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarmClient as actualCreateFarmClient } from '../apps/mobile/src/core/client.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const createFarmClient = options => actualCreateFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport, { planting: true }) });
const now = 1793044800000, id = 'a'.repeat(32), recordId = 'record-001';
const ok = data => ({ status: 200, data: { data } });
const scope = { plantingFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
const record = (extra = {}) => ({ ...scope, recordId, recordVersion: 1, enabled: true, notBefore: now, currentOrderId: null, ...extra });
const status = (extra = {}) => ({ ...scope, available: true, hasStaffAccess: false, ...extra });
const page = (extra = {}) => ({ ...scope, items: [], nextCursor: null, ...extra });
const receipt = (extra = {}) => ({ plantingFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'planting-operation-1', action: 'request', outcome: 'applied', code: 'OK', orderId: id, completedAt: now, ...extra });
function harness() {
  const calls = [], replies = []; let serial = 0;
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => `planting-operation-${++serial}`, transport: async request => {
    calls.push(structuredClone(request)); const reply = replies.shift(); assert.ok(reply, 'explicit reply required'); if (reply instanceof Error) throw reply; return await reply;
  } });
  return { client, calls, replies };
}
async function login(h, ownerId = 'member-a') {
  h.replies.push(ok({ environment: 'development', token: 'token-' + ownerId, profile: { id: ownerId } })); await h.client.loginDevelopment('synthetic');
  h.replies.push(ok(mobileSnapshot({ profile: { id: ownerId } }))); await h.client.load();
}
test('planting client exposes account-scoped reads and settles receipts separately from financial state', async () => {
  const h = harness(); assert.equal(typeof h.client.loadPlantingStatus, 'function'); await login(h);
  h.replies.push(ok(status()), ok(record()), ok(page())); await h.client.loadPlantingStatus(); await h.client.loadPlantingRecord(recordId); await h.client.loadPlantingPage();
  const financial = h.client.snapshot; h.replies.push(ok(receipt())); await h.client.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 });
  assert.equal(h.client.snapshot, financial); assert.equal(h.client.plantingRecord, null); assert.equal(h.client.plantingPage, null); assert.equal(h.client.hasPending(), true);
  assert.equal(h.client.pendingStage, 'receipt-review');
  await h.client.acknowledgePlanting();
  assert.equal(h.calls.at(-1).url.endsWith('/account/recovery/execute'), true);
  await assert.rejects(h.client.loadPlantingPage('admin'), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.client.commandPlanting({ action: 'accept', orderId: id, expectedOrderVersion: 1 }), { code: 'INVALID_REQUEST' });
});
test('cold clients read existing active order instead of assuming original operation key recovery', async () => {
  const h = harness(); await login(h); h.replies.push(ok(record({ enabled: false, currentOrderId: id }))); const current = await h.client.loadPlantingRecord(recordId);
  assert.equal(current.currentOrderId, id); assert.equal(h.client.hasPending(), false); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});
