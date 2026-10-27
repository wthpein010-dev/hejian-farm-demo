import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createBackup, verifyBackup, restoreBackup, inspectApplicationDatabase } from '../tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-eggs-backup-'));
  mkdirSync(path.join(directory, 'source'), { mode: 0o700 });
  const file = path.join(directory, 'source', 'farm.sqlite');
  const store = new FarmStore(normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW }));
  const auth = store.createIdentity('development', 'synthetic-eggs-backup-owner', store.serverNow());
  const staff = store.createIdentity('development', 'synthetic-eggs-backup-staff', store.serverNow());
  const output = name => path.join(directory, name);
  t.after(() => { store.close(); assert.equal(path.dirname(directory), tmpdir()); assert.ok(path.basename(directory).startsWith('farm-eggs-backup-')); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, store, auth, staff, output };
}
function rehash(directory) {
  const file = path.join(directory, 'farm.sqlite'), manifestFile = path.join(directory, 'manifest.json');
  const bytes = readFileSync(file), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  Object.assign(manifest, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  writeFileSync(manifestFile, JSON.stringify(manifest));
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
function seedRecovery(f) {
  const preparedOwner = f.store.createIdentity('development', 'synthetic-eggs-prepared-owner', NOW);
  const owners = [f.auth, preparedOwner];
  f.store.importFarmBatch({ formatVersion: 1, batchId: 'synthetic-eggs-backup-initial', source: 'synthetic-backup',
    entries: owners.map((a, i) => ({ expectedVersion: 0, record: { id: 'animal-eggs-backup-' + i, ownerId: a.profile.id,
      kind: 'animal', name: '合成鸡舍', unitLabel: '鸡舍' + i, cycleRef: 'synthetic-cycle', status: 'growing',
      startedAt: NOW - 1000, expectedHarvestAt: null, observedAt: NOW - 1, measurements: { headCount: 10 } } })) }, NOW);
  const prepare = (auth, command, audience = 'customer') => {
    const v = f.store.recoveryCurrent(auth.profile.id, NOW);
    return f.store.recoveryPrepare(auth.profile.id, { expectedEpoch: v.epoch, expectedVersion: v.version, audience, command }, NOW).intent;
  };
  const batches = owners.map((a, i) => {
    const recordId = 'animal-eggs-backup-' + i;
    f.store.provisionEggs({ recordId, expectedProfileVersion: 0, recordVersion: 1, profile: 'chicken-eggs', enabled: true,
      maxDailyQuantity: 20, staff: [{ accountId: f.staff.profile.id, role: 'record' }] }, NOW);
    const intent = prepare(f.staff, { domain: 'eggs', action: 'register', recordId, expectedProfileVersion: 1, sourceRef: 'synthetic-source-backup-' + i, quantity: i + 3 }, 'staff');
    const result = f.store.recoveryExecute(f.staff.profile.id, intent.id, NOW);
    assert.equal(result.intent.receipt.code, 'OK');
    f.store.recoveryAck(f.staff.profile.id, intent.id, NOW);
    return result.intent.receipt.batchId;
  });
  const intents = owners.map((a, i) => prepare(a, { domain: 'eggs', action: 'collect', batchId: batches[i], expectedBatchVersion: 1, expectedRevision: 0 }));
  const original = f.store.recoveryExecute(f.auth.profile.id, intents[0].id, NOW).intent.receipt;
  assert.equal(original.quantity, 3); assert.equal(original.appliedRevision, 1);
  return { preparedOwner, intents, original, batches };
}

test('schema10 backup verifies and restores the exact four-table egg contract without changing finances', async t => {
  const f = fixture(t), before = f.store.bootstrap(f.auth.profile.id, NOW);
  const report = await createBackup({ databasePath: f.file, outputDirectory: f.output('backup') });
  assert.equal(report.schemaVersion, 10);
  assert.equal((await verifyBackup({ backupDirectory: f.output('backup') })).schemaVersion, 10);
  await restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('restored') });
  const file = path.join(f.output('restored'), 'farm.sqlite');
  assert.equal(inspectApplicationDatabase(file), 10);
  const restored = new FarmStore(normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW }));
  try { assert.deepEqual(restored.bootstrap(f.auth.profile.id, NOW), before); }
  finally { restored.close(); }
});

test('restore quarantines egg prepared, revokes every profile and grant, and preserves original collected receipt bytes', async t => {
  const f = fixture(t), seeded = seedRecovery(f);
  const finances = f.store.bootstrap(f.auth.profile.id, NOW);
  const epoch = f.store.recoveryCurrent(f.auth.profile.id, NOW).epoch;
  const source = new DatabaseSync(f.file, { readOnly: true });
  let commands, intents, profiles, grants;
  try { commands = rows(source, 'eggs_commands'); intents = rows(source, 'planting_intents'); profiles = rows(source, 'eggs_profiles'); grants = rows(source, 'eggs_grants'); }
  finally { source.close(); }
  await createBackup({ databasePath: f.file, outputDirectory: f.output('backup') });
  const originalBytes = readFileSync(path.join(f.output('backup'), 'farm.sqlite'));
  await restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('restored') });
  assert.deepEqual(readFileSync(path.join(f.output('backup'), 'farm.sqlite')), originalBytes);
  const file = path.join(f.output('restored'), 'farm.sqlite'), db = new DatabaseSync(file);
  try {
    assert.notEqual(db.prepare('SELECT epoch FROM recovery_epoch').get().epoch, epoch);
    assert.deepEqual(rows(db, 'eggs_commands'), commands);
    assert.deepEqual(rows(db, 'eggs_profiles').map(r => [r.enabled, r.version]), profiles.map(r => [0, r.version + 1]));
    assert.deepEqual(rows(db, 'eggs_grants').map(r => [r.active, r.version]), grants.map(r => [0, r.version + 1]));
    for (const old of intents) {
      const current = db.prepare('SELECT * FROM planting_intents WHERE id=?').get(old.id);
      if (old.phase === 'prepared') { assert.equal(current.phase, 'quarantined'); assert.equal(current.version, 2); assert.equal(current.receipt_json, null); }
      else assert.deepEqual({ ...current }, old);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  } finally { db.close(); }
  const restored = new FarmStore(normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW }));
  try {
    assert.deepEqual(restored.bootstrap(f.auth.profile.id, NOW), finances);
    assert.deepEqual(restored.recoveryExecute(f.auth.profile.id, seeded.intents[0].id, NOW).intent.receipt, seeded.original);
    for (const method of ['recoveryExecute', 'recoveryAck', 'recoveryAbandon']) assert.throws(() => restored[method](seeded.preparedOwner.profile.id, seeded.intents[1].id, NOW), { code: 'RECOVERY_QUARANTINED' });
    restored.recoveryAck(f.auth.profile.id, seeded.intents[0].id, NOW);
  } finally { restored.close(); }
  await createBackup({ databasePath: file, outputDirectory: f.output('second-backup') });
  await restoreBackup({ backupDirectory: f.output('second-backup'), outputDirectory: f.output('second-restored') });
  const secondFile = path.join(f.output('second-restored'), 'farm.sqlite');
  assert.equal(inspectApplicationDatabase(secondFile), 10);
  const second = new DatabaseSync(secondFile);
  try {
    assert.deepEqual(rows(second, 'eggs_profiles').map(r => [r.enabled, r.version]), profiles.map(r => [0, r.version + 2]));
    assert.deepEqual(rows(second, 'eggs_grants').map(r => [r.active, r.version]), grants.map(r => [0, r.version + 2]));
    assert.deepEqual(rows(second, 'eggs_commands'), commands);
    assert.equal(second.prepare('SELECT version FROM planting_intents WHERE id=?').get(seeded.intents[1].id).version, 2);
  } finally { second.close(); }
});

for (const corruption of ['missing-table', 'extra-index', 'missing-daily-index', 'wrong-partial-index', 'missing-ledger', 'receipt-byte-mismatch', 'prepared-with-ledger', 'cross-domain-ledger', 'profile-version-overflow']) {
  test(`schema10 verification rejects ${corruption} after recomputing the manifest`, async t => {
    const f = fixture(t), seeded = seedRecovery(f);
    await createBackup({ databasePath: f.file, outputDirectory: f.output('backup') });
    const db = new DatabaseSync(path.join(f.output('backup'), 'farm.sqlite'));
    try {
      db.exec('PRAGMA foreign_keys=OFF');
      if (corruption === 'missing-table') db.exec('DROP TABLE eggs_grants');
      if (corruption === 'extra-index') db.exec('CREATE INDEX eggs_unexpected ON eggs_batches(status)');
      if (corruption === 'missing-daily-index') db.exec('DROP INDEX eggs_one_daily_batch');
      if (corruption === 'wrong-partial-index') db.exec("DROP INDEX eggs_one_daily_batch; CREATE UNIQUE INDEX eggs_one_daily_batch ON eggs_batches(environment,record_id,cycle_ref,day) WHERE status='available'");
      if (corruption === 'missing-ledger') db.prepare('DELETE FROM eggs_commands WHERE key=?').run(seeded.intents[0].operationKey);
      if (corruption === 'receipt-byte-mismatch') db.prepare('UPDATE planting_intents SET receipt_json=receipt_json||? WHERE id=?').run(' ', seeded.intents[0].id);
      if (corruption === 'prepared-with-ledger') {
        const r = { ...seeded.original, ownerId: seeded.preparedOwner.profile.id, operationKey: seeded.intents[1].operationKey,
          outcome: 'refused', code: 'REVISION_CONFLICT', quantity: 0, appliedRevision: null, batchId: seeded.batches[1] };
        const p = db.prepare('SELECT fingerprint FROM planting_intents WHERE id=?').get(seeded.intents[1].id);
        db.prepare('INSERT INTO eggs_commands (environment,owner_id,key,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)').run('development', r.ownerId, r.operationKey, p.fingerprint, JSON.stringify(r), NOW);
      }
      if (corruption === 'cross-domain-ledger') {
        const r = { plantingFormat: 1, ownerId: f.auth.profile.id, environment: 'development', operationKey: seeded.intents[0].operationKey,
          action: 'request', outcome: 'refused', code: 'NOT_FOUND', orderId: null, completedAt: NOW };
        db.prepare('INSERT INTO planting_commands VALUES (?,?,?,?,?,?)').run('development', r.ownerId, r.operationKey, 'a'.repeat(64), JSON.stringify(r), NOW);
      }
      if (corruption === 'profile-version-overflow') db.exec('UPDATE eggs_profiles SET version=9007199254740992');
    } finally { db.close(); }
    rehash(f.output('backup'));
    await assert.rejects(verifyBackup({ backupDirectory: f.output('backup') }));
    await assert.rejects(restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('rejected') }));
  });
}

test('schema9 cannot smuggle a strict egg prepared command into a later upgrade', async t => {
  const f = fixture(t), seeded = seedRecovery(f);
  f.store.close();
  const db = new DatabaseSync(f.file);
  try {
    db.exec("PRAGMA foreign_keys=OFF; DELETE FROM planting_intents WHERE phase != 'prepared'");
    db.prepare('DELETE FROM recovery_slots WHERE owner_id != ?').run(seeded.preparedOwner.profile.id);
    db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; PRAGMA user_version=9');
  } finally { db.close(); }
  assert.throws(() => inspectApplicationDatabase(f.file), { code: 'INVALID_APPLICATION_DATA' });
  await assert.rejects(createBackup({ databasePath: f.file, outputDirectory: f.output('refused') }), { code: 'INVALID_APPLICATION_DATA' });
  const original = readFileSync(f.file);
  assert.throws(() => {
    const unexpected = new FarmStore(normalizeConfig({ databasePath: f.file, mode: 'development', clock: () => NOW }));
    unexpected.close();
  }, { code: 'INVALID_RECOVERY_DATA' });
  assert.deepEqual(readFileSync(f.file), original);
});

for (const table of ['eggs_profiles', 'eggs_grants']) test(`restore rejects an exhausted ${table} version without modifying source or leaving partial files`, async t => {
  const f = fixture(t); seedRecovery(f);
  const db = new DatabaseSync(f.file);
  try { db.exec(`UPDATE ${table} SET version=9007199254740991`); } finally { db.close(); }
  await createBackup({ databasePath: f.file, outputDirectory: f.output('backup') });
  const original = readFileSync(path.join(f.output('backup'), 'farm.sqlite'));
  await assert.rejects(restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('refused') }));
  assert.deepEqual(readFileSync(path.join(f.output('backup'), 'farm.sqlite')), original);
  assert.equal(existsSync(f.output('refused')), false);
});
