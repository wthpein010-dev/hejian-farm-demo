import test from 'node:test';
import { syntheticSession } from './helpers/session-fixture.mjs';
import assert from 'node:assert/strict';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const now = 1793044800000, id = 'a'.repeat(32), epoch = 'e'.repeat(32), batchId = 'b'.repeat(32);
const command = { domain: 'eggs', action: 'collect', batchId, expectedBatchVersion: 1, expectedRevision: 3 };
const ok = data => ({ status: 200, data: { data } });
const scope = { recoveryFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
const receipt = { eggFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'intent-' + id, action: 'collect', outcome: 'applied', code: 'OK', batchId, quantity: 6, appliedRevision: 4, completedAt: now };
const intent = (phase = 'prepared', extra = {}) => ({ id, audience: 'customer', command, operationKey: 'intent-' + id, prepareEpoch: epoch, prepareVersion: 0, phase, version: phase === 'prepared' ? 1 : 2, createdAt: now, updatedAt: now, closedAt: null, receipt: phase === 'settled' ? receipt : null, ...extra });
const result = (operation, target, extra = {}) => ({ ...scope, operation, code: 'OK', epoch, version: target.version, currentIntentId: target.closedAt === null ? id : null, intent: target, attempt: null, ...extra });
function harness(open = null) {
  let current = open, ownerId = 'member-a', revision = 3, slotVersion = open ? open.version : 0;
  const calls = [], overrides = [], loginReplies = [];
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', transport: async request => {
    calls.push(request); const path = request.url.split('/api/v1')[1];
    if (path === '/auth/development') return loginReplies.length ? loginReplies.shift() : ok(syntheticSession({ token: 'token', environment: 'development', profile: { id: ownerId } }));
    if (path === '/bootstrap') { const custom = overrides[0]?.bootstrap; if (custom) { overrides.shift(); return custom(); } return ok(mobileSnapshot({ revision, profile: { id: ownerId } })); }
    const handler = overrides.shift(); if (handler) return handler(request);
    if (path === '/account/recovery') return ok({ ...scope, ownerId, available: true, epoch, version: slotVersion, intent: current });
    throw Error('Unexpected route');
  } });
  return { client, calls, overrides, loginReplies, setOpen(value) { current = value; slotVersion = Math.max(slotVersion, value ? value.version : 3); }, setRevision(value) { revision = value; }, setOwner(value) { ownerId = value; } };
}
test('eggs uses the one recovery prepare execute slot and retains the original collect receipt', async () => {
  const h = harness(); await h.client.loginDevelopment('synthetic'); await h.client.load();
  h.overrides.push(request => ok(result('prepare', intent(), { attempt: request.body })), () => ok(result('execute', intent('settled'))));
  assert.deepEqual(await h.client.commandEggs('customer', command), receipt);
  assert.equal(h.client.pendingKind, 'eggs'); assert.equal(h.client.pendingStage, 'receipt-review');
  assert.equal(h.client.snapshot.revision, 3); assert.equal(h.client.minimumConfirmedRevision, 4);
  assert.equal(h.calls.filter(call => call.url.endsWith('/execute')).length, 1);
});
test('cold prepared egg collection never executes until explicit continue, then exact ack does not depend on snapshot GET', async () => {
  const h = harness(intent()); await h.client.loginDevelopment('synthetic'); await h.client.load();
  await h.client.retryPending(); assert.equal(h.calls.some(call => call.url.endsWith('/execute')), false);
  h.overrides.push(() => ok(result('execute', intent('settled')))); await h.client.continueRecovery();
  h.setOpen(null); h.overrides.push(() => ok(result('ack', intent('settled', { version: 3, closedAt: now }))));
  await h.client.acknowledgeRecovery(id); assert.equal(h.client.hasPending(), false);
  assert.equal(h.client.assetSyncRequired, true); assert.equal(h.client.mutationBlocked, true);
  await assert.rejects(h.client.load(), { code: 'ASSET_SYNC_REQUIRED' });
  await assert.rejects(h.client.mutate('/checkout'), { code: 'ASSET_SYNC_REQUIRED' });
  h.setRevision(4); await h.client.load(); assert.equal(h.client.mutationBlocked, false);
});
test('ack and lost GET keep known asset floor across same account re-login and clear it for another account', async () => {
  const h = harness(intent('settled')); await h.client.loginDevelopment('synthetic');
  assert.equal(h.client.minimumConfirmedRevision, 4);
  h.setOpen(null); h.overrides.push(() => ok(result('ack', intent('settled', { version: 3, closedAt: now })))); await h.client.acknowledgeRecovery(id);
  h.overrides.push({ bootstrap: () => { throw Error('lost'); } }); await assert.rejects(h.client.load(), { code: 'NETWORK_UNAVAILABLE' });
  await h.client.loginDevelopment('synthetic'); assert.equal(h.client.minimumConfirmedRevision, 4);
  await assert.rejects(h.client.load(), { code: 'ASSET_SYNC_REQUIRED' });
  h.setOwner('member-b'); await h.client.loginDevelopment('synthetic-b'); await h.client.load();
  assert.equal(h.client.minimumConfirmedRevision, 0); assert.equal(h.client.assetSyncRequired, false);
});

test('a malformed different-account login cannot reset a confirmed egg asset revision floor', async () => {
  const h = harness(intent('settled')); await h.client.loginDevelopment('synthetic');
  h.setOpen(null); h.overrides.push(() => ok(result('ack', intent('settled', { version: 3, closedAt: now }))));
  await h.client.acknowledgeRecovery(id);
  const profile = h.client.profile;
  const invalid = syntheticSession({ token: 'different-synthetic-token', profile: { id: 'member-b' } }); delete invalid.expiresAt;
  h.loginReplies.push(ok(invalid));
  await assert.rejects(h.client.loginDevelopment('synthetic-b'), { code: 'INVALID_SESSION' });
  assert.equal(h.client.profile, profile); assert.equal(h.client.minimumConfirmedRevision, 4);
  assert.equal(h.client.assetSyncRequired, true); assert.equal(h.client.mutationBlocked, true);
  await assert.rejects(h.client.load(), { code: 'ASSET_SYNC_REQUIRED' });
  h.setRevision(4); await h.client.load();
  assert.equal(h.client.minimumConfirmedRevision, 4); assert.equal(h.client.mutationBlocked, false);
});
test('old financial success below confirmed egg floor settles its key without rolling assets back or becoming unknown', async () => {
  const h = harness(); await h.client.loginDevelopment('synthetic'); await h.client.load();
  h.overrides.push(() => { throw Error('lost'); }); await assert.rejects(h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  const original = h.calls.at(-1); h.setOpen(intent('settled')); await h.client.discoverRecovery();
  h.overrides.push(request => { assert.deepEqual(request, original); return ok(mobileSnapshot({ revision: 3 })); });
  await h.client.retryPending(); assert.equal(h.client.pendingKind, 'eggs'); assert.equal(h.client.minimumConfirmedRevision, 4);
  h.setOpen(null); h.overrides.push(() => ok(result('ack', intent('settled', { version: 3, closedAt: now })))); await h.client.acknowledgeRecovery(id);
  assert.equal(h.client.hasPending(), false); assert.equal(h.client.assetSyncRequired, true);
});
test('old checkout replay after re-login settles without accepting stale assets and still locates its original receipt', async () => {
  const h = harness(); await h.client.loginDevelopment('synthetic'); await h.client.load();
  h.overrides.push(() => { throw Error('lost'); }); await assert.rejects(h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  h.setOpen(intent('settled')); await h.client.loginDevelopment('synthetic'); assert.equal(h.client.snapshot, null);
  h.overrides.push(() => ok(mobileSnapshot({ revision: 3 }))); await h.client.retryPending();
  assert.equal(h.client.snapshot, null); assert.equal(h.client.hasConfirmedCheckout, true); assert.equal(h.client.pendingKind, 'eggs');
  h.setOpen(null); h.overrides.push(() => ok(result('ack', intent('settled', { version: 3, closedAt: now })))); await h.client.acknowledgeRecovery(id);
  const exchange = { exchangeFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, exchange: { id: 'shop-api-' + 'c'.repeat(64), day: '2026-10-27', items: [{ sku: 'feed-pack', title: '合成饲料', art: 'feed', quantity: 1, unitPoints: 30, linePoints: 30, grant: { feed: 3 } }], count: 1, subtotal: 30, discount: 0, total: 30, couponId: null, received: { feed: 3 } } };
  h.overrides.push(() => ok(exchange)); assert.deepEqual(await h.client.loadConfirmedCheckout(), exchange); assert.equal(h.client.assetSyncRequired, true);
});
test('read-only eggs status and staff record cursors remain usable without Snapshot under a recovery discovery error', async () => {
  const h = harness(); h.overrides.push(() => ({ status: 503, data: { error: { code: 'SYNTHETIC_UNAVAILABLE' } } })); await h.client.loginDevelopment('synthetic');
  const eggScope = { eggFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
  h.overrides.push(() => ok({ ...eggScope, available: true, hasStaffAccess: true })); assert.equal((await h.client.loadEggsStatus()).hasStaffAccess, true);
  h.overrides.push(request => { assert.equal(request.url.endsWith('/staff/eggs/records/record-001'), true); return ok({ ...eggScope, items: [], nextCursor: null }); });
  await h.client.loadEggsRecords('record-001'); assert.equal(h.client.snapshot, null); assert.equal(h.client.mutationBlocked, true);
});
test('a later eggs detail read wins and unknown or cross-domain commands cannot take the pending slot', async () => {
  const h = harness(); await h.client.loginDevelopment('synthetic');
  const detail = id => ({ eggFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, batch: { id, recordId: 'animal-eggs-001', cycleRef: 'cycle-1', name: '合成蛋鸡', unitLabel: '鸡舍1', day: new Date(now + 28800000).toISOString().slice(0, 10), sourceRef: 'synthetic-001', quantity: 6, status: 'available', version: 1, createdAt: now, updatedAt: now, collectedAt: null, withdrawnAt: null }, permissions: { canCollect: true, canWithdraw: false } });
  let finish; h.overrides.push(() => new Promise(resolve => { finish = resolve; })); const old = h.client.loadEggsDetail('c'.repeat(32));
  h.overrides.push(() => ok(detail('d'.repeat(32)))); await h.client.loadEggsDetail('d'.repeat(32)); finish(ok(detail('c'.repeat(32)))); await assert.rejects(old, { code: 'READ_SUPERSEDED' }); assert.equal(h.client.eggsDetail.batch.id, 'd'.repeat(32));
  await h.client.load(); const before = h.calls.length;
  for (const [audience, value] of [['customer', { action: 'request', recordId: 'record-001', expectedRecordVersion: 1 }], ['staff', command], ['admin', command], ['customer', { ...command, quantity: 6 }]]) await assert.rejects(h.client.commandEggs(audience, value), { code: 'INVALID_REQUEST' });
  assert.equal(h.calls.length, before); assert.equal(h.client.hasPending(), false);
});
