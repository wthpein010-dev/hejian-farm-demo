import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

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
  h.replies.push(ok({ token: 'token-' + ownerId, profile: { id: ownerId } })); await h.client.loginDevelopment('synthetic');
  h.replies.push(ok(mobileSnapshot({ profile: { id: ownerId } }))); await h.client.load();
}
test('planting client exposes account-scoped reads and settles receipts separately from financial state', async () => {
  const h = harness(); assert.equal(typeof h.client.loadPlantingStatus, 'function'); await login(h);
  h.replies.push(ok(status()), ok(record()), ok(page())); await h.client.loadPlantingStatus(); await h.client.loadPlantingRecord(recordId); await h.client.loadPlantingPage();
  const financial = h.client.snapshot; h.replies.push(ok(receipt())); await h.client.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 });
  assert.equal(h.client.snapshot, financial); assert.equal(h.client.plantingRecord, null); assert.equal(h.client.plantingPage, null); assert.equal(h.client.hasPending(), false);
  assert.equal(h.calls.at(-1).url.endsWith('/planting/commands'), true);
  await assert.rejects(h.client.loadPlantingPage('admin'), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.client.commandPlanting({ action: 'accept', orderId: id, expectedOrderVersion: 1 }), { code: 'INVALID_REQUEST' });
});
for (const httpStatus of [400, 403, 404, 409, 422, 429, 500, 503]) test(`planting unknown ${httpStatus} preserves original audience/key/body and sole pending slot`, async () => {
  const h = harness(); await login(h); h.replies.push({ status: httpStatus, data: { error: { code: 'REQUEST_REJECTED' }, data: mobileSnapshot({ revision: 99 }) } });
  await assert.rejects(h.client.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 }), { code: 'RESULT_UNKNOWN' });
  assert.equal(h.client.pendingKind, 'planting'); assert.equal(h.client.snapshot.revision, 3);
  await assert.rejects(h.client.mutate('/checkout'), { code: 'PENDING_OPERATION' });
  await assert.rejects(h.client.commandForum({ action: 'submit-post' }), { code: 'PENDING_OPERATION' });
  await assert.rejects(h.client.logout(), { code: 'PENDING_OPERATION' });
  h.replies.push(ok(receipt())); await h.client.retryPending(); assert.deepEqual(h.calls.at(-1), h.calls.at(-2)); assert.equal(h.client.hasPending(), false);
});
test('planting rejects foreign receipt and account recovery remains pinned to original account', async () => {
  const h = harness(); await login(h); h.replies.push(ok(receipt({ ownerId: 'member-b' })));
  await assert.rejects(h.client.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 }), { code: 'RESULT_UNKNOWN' });
  h.replies.push({ status: 401, data: { error: { code: 'UNAUTHENTICATED' } } }); await assert.rejects(h.client.retryPending(), { code: 'UNAUTHENTICATED' });
  assert.equal(h.client.plantingStatus, null); assert.equal(h.client.hasPending(), true);
  h.replies.push(ok({ token: 'other-token', profile: { id: 'member-b' } })); await assert.rejects(h.client.loginDevelopment('other'), { code: 'ACCOUNT_MISMATCH' });
  await login(h); h.replies.push(ok(receipt())); await h.client.retryPending(); assert.equal(h.client.hasPending(), false);
});
test('planting generations reject stale reads after mutation or account change, clear permissions before failed refresh', async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const reading = h.client.loadPlantingStatus();
  h.replies.push(ok(receipt())); await h.client.commandPlanting({ action: 'request', recordId, expectedRecordVersion: 1 }); finish(ok(status({ hasStaffAccess: true })));
  await assert.rejects(reading, { code: 'READ_SUPERSEDED' }); assert.equal(h.client.plantingStatus, null);
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loadPlantingPage(); await login(h, 'member-b'); finish(ok(page()));
  await assert.rejects(old, { code: 'SESSION_CHANGED' }); assert.equal(h.client.plantingPage, null);
});
test('cold clients read existing active order instead of assuming original operation key recovery', async () => {
  const h = harness(); await login(h); h.replies.push(ok(record({ enabled: false, currentOrderId: id }))); const current = await h.client.loadPlantingRecord(recordId);
  assert.equal(current.currentOrderId, id); assert.equal(h.client.hasPending(), false); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});
