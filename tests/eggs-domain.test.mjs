import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('eggs boundary requires explicit domain, exact fields, audience and bounded actual quantity', async () => {
  assert.equal(existsSync(new URL('../shared/eggs.mjs', import.meta.url)), true, 'strict eggs boundary is implemented');
  const e = await import('../shared/eggs.mjs');
  const input = { domain: 'eggs', action: 'register', recordId: 'animal-00000001', expectedProfileVersion: 1, sourceRef: 'source-0001', quantity: 5 };
  assert.equal(e.isEggsCommand(input, 'staff'), true);
  assert.equal(e.isEggsCommand(input, 'customer'), false);
  for (const patch of [{ domain: undefined }, { quantity: 0 }, { quantity: 10001 }, { sourceRef: 'a b c d e' }, { sourceRef: 'source-0001\n' }, { ownerId: 'other' }])
    assert.equal(e.isEggsCommand({ ...input, ...patch }, 'staff'), false);
  const getter = { ...input }; Object.defineProperty(getter, 'quantity', { enumerable: true, get() { throw Error('must not invoke'); } });
  assert.equal(e.isEggsCommand(getter, 'staff'), false);
  assert.equal(e.isEggsCommand({ domain: 'eggs', action: 'collect', batchId: 'a'.repeat(32), expectedBatchVersion: 1, expectedRevision: 0 }), true);
});

test('eggs provisioning is explicit and receipts separate issued assets from current snapshots', async () => {
  assert.equal(existsSync(new URL('../shared/eggs.mjs', import.meta.url)), true, 'strict eggs boundary is implemented');
  const e = await import('../shared/eggs.mjs');
  const provision = { recordId: 'animal-00000001', expectedProfileVersion: 0, recordVersion: 1, profile: 'chicken-eggs', enabled: true, maxDailyQuantity: 20, staff: [{ accountId: 'staff-0001', role: 'record' }] };
  assert.deepEqual(e.normalizeEggsProvision(provision), provision);
  for (const patch of [{ profile: 'pig' }, { maxDailyQuantity: 0 }, { staff: [{ accountId: 'staff-0001', role: 'dispatch' }] }, { staff: [...provision.staff, ...provision.staff] }])
    assert.throws(() => e.normalizeEggsProvision({ ...provision, ...patch }));
  const receipt = { eggFormat: 1, ownerId: 'owner-0001', environment: 'development', operationKey: 'intent-' + '1'.repeat(32), action: 'collect', outcome: 'applied', code: 'OK', batchId: 'a'.repeat(32), completedAt: 100, quantity: 5, appliedRevision: 1 };
  assert.equal(e.isEggsReceipt(receipt, receipt.ownerId, receipt.environment, receipt.operationKey, 'collect'), true);
  for (const patch of [{ quantity: 0 }, { appliedRevision: null }, { revision: 1 }, { ownerId: 'other-0001' }, { action: 'register' }])
    assert.equal(e.isEggsReceipt({ ...receipt, ...patch }, receipt.ownerId, receipt.environment, receipt.operationKey, 'collect'), false);
});
