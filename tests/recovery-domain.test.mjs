import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createFarmRegistry, FARM_REGISTRY_SQL } from '../services/api/src/farm-registry.mjs';
import { createPlanting, PLANTING_SQL, PlantingError } from '../services/api/src/planting.mjs';
import { normalizeFarmBatch } from '../shared/farm-records.mjs';
const domain = await import('../services/api/src/recovery.mjs').catch((e) => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const wire = await import('../shared/recovery.mjs').catch((e) => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const NOW = 1800000000000;
const env = 'development';
const command = {
  action: 'request',
  recordId: 'plot-001',
  expectedRecordVersion: 1,
};
function setup(databasePath = ':memory:') {
  assert.equal(typeof domain.createRecovery, 'function', 'recovery domain must exist');
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, environment TEXT, identity_provider TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS deletion_confirmations(user_id TEXT);
    INSERT OR IGNORE INTO users VALUES ('customer','development','development',1799999999000,1799999999000);
    INSERT OR IGNORE INTO users VALUES ('other','development','development',1799999999000,1799999999000);`);
  db.exec(FARM_REGISTRY_SQL + PLANTING_SQL + domain.RECOVERY_SQL);
  const prepare = (sql) => db.prepare(sql);
  const registry = createFarmRegistry({ prepare, environment: env });
  let recovery;
  const planting = createPlanting({
    prepare,
    environment: env,
    farmRegistry: registry,
    beforeNewCommand(user, audience, key, input, now, intentId) {
      if (recovery.allowCommand(user, audience, key, input, intentId)) return null;
      if (/^intent-[a-f0-9]{32}$/u.test(key)) throw new PlantingError('RESERVED_OPERATION_KEY');
      return recovery.hasOpen(user.id) ? 'INTENT_PENDING' : null;
    },
  });
  const executePlanting = (user, audience, key, input, now, intentId) => {
    assert.equal(recovery.allowCommand(user, audience, key, input, intentId), true);
    return planting.command(user, audience, key, input, now, intentId);
  };
  recovery = domain.createRecovery({
    prepare,
    environment: env,
    executePlanting,
  });
  const user = {
    id: 'customer',
    environment: env,
    identity_provider: 'development',
  };
  const other = { ...user, id: 'other' };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const attempt = (overrides = {}) => ({
    expectedEpoch: recovery.current(user, NOW).epoch,
    expectedVersion: recovery.current(user, NOW).version,
    audience: 'customer',
    command: { ...command },
    ...overrides,
  });
  const start = (input = attempt(), now = NOW) =>
    tx(() => recovery.prepareIntent(user, input, now));
  return { db, registry, recovery, planting, user, other, tx, attempt, start };
}
function provisionPlanned({ registry, planting }) {
  const batch = normalizeFarmBatch(
    {
      formatVersion: 1,
      batchId: 'synthetic-recovery-batch',
      source: 'synthetic-recovery',
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
            expectedHarvestAt: null,
            observedAt: NOW - 1,
            measurements: {},
          },
        },
      ],
    },
    { environment: env, now: NOW },
  );
  registry.applyBatch(batch, NOW);
  planting.provision(
    {
      recordId: 'plot-001',
      expectedPlanVersion: 0,
      recordVersion: 1,
      enabled: true,
      notBefore: NOW,
      staff: [],
    },
    NOW,
  );
}
test('prepare persists without executing and survives loss of its response', () => {
  const { db, recovery, user, start, attempt } = setup();
  const a = attempt();
  const first = start(a);
  assert.equal(first.code, 'OK');
  assert.equal(first.version, 1);
  assert.equal(first.intent.phase, 'prepared');
  assert.equal(first.intent.version, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM planting_commands').get().n, 0);
  assert.deepEqual(start(a).intent, first.intent);
  assert.equal(recovery.current(user, NOW + 1).intent.id, first.intent.id);
  assert.equal(wire.isRecoveryView(recovery.current(user, NOW), user.id, env), true);
  assert.equal(wire.isRecoveryResult(first, user.id, env, 'prepare', a), true);
  db.close();
});
test('prepare tombstone wins after ack and new slot; different command conflicts', () => {
  const { db, recovery, user, tx, start, attempt } = setup();
  const a = attempt();
  const first = start(a);
  const settled = tx(() => recovery.execute(user, first.intent.id, NOW + 1));
  assert.equal(settled.intent.receipt.code, 'NOT_FOUND');
  const closed = tx(() => recovery.acknowledge(user, first.intent.id, NOW + 2));
  const second = tx(() => recovery.prepareIntent(user, attempt(), NOW + 3));
  const late = tx(() => recovery.prepareIntent(user, a, NOW + 4));
  assert.deepEqual(late.intent, closed.intent);
  assert.equal(late.currentIntentId, second.intent.id);
  assert.equal(late.version, second.version);
  assert.equal(
    tx(() =>
      recovery.prepareIntent(
        user,
        { ...a, command: { ...command, expectedRecordVersion: 2 } },
        NOW + 4,
      ),
    ).code,
    'PREPARE_CONFLICT',
  );
  assert.equal(
    tx(() => recovery.acknowledge(user, first.intent.id, NOW + 5)).currentIntentId,
    second.intent.id,
  );
  assert.equal(recovery.current(user, NOW + 5).intent.id, second.intent.id);
  db.close();
});
test('two distinct prepares sharing a CAS admit one intent and cannot bind another body', () => {
  const { db, start, attempt, recovery, user, tx } = setup();
  const a = attempt();
  const first = start(a);
  const second = start({
    ...a,
    command: { ...command, expectedRecordVersion: 2 },
  });
  assert.equal(second.code, 'PREPARE_CONFLICT');
  assert.equal(db.prepare('SELECT count(*) n FROM planting_intents').get().n, 1);
  assert.equal(start({ ...a, expectedVersion: 99 }).code, 'SLOT_CHANGED');
  assert.equal(start({ ...a, expectedEpoch: 'f'.repeat(32) }).code, 'EPOCH_CHANGED');
  assert.equal(
    tx(() => recovery.abandon(user, first.intent.id, NOW + 1)).intent.phase,
    'abandoned',
  );
  assert.equal(start(a, NOW + 2).intent.phase, 'abandoned');
  db.close();
});
test('execute and abandon serialize in either order without claiming executed work was abandoned', () => {
  for (const executeFirst of [true, false]) {
    const { db, recovery, user, tx, start } = setup();
    const id = start().intent.id;
    if (executeFirst) {
      const executed = tx(() => recovery.execute(user, id, NOW + 1));
      assert.equal(tx(() => recovery.abandon(user, id, NOW + 2)).intent.phase, 'settled');
      assert.deepEqual(
        tx(() => recovery.execute(user, id, NOW + 3)).intent.receipt,
        executed.intent.receipt,
      );
      assert.equal(db.prepare('SELECT count(*) n FROM planting_commands').get().n, 1);
      assert.equal(recovery.hasOpen(user.id), true);
    } else {
      tx(() => recovery.abandon(user, id, NOW + 1));
      assert.equal(tx(() => recovery.execute(user, id, NOW + 2)).intent.phase, 'abandoned');
      assert.equal(db.prepare('SELECT count(*) n FROM planting_commands').get().n, 0);
      assert.equal(recovery.hasOpen(user.id), false);
    }
    db.close();
  }
});
test('intent context is narrow, owned and canonical; raw reserved guard cannot poison its receipt', () => {
  const { db, recovery, user, other, start } = setup();
  const intent = start().intent;
  assert.equal(
    recovery.allowCommand(
      user,
      'customer',
      intent.operationKey,
      { expectedRecordVersion: 1, recordId: 'plot-001', action: 'request' },
      intent.id,
    ),
    true,
  );
  for (const args of [
    [user, 'customer', intent.operationKey, command, undefined],
    [other, 'customer', intent.operationKey, command, intent.id],
    [user, 'staff', intent.operationKey, command, intent.id],
    [user, 'customer', 'operation-another', command, intent.id],
    [user, 'customer', intent.operationKey, { ...command, expectedRecordVersion: 2 }, intent.id],
  ])
    assert.equal(recovery.allowCommand(...args), false);
  assert.equal(db.prepare('SELECT count(*) n FROM planting_commands').get().n, 0);
  db.close();
});
test('original receipt bytes and owner binding survive new reads; changes revoke deletion confirmation', () => {
  const { db, recovery, user, other, tx, start } = setup();
  db.prepare('INSERT INTO deletion_confirmations VALUES (?)').run(user.id);
  const intent = start().intent;
  assert.equal(db.prepare('SELECT count(*) n FROM deletion_confirmations').get().n, 0);
  assert.throws(() => recovery.detail(other, intent.id, NOW), {
    code: 'NOT_FOUND',
  });
  const result = tx(() => recovery.execute(user, intent.id, NOW + 1));
  const receipt = db
    .prepare('SELECT result_json FROM planting_commands WHERE key = ?')
    .get(intent.operationKey).result_json;
  assert.equal(
    db.prepare('SELECT receipt_json FROM planting_intents WHERE id = ?').get(intent.id)
      .receipt_json,
    receipt,
  );
  assert.equal(
    wire.isRecoveryDetail(recovery.detail(user, intent.id, NOW + 2), user.id, env, intent.id),
    true,
  );
  assert.equal(wire.isRecoveryResult(result, user.id, env, 'execute'), true);
  assert.throws(() => recovery.deleteOwner(user.id), {
    code: 'RECOVERY_PENDING',
  });
  tx(() => recovery.acknowledge(user, intent.id, NOW + 2));
  tx(() => recovery.deleteOwner(user.id));
  assert.equal(db.prepare('SELECT count(*) n FROM planting_intents').get().n, 0);
  db.close();
});
test('wire rejects extra fields, accessors, invalid phases and substituted original receipts', () => {
  const { db, recovery, user, tx, start, attempt } = setup();
  const a = attempt();
  assert.equal(wire.isRecoveryPrepare(a), true);
  assert.equal(wire.isRecoveryPrepare({ ...a, audience: undefined }), false);
  assert.equal(wire.isRecoveryPrepare({ ...a, secret: 'forbidden' }), false);
  let reads = 0;
  const getter = { ...a };
  Object.defineProperty(getter, 'command', {
    enumerable: true,
    get() {
      reads++;
      return command;
    },
  });
  assert.equal(wire.isRecoveryPrepare(getter), false);
  assert.equal(reads, 0);
  const id = start().intent.id;
  const view = recovery.current(user, NOW);
  assert.equal(
    wire.isRecoveryView({ ...view, intent: { ...view.intent, version: 2 } }, user.id, env),
    false,
  );
  const result = tx(() => recovery.execute(user, id, NOW + 1));
  assert.equal(
    wire.isRecoveryResult(
      {
        ...result,
        intent: {
          ...result.intent,
          receipt: { ...result.intent.receipt, ownerId: 'other' },
        },
      },
      user.id,
      env,
      'execute',
    ),
    false,
  );
  assert.equal(wire.isRecoveryResult(result, user.id, env, 'ack'), false);
  assert.equal(wire.isRecoveryResult({ ...result, attempt: a }, user.id, env, 'execute'), false);
  db.close();
});
test('restore fences old epoch and quarantines unexecuted intents without changing ledger receipts', () => {
  const { db, recovery, user, tx, start, attempt } = setup();
  const a = attempt();
  const first = start(a);
  assert.equal(domain.validateRecoveryDatabase(db, NOW), true);
  tx(() => domain.restoreRecoveryDatabase(db, NOW + 1));
  const view = recovery.current(user, NOW + 1);
  assert.notEqual(view.epoch, a.expectedEpoch);
  assert.equal(view.version, 2);
  assert.equal(view.intent.phase, 'quarantined');
  for (const method of ['execute', 'acknowledge', 'abandon'])
    assert.throws(() => tx(() => recovery[method](user, first.intent.id, NOW + 2)), {
      code: 'RECOVERY_QUARANTINED',
    });
  assert.equal(start(a, NOW + 2).intent.phase, 'quarantined');
  assert.equal(start({ ...a, expectedVersion: 9 }).code, 'EPOCH_CHANGED');
  assert.equal(domain.validateRecoveryDatabase(db, NOW + 2), true);
  db.close();
});
test('backup validation rejects fingerprint, receipt owner, epoch and cross-owner slot tampering', () => {
  const mutations = [
    (db) => db.exec("UPDATE planting_intents SET fingerprint = '" + 'a'.repeat(64) + "'"),
    (db) =>
      db.exec(
        "UPDATE planting_intents SET receipt_json = json_set(receipt_json,'$.ownerId','other')",
      ),
    (db) => db.exec("UPDATE recovery_epoch SET epoch = 'broken'"),
    (db) => db.exec("UPDATE recovery_slots SET owner_id = 'other'"),
  ];
  for (const mutate of mutations) {
    const { db, recovery, user, tx, start } = setup();
    const id = start().intent.id;
    tx(() => recovery.execute(user, id, NOW + 1));
    assert.equal(domain.validateRecoveryDatabase(db, NOW + 1), true);
    db.exec('PRAGMA foreign_keys=OFF');
    mutate(db);
    assert.throws(() => domain.validateRecoveryDatabase(db, NOW + 1), {
      code: 'INVALID_RECOVERY_DATA',
    });
    db.close();
  }
});
test('failed execute rolls its business ledger and settlement back together', () => {
  const system = setup();
  const { db, recovery, user, tx, start } = system;
  provisionPlanned(system);
  const id = start().intent.id;
  db.exec(
    `CREATE TRIGGER fail_settle BEFORE UPDATE OF phase ON planting_intents WHEN NEW.phase = 'settled' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`,
  );
  assert.throws(() => tx(() => recovery.execute(user, id, NOW + 1)));
  assert.equal(recovery.current(user, NOW + 1).intent.phase, 'prepared');
  assert.equal(db.prepare('SELECT count(*) n FROM planting_commands').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM planting_orders').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM planting_events').get().n, 0);
  db.close();
});
test('prepare avoids a pre-existing legacy intent-shaped operation key and has bounded collision attempts', (t) => {
  const { db, recovery, user, tx, attempt } = setup();
  const oldId = 'a'.repeat(32);
  const oldReceipt = {
    plantingFormat: 1,
    ownerId: user.id,
    environment: env,
    operationKey: 'intent-' + oldId,
    action: 'request',
    outcome: 'refused',
    code: 'NOT_FOUND',
    orderId: null,
    completedAt: NOW - 1,
  };
  const fingerprint = createHash('sha256')
    .update(
      '{"audience":"customer","command":{"action":"request","expectedRecordVersion":1,"recordId":"plot-001"}}',
    )
    .digest('hex');
  db.prepare('INSERT INTO planting_commands VALUES (?,?,?,?,?,?)').run(
    env,
    user.id,
    oldReceipt.operationKey,
    fingerprint,
    JSON.stringify(oldReceipt),
    NOW - 1,
  );
  let draws = 0;
  const mocked = t.mock.method(crypto, 'randomBytes', () =>
    Buffer.from((draws++ === 0 ? 'a' : 'b').repeat(32), 'hex'),
  );
  syncBuiltinESMExports();
  try {
    const result = tx(() => recovery.prepareIntent(user, attempt(), NOW));
    assert.equal(result.intent.id, 'b'.repeat(32));
    assert.equal(draws, 2);
    assert.equal(
      db
        .prepare('SELECT result_json FROM planting_commands WHERE key = ?')
        .get(oldReceipt.operationKey).result_json,
      JSON.stringify(oldReceipt),
    );
    tx(() => recovery.abandon(user, result.intent.id, NOW + 1));
    mocked.mock.restore();
    let attempts = 0;
    t.mock.method(crypto, 'randomBytes', () => {
      attempts++;
      return Buffer.from('a'.repeat(32), 'hex');
    });
    syncBuiltinESMExports();
    assert.throws(() => tx(() => recovery.prepareIntent(user, attempt(), NOW + 2)), {
      code: 'INVALID_RECOVERY_DATA',
    });
    assert.equal(attempts, 16);
    assert.equal(db.prepare('SELECT count(*) n FROM planting_intents').get().n, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    db.close();
  }
});
test('production and non-development identities fail closed without creating slots', () => {
  const { db, recovery, user, attempt, tx } = setup();
  db.exec("UPDATE users SET identity_provider = 'weixin' WHERE id = 'customer'");
  assert.equal(recovery.current(user, NOW).available, false);
  assert.equal(tx(() => recovery.prepareIntent(user, attempt(), NOW)).code, 'RECOVERY_UNAVAILABLE');
  assert.equal(db.prepare('SELECT count(*) n FROM recovery_slots').get().n, 0);
  const prod = domain.createRecovery({
    prepare: (q) => db.prepare(q),
    environment: 'production',
    executePlanting() {
      assert.fail('must not execute');
    },
  });
  db.exec("UPDATE users SET environment = 'production' WHERE id = 'customer'");
  const prodUser = {
    ...user,
    environment: 'production',
    identity_provider: 'weixin',
  };
  const view = prod.current(prodUser, NOW);
  assert.equal(view.available, false);
  assert.equal(wire.isRecoveryView(view, user.id, 'production'), true);
  assert.equal(
    tx(() =>
      prod.prepareIntent(
        prodUser,
        {
          expectedEpoch: view.epoch,
          expectedVersion: 0,
          audience: 'customer',
          command,
        },
        NOW,
      ),
    ).code,
    'RECOVERY_UNAVAILABLE',
  );
  db.close();
});
test('restore preserves settled original bytes and permits only exact acknowledgement', () => {
  const { db, recovery, user, tx, start } = setup();
  const id = start().intent.id;
  const original = tx(() => recovery.execute(user, id, NOW + 1));
  const json = db
    .prepare('SELECT receipt_json FROM planting_intents WHERE id = ?')
    .get(id).receipt_json;
  tx(() => domain.restoreRecoveryDatabase(db, NOW + 2));
  assert.equal(domain.validateRecoveryDatabase(db, NOW + 2), true);
  assert.equal(recovery.current(user, NOW + 2).intent.phase, 'settled');
  assert.deepEqual(
    tx(() => recovery.execute(user, id, NOW + 3)).intent.receipt,
    original.intent.receipt,
  );
  assert.equal(
    db.prepare('SELECT receipt_json FROM planting_intents WHERE id = ?').get(id).receipt_json,
    json,
  );
  const closed = tx(() => recovery.acknowledge(user, id, NOW + 3));
  assert.equal(closed.intent.closedAt, NOW + 3);
  assert.equal(closed.version, 4);
  assert.equal(domain.validateRecoveryDatabase(db, NOW + 3), true);
  db.close();
});
test('version overflow rejects mutation and restore atomically', () => {
  const { db, recovery, user, tx, start, attempt } = setup();
  const id = start().intent.id;
  tx(() => recovery.abandon(user, id, NOW + 1));
  db.prepare('UPDATE recovery_slots SET version = ?').run(Number.MAX_SAFE_INTEGER);
  const epoch = recovery.current(user, NOW + 1).epoch;
  assert.throws(() => tx(() => recovery.prepareIntent(user, attempt(), NOW + 2)), {
    code: 'INVALID_RECOVERY_DATA',
  });
  assert.throws(() => tx(() => domain.restoreRecoveryDatabase(db, NOW + 2)), {
    code: 'INVALID_RECOVERY_DATA',
  });
  assert.equal(recovery.current(user, NOW + 2).epoch, epoch);
  assert.equal(db.prepare('SELECT count(*) n FROM planting_intents').get().n, 1);
  db.close();
});
test('backup rejects a forged quarantine in the active epoch and orphan empty slots', () => {
  for (const mutate of [
    (db) =>
      db.exec(
        "UPDATE planting_intents SET phase = 'quarantined', version = 2; UPDATE recovery_slots SET version = 2",
      ),
    (db) =>
      db.exec(
        "INSERT INTO recovery_slots VALUES ('other','development',1,NULL,1800000000000,1800000000000)",
      ),
  ]) {
    const { db, start } = setup();
    start();
    mutate(db);
    assert.throws(() => domain.validateRecoveryDatabase(db, NOW), {
      code: 'INVALID_RECOVERY_DATA',
    });
    db.close();
  }
});
test('reserved raw operations never poison intent ledger; historical keys replay before guard', () => {
  const { db, recovery, planting, user, tx, start } = setup();
  const old = tx(() => planting.command(user, 'customer', 'operation-old', command, NOW));
  const intent = start().intent;
  assert.throws(
    () => tx(() => planting.command(user, 'customer', intent.operationKey, command, NOW + 1)),
    { code: 'RESERVED_OPERATION_KEY' },
  );
  assert.equal(
    db.prepare('SELECT 1 FROM planting_commands WHERE key = ?').get(intent.operationKey),
    undefined,
  );
  assert.deepEqual(
    tx(() => planting.command(user, 'customer', 'operation-old', command, NOW + 1)),
    old,
  );
  const refused = tx(() =>
    planting.command(user, 'customer', 'operation-blocked', command, NOW + 1),
  );
  assert.equal(refused.code, 'INTENT_PENDING');
  const settled = tx(() => recovery.execute(user, intent.id, NOW + 2));
  assert.equal(settled.intent.receipt.code, 'NOT_FOUND');
  tx(() => recovery.acknowledge(user, intent.id, NOW + 3));
  assert.deepEqual(
    tx(() => planting.command(user, 'customer', 'operation-blocked', command, NOW + 4)),
    refused,
  );
  db.close();
});
test('fresh service instance discovers the exact committed receipt after response loss', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-recovery-domain-'));
  const databasePath = path.join(directory, 'recovery.sqlite');
  try {
    const first = setup(databasePath);
    const attempt = first.attempt();
    const id = first.start(attempt).intent.id;
    const result = first.tx(() => first.recovery.execute(first.user, id, NOW + 1));
    first.db.close();
    const second = setup(databasePath);
    const recovered = second.recovery.current(second.user, NOW + 2);
    assert.equal(recovered.intent.id, id);
    assert.deepEqual(recovered.intent.receipt, result.intent.receipt);
    assert.deepEqual(
      second.tx(() => second.recovery.prepareIntent(second.user, attempt, NOW + 2)).intent,
      result.intent,
    );
    assert.equal(second.db.prepare('SELECT count(*) n FROM planting_commands').get().n, 1);
    second.db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('settled original applied receipt remains distinct from the later current order state', () => {
  const system = setup();
  const { db, recovery, planting, user, tx, start } = system;
  provisionPlanned(system);
  const id = start().intent.id;
  const applied = tx(() => recovery.execute(user, id, NOW + 1));
  assert.equal(applied.intent.receipt.code, 'OK');
  assert.equal(applied.intent.receipt.action, 'request');
  const orderId = applied.intent.receipt.orderId;
  tx(() => recovery.acknowledge(user, id, NOW + 2));
  const cancelled = tx(() =>
    planting.command(
      user,
      'customer',
      'operation-cancel',
      { action: 'cancel', orderId, expectedOrderVersion: 1 },
      NOW + 3,
    ),
  );
  assert.equal(cancelled.code, 'OK');
  assert.equal(planting.detail(user, 'customer', orderId, NOW + 3).order.status, 'cancelled');
  assert.deepEqual(
    tx(() => recovery.execute(user, id, NOW + 4)).intent.receipt,
    applied.intent.receipt,
  );
  assert.equal(domain.validateRecoveryDatabase(db, NOW + 4), true);
  db.close();
});
test(
  'two SQLite connections competing on the same CAS persist one canonical intent',
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'farm-recovery-race-'));
    const databasePath = path.join(directory, 'recovery.sqlite');
    const first = setup(databasePath);
    const attempt = first.attempt();
    first.db.close();
    const gate = new SharedArrayBuffer(4);
    const ready = [];
    const workers = [];
    const work = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const { createRecovery } = await import(workerData.module);
      const db = new DatabaseSync(workerData.databasePath);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      const recovery = createRecovery({ prepare: q => db.prepare(q), environment: 'development', executePlanting() { throw new Error('unexpected execution'); } });
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = recovery.prepareIntent({ id: 'customer', environment: 'development', identity_provider: 'development' }, workerData.attempt, workerData.now);
        db.exec('COMMIT');
        parentPort.postMessage({ code: result.code, id: result.intent?.id });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally { db.close(); }
    })().catch(error => { parentPort.postMessage({ error: error.code || error.message }); });
  `;
    try {
      const jobs = [1, 2].map((recordVersion) => {
        let markReady;
        ready.push(
          new Promise((resolve) => {
            markReady = resolve;
          }),
        );
        const worker = new Worker(work, {
          eval: true,
          workerData: {
            module: new URL('../services/api/src/recovery.mjs', import.meta.url).href,
            databasePath,
            gate,
            attempt: { ...attempt, command: { ...command, expectedRecordVersion: recordVersion } },
            now: NOW,
          },
        });
        workers.push(worker);
        return new Promise((resolve, reject) => {
          worker.on('error', reject);
          worker.on('message', (message) => {
            if (message.ready) markReady();
            else if (message.error) reject(new Error(message.error));
            else resolve(message);
          });
        });
      });
      await Promise.all(ready);
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, 2);
      const results = await Promise.all(jobs);
      assert.deepEqual(results.map((x) => x.code).sort(), ['OK', 'PREPARE_CONFLICT']);
      assert.equal(results[0].id, results[1].id);
      const check = setup(databasePath);
      assert.equal(check.db.prepare('SELECT count(*) n FROM planting_intents').get().n, 1);
      assert.equal(domain.validateRecoveryDatabase(check.db, NOW), true);
      check.db.close();
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
