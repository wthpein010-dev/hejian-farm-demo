import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '../shared/recovery.mjs';
import { DatabaseSync } from 'node:sqlite';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createFarmRegistry, FARM_REGISTRY_SQL } from '../services/api/src/farm-registry.mjs';
import { createPlanting, PLANTING_SQL } from '../services/api/src/planting.mjs';
import { createEggs, EGGS_SQL } from '../services/api/src/eggs.mjs';
import { createRecovery, RECOVERY_SQL, validateRecoveryDatabase } from '../services/api/src/recovery.mjs';

const NOW = 1800000000000;
const OWNER = 'synthetic-owner';
const KEY = 'intent-' + 'a'.repeat(32);
const collect = { domain: 'eggs', action: 'collect', batchId: 'a'.repeat(32), expectedBatchVersion: 1, expectedRevision: 0 };
const planting = { action: 'request', recordId: 'synthetic-plot', expectedRecordVersion: 1 };
const attempt = (command, audience = 'customer') => ({ expectedEpoch: 'b'.repeat(32), expectedVersion: 0, audience, command });
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,environment TEXT,identity_provider TEXT,created_at INTEGER,updated_at INTEGER,revision INTEGER);
    CREATE TABLE deletion_confirmations(user_id TEXT); INSERT INTO users VALUES('synthetic-owner','development','development',1799999999000,1799999999000,0);`);
  db.exec(FARM_REGISTRY_SQL + PLANTING_SQL + EGGS_SQL + RECOVERY_SQL);
  const prepare = q => db.prepare(q), environment = 'development';
  const farmRegistry = createFarmRegistry({ prepare, environment });
  let recovery;
  const beforeNewCommand = (user, audience, key, command, now, intentId) => {
    assert.equal(recovery.allowCommand(user, audience, key, command, intentId), true);
    return null;
  };
  const planting = createPlanting({ prepare, environment, farmRegistry, beforeNewCommand });
  const eggs = createEggs({ prepare, environment, farmRegistry, beforeNewCommand, harvest: () => assert.fail('missing batch must never issue assets') });
  recovery = createRecovery({ prepare, environment,
    executePlanting: (...args) => planting.command(...args), executeEggs: (...args) => eggs.command(...args) });
  const user = db.prepare('SELECT * FROM users').get();
  const tx = work => { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const start = command => { const v = recovery.current(user, NOW); return tx(() => recovery.prepareIntent(user, { expectedEpoch: v.epoch, expectedVersion: v.version, audience: 'customer', command }, NOW)); };
  return { db, recovery, user, tx, start };
}

test('recovery accepts explicit strict egg commands while preserving legacy planting wire', () => {
  assert.equal(wire.isRecoveryPrepare(attempt(collect)), true);
  assert.equal(wire.isRecoveryPrepare(attempt(planting)), true);
  for (const command of [
    { ...collect, domain: undefined }, { ...collect, domain: 'planting' },
    Object.fromEntries(Object.entries(collect).filter(([key]) => key !== 'domain')),
    { ...planting, domain: 'eggs' }, { ...planting, domain: 'planting' },
    { ...collect, body: 'unapproved text' }, { ...collect, expectedRevision: -1 },
  ]) assert.equal(wire.isRecoveryPrepare(attempt(command)), false);
  assert.equal(wire.isRecoveryPrepare(attempt(collect, 'staff')), false);
  let reads = 0;
  const getter = { ...collect };
  Object.defineProperty(getter, 'domain', { enumerable: true, get() { reads++; return 'eggs'; } });
  assert.equal(wire.isRecoveryPrepare(attempt(getter)), false);
  assert.equal(reads, 0);
});

test('recovery receipt dispatcher binds the original domain and action', () => {
  const egg = { eggFormat: 1, ownerId: OWNER, environment: 'development', operationKey: KEY,
    action: 'collect', outcome: 'applied', code: 'OK', batchId: collect.batchId, completedAt: NOW, quantity: 3, appliedRevision: 1 };
  const plant = { plantingFormat: 1, ownerId: OWNER, environment: 'development', operationKey: KEY,
    action: 'request', outcome: 'refused', code: 'NOT_FOUND', orderId: null, completedAt: NOW };
  assert.equal(typeof wire.isRecoveryReceipt, 'function');
  assert.equal(wire.isRecoveryReceipt(egg, OWNER, 'development', KEY, collect), true);
  assert.equal(wire.isRecoveryReceipt(plant, OWNER, 'development', KEY, planting), true);
  assert.equal(wire.isRecoveryReceipt(egg, OWNER, 'development', KEY, planting), false);
  assert.equal(wire.isRecoveryReceipt(plant, OWNER, 'development', KEY, collect), false);
  assert.equal(wire.isRecoveryReceipt(egg, OWNER, 'development', KEY, { ...collect, action: 'withdraw' }), false);
});

test('egg recovery settles against its own ledger while planting keeps its original fingerprint and receipt bytes', t => {
  const { db, recovery, user, tx, start } = fixture(t);
  const egg = start(collect).intent;
  const settled = tx(() => recovery.execute(user, egg.id, NOW));
  assert.equal(settled.intent.receipt.eggFormat, 1); assert.equal(settled.intent.receipt.code, 'NOT_FOUND');
  const original = db.prepare('SELECT result_json FROM eggs_commands WHERE key=?').get(egg.operationKey).result_json;
  assert.equal(db.prepare('SELECT receipt_json FROM planting_intents WHERE id=?').get(egg.id).receipt_json, original);
  assert.equal(db.prepare('SELECT count(*) n FROM planting_commands').get().n, 0);
  tx(() => recovery.acknowledge(user, egg.id, NOW));
  const plant = start(planting).intent;
  tx(() => recovery.execute(user, plant.id, NOW));
  const ledger = db.prepare('SELECT fingerprint,result_json FROM planting_commands WHERE key=?').get(plant.operationKey);
  const legacyFingerprint = createHash('sha256').update('{"audience":"customer","command":{"action":"request","expectedRecordVersion":1,"recordId":"synthetic-plot"}}').digest('hex');
  assert.equal(ledger.fingerprint, legacyFingerprint);
  assert.equal(db.prepare('SELECT receipt_json FROM planting_intents WHERE id=?').get(plant.id).receipt_json, ledger.result_json);
  assert.equal(db.prepare('SELECT result_json FROM eggs_commands WHERE key=?').get(egg.operationKey).result_json, original);
  assert.equal(validateRecoveryDatabase(db, NOW, { allowEggs: true }), true);
  assert.throws(() => validateRecoveryDatabase(db, NOW), { code: 'INVALID_RECOVERY_DATA' });
});

test('new planting and egg prepares avoid operation keys already owned by either ledger', t => {
  const { db, recovery, user, tx, start } = fixture(t);
  const oldId = 'c'.repeat(32), oldKey = 'intent-' + oldId;
  const oldReceipt = { eggFormat: 1, ownerId: user.id, environment: 'development', operationKey: oldKey,
    action: 'collect', outcome: 'refused', code: 'NOT_FOUND', batchId: null, completedAt: NOW - 1, quantity: 0, appliedRevision: null };
  db.prepare('INSERT INTO eggs_commands (environment,owner_id,key,fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?)').run('development', user.id, oldKey, 'd'.repeat(64), JSON.stringify(oldReceipt), NOW - 1);
  for (const command of [planting, collect]) {
    let draws = 0;
    t.mock.method(crypto, 'randomBytes', () => Buffer.from((draws++ === 0 ? 'c' : command.domain ? 'e' : 'f').repeat(32), 'hex'));
    syncBuiltinESMExports();
    try {
      const result = start(command);
      assert.equal(draws, 2);
      assert.notEqual(result.intent.operationKey, oldKey);
      tx(() => recovery.abandon(user, result.intent.id, NOW));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
  assert.equal(db.prepare('SELECT result_json FROM eggs_commands WHERE key=?').get(oldKey).result_json, JSON.stringify(oldReceipt));
});

test('failed egg settlement rolls back the domain ledger and leaves prepared available to retry', t => {
  const { db, recovery, user, tx, start } = fixture(t), egg = start(collect).intent;
  db.exec("CREATE TRIGGER fail_egg_settlement BEFORE UPDATE OF phase ON planting_intents WHEN NEW.phase='settled' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => tx(() => recovery.execute(user, egg.id, NOW)), { code: 'INVALID_RECOVERY_DATA' });
  assert.equal(db.prepare('SELECT count(*) n FROM eggs_commands').get().n, 0);
  assert.equal(recovery.current(user, NOW).intent.phase, 'prepared');
  db.exec('DROP TRIGGER fail_egg_settlement');
  assert.equal(tx(() => recovery.execute(user, egg.id, NOW)).intent.phase, 'settled');
});

test('an inherited domain never reroutes the original domainless planting protocol', t => {
  const { recovery, user, tx, start } = fixture(t);
  Object.defineProperty(Object.prototype, 'domain', { value: 'eggs', configurable: true });
  try {
    const intent = start(planting).intent;
    assert.equal(tx(() => recovery.execute(user, intent.id, NOW)).intent.receipt.plantingFormat, 1);
  } finally { delete Object.prototype.domain; }
});

test('an optional missing egg executor still protects keys in an existing egg ledger', t => {
  const { db, user, tx } = fixture(t);
  const oldId = 'c'.repeat(32);
  const oldReceipt = { eggFormat: 1, ownerId: user.id, environment: 'development', operationKey: 'intent-' + oldId,
    action: 'collect', outcome: 'refused', code: 'NOT_FOUND', batchId: null, completedAt: NOW - 1, quantity: 0, appliedRevision: null };
  db.prepare('INSERT INTO eggs_commands (environment,owner_id,key,fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?)').run('development', user.id, 'intent-' + oldId, 'd'.repeat(64), JSON.stringify(oldReceipt), NOW - 1);
  const recovery = createRecovery({ prepare: q => db.prepare(q), environment: 'development', executePlanting() { assert.fail('prepare does not execute'); } });
  const v = recovery.current(user, NOW);
  let draws = 0;
  t.mock.method(crypto, 'randomBytes', () => Buffer.from((draws++ === 0 ? 'c' : 'e').repeat(32), 'hex'));
  syncBuiltinESMExports();
  try {
    const result = tx(() => recovery.prepareIntent(user, { expectedEpoch: v.epoch, expectedVersion: v.version, audience: 'customer', command: planting }, NOW));
    assert.equal(result.intent.id, 'e'.repeat(32));
    assert.equal(draws, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
