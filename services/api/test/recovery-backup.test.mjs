import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createFarmRegistry } from '../src/farm-registry.mjs';
import { createPlanting, validatePlantingDatabase } from '../src/planting.mjs';
import { RECOVERY_SQL, createRecovery } from '../src/recovery.mjs';
import { createBackup, verifyBackup, restoreBackup, inspectApplicationDatabase } from '../tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const DROP_RECOVERY = 'DROP TABLE recovery_slots; DROP TABLE planting_intents; DROP TABLE recovery_epoch;';
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-recovery-backup-'));
  mkdirSync(path.join(directory, 'source'), { mode: 0o700 });
  const file = path.join(directory, 'source', 'farm.sqlite');
  const store = new FarmStore(normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW }));
  const auth = ['prepared', 'settled', 'closed', 'abandoned'].map(name => store.createIdentity('development', `synthetic-recovery-${name}`, store.serverNow()));
  const finances = auth.map(a => store.bootstrap(a.profile.id, NOW)); store.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; ' + RECOVERY_SQL + ' PRAGMA user_version=9;');
  const prepare = sql => db.prepare(sql), environment = 'development';
  const planting = createPlanting({ prepare, environment, farmRegistry: createFarmRegistry({ prepare, environment }) });
  const recovery = createRecovery({ prepare, environment, executePlanting: (user, audience, key, input, now, intentId) => planting.command(user, audience, key, input, now, { intentId }) });
  const users = auth.map(a => db.prepare('SELECT * FROM users WHERE id=?').get(a.profile.id));
  const tx = work => { db.exec('BEGIN IMMEDIATE'); try { const out = work(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const attempts = users.map(user => ({ expectedEpoch: recovery.current(user, NOW).epoch, expectedVersion: 0, audience: 'customer', command: { action: 'request', recordId: 'synthetic-missing-plot', expectedRecordVersion: 1 } }));
  const intents = users.map((user, i) => tx(() => recovery.prepareIntent(user, attempts[i], NOW)).intent);
  for (const i of [1, 2]) tx(() => recovery.execute(users[i], intents[i].id, NOW));
  tx(() => recovery.acknowledge(users[2], intents[2].id, NOW));
  tx(() => recovery.abandon(users[3], intents[3].id, NOW));
  db.prepare('INSERT INTO deletion_confirmations VALUES (?, ?, ?, 0, ?)').run('a'.repeat(64), users[0].id, 'b'.repeat(64), NOW + 60000);
  t.after(() => { db.close(); assert.equal(path.dirname(directory), tmpdir()); assert.ok(path.basename(directory).startsWith('farm-recovery-backup-')); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, db, auth, users, finances, attempts, intents, recovery, output: name => path.join(directory, name) };
}
function rehash(directory) {
  const bytes = readFileSync(path.join(directory, 'farm.sqlite')), file = path.join(directory, 'manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(manifest, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); writeFileSync(file, JSON.stringify(manifest));
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));

test('schema9 restore quarantines prepared without execution, advances every slot and preserves exact settled receipts and closed tombstones', async t => {
  const f = fixture(t), backup = f.output('backup'), restored = f.output('restored');
  const epoch = f.recovery.current(f.users[0], NOW).epoch, slots = rows(f.db, 'recovery_slots'), intents = rows(f.db, 'planting_intents'), commands = rows(f.db, 'planting_commands');
  assert.equal((await createBackup({ databasePath: f.file, outputDirectory: backup })).schemaVersion, 9);
  assert.equal((await verifyBackup({ backupDirectory: backup })).schemaVersion, 9);
  const original = readFileSync(path.join(backup, 'farm.sqlite'));
  await restoreBackup({ backupDirectory: backup, outputDirectory: restored });
  assert.deepEqual(readFileSync(path.join(backup, 'farm.sqlite')), original);
  const file = path.join(restored, 'farm.sqlite'); assert.equal(inspectApplicationDatabase(file), 9);
  const db = new DatabaseSync(file);
  let restoredEpoch;
  try {
    const nextEpoch = db.prepare('SELECT epoch FROM recovery_epoch').get().epoch;
    restoredEpoch = nextEpoch;
    assert.match(nextEpoch, /^[a-f0-9]{32}$/); assert.notEqual(nextEpoch, epoch);
    assert.deepEqual(rows(db, 'recovery_slots').map(r => r.version), slots.map(r => r.version + 1));
    assert.deepEqual(rows(db, 'planting_commands'), commands);
    for (const old of intents) {
      const current = db.prepare('SELECT * FROM planting_intents WHERE id=?').get(old.id);
      if (old.phase === 'prepared') { assert.equal(current.phase, 'quarantined'); assert.equal(current.version, 2); assert.equal(current.receipt_json, null); assert.equal(current.closed_at, null); }
      else assert.deepEqual({ ...current }, old);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM deletion_confirmations').get().n, 0);
    const recovery = createRecovery({ prepare: sql => db.prepare(sql), environment: 'development', executePlanting: () => assert.fail('restored prepared cannot execute') });
    for (const method of ['execute', 'acknowledge', 'abandon']) assert.throws(() => recovery[method](f.users[0], f.intents[0].id, NOW), { code: 'RECOVERY_QUARANTINED' });
    assert.equal(recovery.prepareIntent(f.users[0], { ...f.attempts[0], expectedVersion: 999 }, NOW).code, 'EPOCH_CHANGED');
    assert.equal(recovery.prepareIntent(f.users[0], f.attempts[0], NOW).intent.phase, 'quarantined', 'original accepted prepare stays its original quarantined object');
  } finally { db.close(); }
  const reopened = new FarmStore(normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW }));
  try { f.auth.forEach((a, i) => assert.deepEqual(reopened.bootstrap(a.profile.id, NOW), f.finances[i])); } finally { reopened.close(); }
  const secondBackup = f.output('second-backup'); await createBackup({ databasePath: file, outputDirectory: secondBackup });
  await restoreBackup({ backupDirectory: secondBackup, outputDirectory: f.output('second-restore') });
  const again = new DatabaseSync(path.join(f.output('second-restore'), 'farm.sqlite'));
  try {
    assert.notEqual(again.prepare('SELECT epoch FROM recovery_epoch').get().epoch, epoch);
    assert.notEqual(again.prepare('SELECT epoch FROM recovery_epoch').get().epoch, restoredEpoch);
    assert.deepEqual(rows(again, 'recovery_slots').map(r => r.version), slots.map(r => r.version + 2));
    assert.equal(again.prepare("SELECT version FROM planting_intents WHERE phase='quarantined'").get().version, 2);
    assert.deepEqual(rows(again, 'planting_commands'), commands);
  } finally { again.close(); }
});

for (const corruption of ['missing-table', 'extra-index', 'removed-unique-index', 'wrong-partial-index', 'removed-check', 'cross-owner-slot', 'missing-epoch', 'prepared-foreign-epoch', 'unsafe-version', 'changed-fingerprint', 'noncanonical-command', 'missing-original-ledger', 'receipt-byte-mismatch', 'prepared-with-ledger']) {
  test(`schema9 verification rejects ${corruption} after a recomputed manifest`, async t => {
    const f = fixture(t), backup = f.output('backup'); await createBackup({ databasePath: f.file, outputDirectory: backup });
    const db = new DatabaseSync(path.join(backup, 'farm.sqlite'));
    try {
      db.exec('PRAGMA foreign_keys=OFF');
      if (corruption === 'missing-table') db.exec('DROP TABLE recovery_slots');
      if (corruption === 'extra-index') db.exec('CREATE INDEX recovery_surprise ON planting_intents(phase)');
      if (corruption === 'removed-unique-index') db.exec('DROP INDEX recovery_prepare_once');
      if (corruption === 'wrong-partial-index') db.exec("DROP INDEX recovery_one_open; CREATE UNIQUE INDEX recovery_one_open ON planting_intents(owner_id,environment) WHERE phase='prepared'");
      if (corruption === 'removed-check') {
        const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='recovery_epoch'").get().sql;
        db.exec(sql.replace(/CREATE TABLE(?: IF NOT EXISTS)? recovery_epoch/u, 'CREATE TABLE epoch_replacement').replace('CHECK(singleton = 1)', ''));
        db.exec('INSERT INTO epoch_replacement SELECT * FROM recovery_epoch; DROP TABLE recovery_epoch; ALTER TABLE epoch_replacement RENAME TO recovery_epoch');
      }
      if (corruption === 'cross-owner-slot') db.prepare('UPDATE recovery_slots SET open_id=? WHERE owner_id=?').run(f.intents[1].id, f.users[0].id);
      if (corruption === 'missing-epoch') db.exec('DELETE FROM recovery_epoch');
      if (corruption === 'prepared-foreign-epoch') db.prepare("UPDATE planting_intents SET prepare_epoch=? WHERE phase='prepared'").run('f'.repeat(32));
      if (corruption === 'unsafe-version') db.exec('UPDATE recovery_slots SET version=9007199254740992');
      if (corruption === 'changed-fingerprint') db.prepare("UPDATE planting_intents SET fingerprint=? WHERE phase='prepared'").run('f'.repeat(64));
      if (corruption === 'noncanonical-command') db.exec("UPDATE planting_intents SET command_json=' '||command_json WHERE phase='prepared'");
      if (corruption === 'missing-original-ledger') db.prepare('DELETE FROM planting_commands WHERE key=?').run(f.intents[1].operationKey);
      if (corruption === 'receipt-byte-mismatch') db.prepare('UPDATE planting_intents SET receipt_json=receipt_json||? WHERE id=?').run(' ', f.intents[1].id);
      if (corruption === 'prepared-with-ledger') {
        const old = db.prepare('SELECT * FROM planting_commands WHERE key=?').get(f.intents[1].operationKey), receipt = JSON.parse(old.result_json);
        receipt.ownerId = f.users[0].id; receipt.operationKey = f.intents[0].operationKey;
        db.prepare('INSERT INTO planting_commands VALUES (?,?,?,?,?,?)').run('development', f.users[0].id, f.intents[0].operationKey, old.fingerprint, JSON.stringify(receipt), old.created_at);
        assert.doesNotThrow(() => validatePlantingDatabase(db, NOW), 'a valid original-domain ledger must still conflict with a prepared intent');
      }
    } finally { db.close(); }
    rehash(backup);
    await assert.rejects(verifyBackup({ backupDirectory: backup }));
    await assert.rejects(restoreBackup({ backupDirectory: backup, outputDirectory: f.output('refused') }));
  });
}

test('restore refuses exhausted slot versions without modifying a verified source or leaving a partial restored database', async t => {
  const f = fixture(t); f.db.prepare('UPDATE recovery_slots SET version=9007199254740991 WHERE owner_id=?').run(f.users[2].id);
  const backup = f.output('backup'), restored = f.output('refused');
  await createBackup({ databasePath: f.file, outputDirectory: backup });
  const original = readFileSync(path.join(backup, 'farm.sqlite'));
  await assert.rejects(restoreBackup({ backupDirectory: backup, outputDirectory: restored }));
  assert.deepEqual(readFileSync(path.join(backup, 'farm.sqlite')), original);
  assert.equal(existsSync(restored), false);
});

for (const schema of [2, 3, 4, 5, 6, 7, 8]) {
  test(`legacy schema${schema} restore retains its exact schema and no recovery state; later schemas cannot be smuggled into its manifest`, async t => {
    const f = fixture(t); f.db.exec('PRAGMA foreign_keys=OFF; ' + DROP_RECOVERY);
    if (schema < 8) f.db.exec('DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands;');
    if (schema < 7) f.db.exec('DROP TABLE forum_reports; DROP TABLE forum_content; DROP TABLE forum_usage; DROP TABLE forum_commands; DROP TABLE forum_moderation;');
    if (schema < 6) f.db.exec('DROP TABLE friends_relations; DROP TABLE friends_blocks; DROP TABLE friends_commands; DROP TABLE friends_profiles;');
    if (schema < 5) f.db.exec('DROP TABLE farm_record_events; DROP TABLE farm_records; DROP TABLE farm_imports;');
    if (schema < 3) f.db.exec('DROP TABLE deletion_confirmations; DROP TABLE deletion_receipts;');
    f.db.exec(`PRAGMA user_version=${schema}`);
    const backup = f.output('backup'); assert.equal((await createBackup({ databasePath: f.file, outputDirectory: backup })).schemaVersion, schema);
    await restoreBackup({ backupDirectory: backup, outputDirectory: f.output('restored') });
    const file = path.join(f.output('restored'), 'farm.sqlite'); assert.equal(inspectApplicationDatabase(file), schema);
    const db = new DatabaseSync(file); try { assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE 'recovery_%' OR name='planting_intents'").get().n, 0); } finally { db.close(); }
    const edited = new DatabaseSync(path.join(backup, 'farm.sqlite')); try { edited.exec('CREATE TABLE recovery_epoch(singleton INTEGER PRIMARY KEY,epoch TEXT,created_at INTEGER)'); } finally { edited.close(); }
    rehash(backup); await assert.rejects(verifyBackup({ backupDirectory: backup }), { code: 'INVALID_APPLICATION_SCHEMA' });
  });
}
