import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFarmRegistry, FARM_REGISTRY_SQL } from '../services/api/src/farm-registry.mjs';
import { normalizeFarmBatch } from '../shared/farm-records.mjs';
const shared = await import('../shared/planting.mjs').catch((e) => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const domain = await import('../services/api/src/planting.mjs').catch((e) => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const NOW = 1800000000000,
  env = 'development';
function setup() {
  assert.equal(typeof domain.createPlanting, 'function');
  const db = new DatabaseSync(':memory:');
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,environment TEXT,identity_provider TEXT,created_at INTEGER,updated_at INTEGER); CREATE TABLE deletion_confirmations(user_id TEXT);`,
  );
  const users = {};
  for (const id of ['customer', 'other', 'dispatch', 'execute', 'outsider']) {
    users[id] = { id, environment: env, identity_provider: 'development' };
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, env, 'development', NOW - 100, NOW - 100);
  }
  db.exec(FARM_REGISTRY_SQL + domain.PLANTING_SQL);
  const registry = createFarmRegistry({ prepare: (q) => db.prepare(q), environment: env });
  registry.applyBatch(
    normalizeFarmBatch(
      {
        formatVersion: 1,
        batchId: 'batch-001',
        source: 'synthetic',
        entries: [
          {
            expectedVersion: 0,
            record: {
              id: 'plot-001',
              ownerId: 'customer',
              kind: 'plot',
              name: '合成番茄',
              unitLabel: '合成一号',
              cycleRef: 'cycle-1',
              status: 'planned',
              startedAt: null,
              expectedHarvestAt: NOW + 100,
              observedAt: NOW - 10,
              measurements: { areaM2: 12, moisturePercent: 30 },
            },
          },
        ],
      },
      { environment: env, now: NOW },
    ),
    NOW,
  );
  const m = domain.createPlanting({
    prepare: (q) => db.prepare(q),
    environment: env,
    farmRegistry: registry,
  });
  const provision = (overrides = {}) =>
    m.provision(
      {
        recordId: 'plot-001',
        expectedPlanVersion: 0,
        recordVersion: 1,
        enabled: true,
        notBefore: NOW + 10,
        staff: [
          { accountId: 'dispatch', role: 'dispatch' },
          { accountId: 'execute', role: 'execute' },
        ],
        ...overrides,
      },
      NOW,
    );
  const command = (who, key, input, time = NOW) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = m.command(
        users[who],
        who === 'customer' || who === 'other' ? 'customer' : 'staff',
        'operation-' + key,
        input,
        time,
      );
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const request = () =>
    command('customer', 'request-1', { action: 'request', recordId: 'plot-001', expectedRecordVersion: 1 });
  return { db, m, registry, users, provision, command, request };
}
test('wire rejects unknown fields, getters, wrong audiences and duplicate provisioning', () => {
  assert.equal(typeof shared.isPlantingCommand, 'function');
  assert.equal(
    shared.isPlantingCommand({ action: 'request', recordId: 'plot-001', expectedRecordVersion: 1 }),
    true,
  );
  assert.equal(
    shared.isPlantingCommand({
      action: 'request',
      recordId: 'plot-001',
      expectedRecordVersion: 1,
      role: 'dispatch',
    }),
    false,
  );
  let reads = 0;
  const x = { action: 'request', recordId: 'plot-001' };
  Object.defineProperty(x, 'expectedRecordVersion', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  assert.equal(shared.isPlantingCommand(x), false);
  assert.equal(reads, 0);
  assert.equal(
    shared.isPlantingCommand(
      { action: 'accept', orderId: 'a'.repeat(32), expectedOrderVersion: 1 },
      'customer',
    ),
    false,
  );
  assert.throws(() =>
    shared.normalizePlantingProvision({
      recordId: 'plot-001',
      expectedPlanVersion: 0,
      recordVersion: 1,
      enabled: true,
      notBefore: NOW,
      staff: [
        { accountId: 'dispatch', role: 'dispatch' },
        { accountId: 'dispatch', role: 'dispatch' },
      ],
    }),
  );
});
test('single active order, isolation and original key replay after revocation', () => {
  const { db, m, users, provision, command, request } = setup();
  provision();
  const r = request();
  assert.equal(r.code, 'OK');
  assert.equal(
    command('other', 'foreign', { action: 'request', recordId: 'plot-001', expectedRecordVersion: 1 }).code,
    'NOT_FOUND',
  );
  assert.equal(
    command('customer', 'request-2', { action: 'request', recordId: 'plot-001', expectedRecordVersion: 1 })
      .code,
    'ACTIVE_ORDER_EXISTS',
  );
  assert.throws(
    () => m.detail(users.other, 'customer', r.orderId, NOW),
    (e) => e.code === 'NOT_FOUND',
  );
  const accepted = command('dispatch', 'accept', {
    action: 'accept',
    orderId: r.orderId,
    expectedOrderVersion: 1,
  });
  assert.equal(accepted.code, 'OK');
  provision({ expectedPlanVersion: 1, staff: [] });
  assert.deepEqual(
    command('dispatch', 'accept', { action: 'accept', orderId: r.orderId, expectedOrderVersion: 1 }),
    accepted,
  );
  assert.equal(
    command('dispatch', 'new', {
      action: 'assign',
      orderId: r.orderId,
      expectedOrderVersion: 2,
      assigneeRef: 'a'.repeat(32),
    }).code,
    'NOT_FOUND',
  );
  assert.equal(domain.validatePlantingDatabase(db, NOW + 100), true);
  db.close();
});
function working(f) {
  f.provision();
  const r = f.request();
  f.command('dispatch', 'accept', { action: 'accept', orderId: r.orderId, expectedOrderVersion: 1 });
  const d = f.m.detail(f.users.dispatch, 'staff', r.orderId, NOW);
  f.command('dispatch', 'assign', {
    action: 'assign',
    orderId: r.orderId,
    expectedOrderVersion: 2,
    assigneeRef: d.candidates[0].ref,
  });
  return r;
}
test('completion changes exactly one archive history and clears old observations without financial changes', () => {
  const f = setup(),
    r = working(f);
  assert.equal(
    f.command('execute', 'early', { action: 'start', orderId: r.orderId, expectedOrderVersion: 3 }).code,
    'TOO_EARLY',
  );
  assert.equal(
    f.command('execute', 'start', { action: 'start', orderId: r.orderId, expectedOrderVersion: 3 }, NOW + 10)
      .code,
    'OK',
  );
  assert.equal(f.m.hasActiveWork('customer'), true);
  assert.equal(f.m.hasActiveWork('execute'), true);
  assert.throws(
    () => f.m.assertImportSafe({ entries: [{ record: { id: 'plot-001' } }] }),
    (e) => e.code === 'ACTIVE_WORK',
  );
  f.db.prepare('INSERT INTO deletion_confirmations VALUES (?)').run('customer');
  const c = f.command(
    'execute',
    'done',
    {
      action: 'complete',
      orderId: r.orderId,
      expectedOrderVersion: 4,
      expectedRecordVersion: 1,
      performedAt: NOW + 15,
    },
    NOW + 20,
  );
  assert.equal(c.code, 'OK');
  const record = f.registry.detail('customer', 'plot-001', 0, NOW + 20).record;
  assert.equal(record.version, 2);
  assert.equal(record.startedAt, NOW + 15);
  assert.equal(record.expectedHarvestAt, null);
  assert.deepEqual(record.measurements, {});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM farm_record_events').get().n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM deletion_confirmations').get().n, 0);
  assert.deepEqual(
    f.command(
      'execute',
      'done',
      {
        action: 'complete',
        orderId: r.orderId,
        expectedOrderVersion: 4,
        expectedRecordVersion: 1,
        performedAt: NOW + 15,
      },
      NOW + 30,
    ),
    c,
  );
  assert.equal(f.m.hasActiveWork('customer'), false);
  assert.equal(f.m.detail(f.users.dispatch, 'staff', r.orderId, NOW + 20).order.status, 'completed');
  assert.equal(domain.validatePlantingDatabase(f.db, NOW + 100), true);
  f.db.close();
});
test('manual stop works with disabled plan and restoration revokes authority', () => {
  const f = setup(),
    r = working(f);
  f.command('execute', 'start', { action: 'start', orderId: r.orderId, expectedOrderVersion: 3 }, NOW + 10);
  f.provision({ expectedPlanVersion: 1, enabled: false });
  assert.equal(
    f.command(
      'dispatch',
      'stop',
      {
        action: 'cancel-work',
        orderId: r.orderId,
        expectedOrderVersion: 4,
        stoppedAt: NOW + 12,
        reason: 'farm-confirmed-stop',
      },
      NOW + 20,
    ).code,
    'OK',
  );
  assert.equal(f.m.record(f.users.customer, 'plot-001', NOW + 20).enabled, false);
  assert.equal(f.m.hasActiveWork('customer'), false);
  domain.restorePlantingAuthorization(f.db);
  assert.equal(f.m.status(f.users.dispatch, NOW + 30).hasStaffAccess, false);
  assert.equal(domain.validatePlantingDatabase(f.db, NOW + 100), true);
  f.db.close();
});
test('assignment budget reserves final start and completion events', () => {
  const f = setup(),
    r = working(f);
  const ref = f.m.detail(f.users.dispatch, 'staff', r.orderId, NOW).candidates[0].ref;
  for (let version = 3; version < 98; version++)
    assert.equal(
      f.command('dispatch', 'assign-' + version, {
        action: 'assign',
        orderId: r.orderId,
        expectedOrderVersion: version,
        assigneeRef: ref,
      }).code,
      'OK',
    );
  assert.equal(
    f.command('dispatch', 'limit', {
      action: 'assign',
      orderId: r.orderId,
      expectedOrderVersion: 98,
      assigneeRef: ref,
    }).code,
    'EVENT_LIMIT',
  );
  assert.equal(
    f.command(
      'execute',
      'last-start',
      { action: 'start', orderId: r.orderId, expectedOrderVersion: 98 },
      NOW + 10,
    ).code,
    'OK',
  );
  assert.equal(
    f.command(
      'execute',
      'last-complete',
      {
        action: 'complete',
        orderId: r.orderId,
        expectedOrderVersion: 99,
        expectedRecordVersion: 1,
        performedAt: NOW + 15,
      },
      NOW + 20,
    ).code,
    'OK',
  );
  assert.equal(f.m.detail(f.users.customer, 'customer', r.orderId, NOW + 20).events.length, 100);
  assert.equal(domain.validatePlantingDatabase(f.db, NOW + 100), true);
  f.db.close();
});
test('deleting an ended staff member clears direct references and invalidates affected confirmations', () => {
  const f = setup(),
    r = working(f);
  assert.throws(
    () => f.m.deleteOwner('execute', NOW),
    (e) => e.code === 'ACTIVE_WORK',
  );
  f.command('customer', 'cancel', { action: 'cancel', orderId: r.orderId, expectedOrderVersion: 3 });
  f.db.prepare('INSERT INTO deletion_confirmations VALUES (?)').run('customer');
  f.m.deleteOwner('execute', NOW);
  f.db.prepare('DELETE FROM users WHERE id = ?').run('execute');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM deletion_confirmations').get().n, 0);
  assert.equal(domain.validatePlantingDatabase(f.db, NOW + 100), true);
  f.db.close();
});
test('backup content rejects orders detached from their source archive and corrupt event actions', () => {
  for (const mutation of ['recordVersion', 'event']) {
    const f = setup(),
      r = working(f);
    if (mutation === 'recordVersion') {
      const row = f.db.prepare('SELECT data_json FROM planting_orders').get(),
        o = JSON.parse(row.data_json);
      o.name = '伪造来源';
      f.db.prepare('UPDATE planting_orders SET data_json = ?').run(JSON.stringify(o));
    } else {
      const row = f.db.prepare('SELECT data_json FROM planting_events WHERE version = 2').get(),
        e = JSON.parse(row.data_json);
      e.action = 'complete';
      f.db.prepare('UPDATE planting_events SET data_json = ? WHERE version = 2').run(JSON.stringify(e));
    }
    assert.throws(
      () => domain.validatePlantingDatabase(f.db, NOW + 100),
      (e) => e.code === 'INVALID_PLANTING_DATA',
    );
    f.db.close();
  }
});
test('backup content rejects random applied receipts', () => {
  const f = setup();
  f.provision();
  const r = f.request();
  const c = JSON.parse(f.db.prepare('SELECT result_json FROM planting_commands').get().result_json);
  c.action = 'complete';
  f.db.prepare('UPDATE planting_commands SET result_json = ?').run(JSON.stringify(c));
  assert.throws(
    () => domain.validatePlantingDatabase(f.db, NOW + 100),
    (e) => e.code === 'INVALID_PLANTING_DATA',
  );
  f.db.close();
});
test('backup content rejects more than forty active grants', () => {
  const f = setup();
  f.provision();
  for (let n = 0; n < 39; n++) {
    const id = 'synthetic-' + n;
    f.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, env, 'development', NOW - 100, NOW);
    f.db
      .prepare('INSERT INTO planting_grants VALUES (?,?,?,?,?,1,1,?,?)')
      .run(env, 'plot-001', id, 'execute', n.toString(16).padStart(32, '0'), NOW, NOW);
  }
  assert.throws(
    () => domain.validatePlantingDatabase(f.db, NOW + 100),
    (e) => e.code === 'INVALID_PLANTING_DATA',
  );
  f.db.close();
});
test('operation keys preserve the existing dotted and colon protocol, with strict bounds', () => {
  const f = setup();
  f.provision();
  const input = { action: 'request', recordId: 'plot-001', expectedRecordVersion: 1 };
  const key = 'planting:request.001';
  const result = f.m.command(f.users.customer, 'customer', key, input, NOW);
  assert.equal(result.code, 'OK');
  assert.deepEqual(f.m.command(f.users.customer, 'customer', key, input, NOW + 10), result);
  assert.equal(shared.isPlantingReceipt(result, 'customer', env, key, 'request'), true);
  for (const invalid of ['short', '_invalid-prefix', 'a'.repeat(101), key + '\n']) {
    assert.throws(
      () => f.m.command(f.users.customer, 'customer', invalid, input, NOW),
      (e) => e.code === 'INVALID_PLANTING_DATA',
    );
    assert.equal(
      shared.isPlantingReceipt({ ...result, operationKey: invalid }, 'customer', env, invalid, 'request'),
      false,
    );
  }
  f.db.close();
});
test('plan version exhaustion fails before mutating the private configuration', () => {
  const f = setup();
  f.provision();
  f.db.prepare('UPDATE planting_plans SET version = ?').run(Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => f.provision({ expectedPlanVersion: Number.MAX_SAFE_INTEGER }),
    (e) => e.code === 'INVALID_PLANTING_DATA',
  );
  assert.equal(f.db.prepare('SELECT version FROM planting_plans').get().version, Number.MAX_SAFE_INTEGER);
  f.db.close();
});
test('completed records allow disabling the plan and revoking every staff grant', () => {
  const f = setup(),
    r = working(f);
  f.command('execute', 'start', { action: 'start', orderId: r.orderId, expectedOrderVersion: 3 }, NOW + 10);
  const completeInput = {
    action: 'complete',
    orderId: r.orderId,
    expectedOrderVersion: 4,
    expectedRecordVersion: 1,
    performedAt: NOW + 15,
  };
  const completed = f.command('execute', 'complete', completeInput, NOW + 20);
  assert.equal(completed.code, 'OK');
  for (const id of ['customer', 'dispatch', 'execute'])
    f.db.prepare('INSERT INTO deletion_confirmations VALUES (?)').run(id);
  const provision = {
    recordId: 'plot-001',
    expectedPlanVersion: 1,
    recordVersion: 2,
    enabled: false,
    notBefore: NOW + 10,
    staff: [],
  };
  assert.deepEqual(f.m.provision(provision, NOW + 30), {
    ok: true,
    operation: 'planting-provision',
    version: 2,
    grants: 0,
  });
  for (const id of ['dispatch', 'execute']) {
    assert.equal(f.m.status(f.users[id], NOW + 30).hasStaffAccess, false);
    assert.throws(
      () => f.m.detail(f.users[id], 'staff', r.orderId, NOW + 30),
      (e) => e.code === 'NOT_FOUND',
    );
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM deletion_confirmations').get().n, 0);
  assert.equal(
    f.command(
      'customer',
      'request-after-revoke',
      {
        action: 'request',
        recordId: 'plot-001',
        expectedRecordVersion: 2,
      },
      NOW + 30,
    ).code,
    'PLAN_DISABLED',
  );
  assert.throws(
    () => f.m.provision({ ...provision, expectedPlanVersion: 2, enabled: true }, NOW + 30),
    (e) => e.code === 'RECORD_CHANGED',
  );
  assert.throws(
    () => f.m.provision({ ...provision, expectedPlanVersion: 2, recordVersion: 1 }, NOW + 30),
    (e) => e.code === 'RECORD_CHANGED',
  );
  assert.deepEqual(f.command('execute', 'complete', completeInput, NOW + 30), completed);
  assert.equal(domain.validatePlantingDatabase(f.db, NOW + 100), true);
  f.db.close();
});
