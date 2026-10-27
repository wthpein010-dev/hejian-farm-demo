import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createFarmRegistry } from '../src/farm-registry.mjs';
import { PLANTING_SQL, createPlanting } from '../src/planting.mjs';
import { createBackup, verifyBackup, restoreBackup, inspectApplicationDatabase } from '../tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const config = databasePath => normalizeConfig({ databasePath, mode: 'development', clock: () => NOW });
const DROP_PLANTING = 'DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands;';
function fixture(t, seed = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-planting-backup-')); mkdirSync(path.join(directory, 'source'), { mode: 0o700 });
  const databasePath = path.join(directory, 'source', 'farm.sqlite');
  const store = new FarmStore(config(databasePath)), now = store.serverNow();
  const owner = store.createIdentity('development', 'synthetic-backup-customer', now), dispatch = store.createIdentity('development', 'synthetic-backup-dispatch', now),
    execute = store.createIdentity('development', 'synthetic-backup-execute', now);
  const original = { id: 'plot-backup-00001', ownerId: owner.profile.id, kind: 'plot', name: '合成白菜', unitLabel: '合成地块',
    cycleRef: 'synthetic-cycle', status: 'planned', startedAt: null, expectedHarvestAt: NOW + 86400000, observedAt: NOW, measurements: { moisturePercent: 35 } };
  store.importFarmBatch({ formatVersion: 1, batchId: 'planting-backup-initial', source: 'synthetic-backup', entries: [{ expectedVersion: 0, record: original }] }, now);
  const finances = store.bootstrap(owner.profile.id, now); store.close();
  // Build the schema8 fixture from the module's canonical DDL independently of
  // Store migration, so this suite specifically exercises the offline boundary.
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; ' + PLANTING_SQL + ' PRAGMA user_version=8;');
  const prepare = sql => db.prepare(sql), registry = createFarmRegistry({ prepare, environment: 'development' });
  const planting = createPlanting({ prepare, environment: 'development', farmRegistry: registry });
  const user = auth => db.prepare('SELECT * FROM users WHERE id = ?').get(auth.profile.id);
  const transaction = work => { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  let receipt;
  if (seed) {
    transaction(() => planting.provision({ recordId: original.id, expectedPlanVersion: 0, recordVersion: 1, enabled: true, notBefore: NOW,
      staff: [{ accountId: dispatch.profile.id, role: 'dispatch' }, { accountId: execute.profile.id, role: 'execute' }] }, now));
    receipt = transaction(() => planting.command(user(owner), 'customer', 'original-planting-request', { action: 'request', recordId: original.id, expectedRecordVersion: 1 }, now));
    assert.equal(receipt.outcome, 'applied');
  }
  t.after(() => { db.close(); assert.equal(path.dirname(directory), tmpdir()); assert.ok(path.basename(directory).startsWith('farm-planting-backup-')); rmSync(directory, { recursive: true, force: true }); });
  return { directory, databasePath, db, owner, dispatch, execute, finances, original, receipt, planting, user, transaction, output: name => path.join(directory, name) };
}
function rewriteManifest(directory) {
  const file = path.join(directory, 'farm.sqlite'), manifestPath = path.join(directory, 'manifest.json');
  const bytes = readFileSync(file), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  Object.assign(manifest, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); writeFileSync(manifestPath, JSON.stringify(manifest));
}

test('schema8 online backup retains orders and original receipts; restore revokes every plan/grant and keeps history and finances intact', async t => {
  const f = fixture(t), backup = f.output('backup'), restored = f.output('restored');
  // Leave a real outstanding destructive-action credential for sanitization.
  f.db.prepare('INSERT INTO deletion_confirmations VALUES (?, ?, ?, 0, ?)').run('a'.repeat(64), f.owner.profile.id, 'b'.repeat(64), NOW + 60000);
  const before = f.db.prepare('SELECT data_json FROM planting_orders').get().data_json;
  const command = f.db.prepare('SELECT result_json FROM planting_commands').get().result_json;
  const report = await createBackup({ databasePath: f.databasePath, outputDirectory: backup }); assert.equal(report.schemaVersion, 8);
  assert.equal((await verifyBackup({ backupDirectory: backup })).schemaVersion, 8);
  const source = readFileSync(path.join(backup, 'farm.sqlite'));
  await restoreBackup({ backupDirectory: backup, outputDirectory: restored });
  assert.deepEqual(readFileSync(path.join(backup, 'farm.sqlite')), source);
  const file = path.join(restored, 'farm.sqlite'); assert.equal(inspectApplicationDatabase(file), 8);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM deletion_confirmations').get().n, 0);
    assert.deepEqual({ ...db.prepare('SELECT enabled,version FROM planting_plans').get() }, { enabled: 0, version: 2 });
    assert.deepEqual(db.prepare('SELECT active,version FROM planting_grants ORDER BY role').all().map(r => ({ ...r })), [{ active: 0, version: 2 }, { active: 0, version: 2 }]);
    assert.equal(db.prepare('SELECT data_json FROM planting_orders').get().data_json, before);
    assert.equal(db.prepare('SELECT result_json FROM planting_commands').get().result_json, command);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM planting_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM farm_record_events').get().n, 1);
    const prepare = sql => db.prepare(sql), planting = createPlanting({ prepare, environment: 'development', farmRegistry: createFarmRegistry({ prepare, environment: 'development' }) });
    assert.equal(planting.status(db.prepare('SELECT * FROM users WHERE id=?').get(f.dispatch.profile.id), NOW).hasStaffAccess, false);
    assert.equal(planting.detail(db.prepare('SELECT * FROM users WHERE id=?').get(f.owner.profile.id), 'customer', f.receipt.orderId, NOW).permissions.canCancel, true);
  } finally { db.close(); }
  const reopened = new FarmStore(config(file));
  try {
    assert.deepEqual(reopened.bootstrap(f.owner.profile.id, NOW), f.finances);
    assert.equal(reopened.authenticate(f.owner.token, NOW), null);
  } finally { reopened.close(); }
});

test('restore also advances already disabled plans and revoked grants rather than reopening old authority', async t => {
  const f = fixture(t); f.db.exec('UPDATE planting_plans SET enabled=0; UPDATE planting_grants SET active=0;');
  const backup = f.output('backup'); await createBackup({ databasePath: f.databasePath, outputDirectory: backup });
  await restoreBackup({ backupDirectory: backup, outputDirectory: f.output('restored') });
  const db = new DatabaseSync(path.join(f.output('restored'), 'farm.sqlite'), { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare('SELECT enabled,version FROM planting_plans').get() }, { enabled: 0, version: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM planting_grants WHERE active=0 AND version=2').get().n, 2);
  } finally { db.close(); }
});

test('a completed workflow keeps its original five receipts and exactly one completion history across backup and restore', async t => {
  const f = fixture(t), id=f.receipt.orderId;
  const command=(auth,key,input)=>f.transaction(()=>f.planting.command(f.user(auth),'staff',key,{orderId:id,...input},NOW));
  assert.equal(command(f.dispatch,'backup-accept',{action:'accept',expectedOrderVersion:1}).code,'OK');
  const assigneeRef=f.planting.detail(f.user(f.dispatch),'staff',id,NOW).candidates[0].ref;
  assert.equal(command(f.dispatch,'backup-assign',{action:'assign',expectedOrderVersion:2,assigneeRef}).code,'OK');
  assert.equal(command(f.execute,'backup-start',{action:'start',expectedOrderVersion:3}).code,'OK');
  assert.equal(command(f.execute,'backup-complete',{action:'complete',expectedOrderVersion:4,expectedRecordVersion:1,performedAt:NOW}).code,'OK');
  const originals=f.db.prepare('SELECT result_json FROM planting_commands ORDER BY key').all().map(r=>r.result_json);
  const backup=f.output('backup'); await createBackup({databasePath:f.databasePath,outputDirectory:backup});
  await restoreBackup({backupDirectory:backup,outputDirectory:f.output('restored')});
  const db=new DatabaseSync(path.join(f.output('restored'),'farm.sqlite'),{readOnly:true});
  try {
    assert.deepEqual(db.prepare('SELECT result_json FROM planting_commands ORDER BY key').all().map(r=>r.result_json),originals);
    assert.equal(originals.length,5);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM planting_events').get().n,5);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM farm_record_events').get().n,2);
    const row=db.prepare('SELECT version,data_json FROM farm_records').get(), record=JSON.parse(row.data_json);
    assert.equal(record.status,'growing'); assert.equal(row.version,2); assert.equal(record.expectedHarvestAt,null); assert.deepEqual(record.measurements,{});
  } finally {db.close();}
});

for (const corruption of ['missing-events', 'extra-index', 'missing-active-index', 'wrong-partial-index', 'removed-check', 'cross-owner-plan', 'foreign-environment-grant', 'invalid-staff-ref', 'unsafe-command', 'foreign-command', 'missing-history', 'wrong-order-version', 'invalid-event']) {
  test(`schema8 verifier refuses ${corruption} after a recomputed backup hash`, async t => {
    const f = fixture(t), backup = f.output('backup'); await createBackup({ databasePath: f.databasePath, outputDirectory: backup });
    const db = new DatabaseSync(path.join(backup, 'farm.sqlite'));
    try {
      db.exec('PRAGMA foreign_keys=OFF');
      if (corruption === 'missing-events') db.exec('DELETE FROM planting_events');
      if (corruption === 'extra-index') db.exec('CREATE INDEX planting_surprise ON planting_orders(version)');
      if (corruption === 'missing-active-index') db.exec('DROP INDEX planting_one_active');
      if (corruption === 'wrong-partial-index') db.exec("DROP INDEX planting_one_active; CREATE UNIQUE INDEX planting_one_active ON planting_orders(environment,record_id) WHERE status != 'completed'");
      if (corruption === 'removed-check') {
        const sql=db.prepare("SELECT sql FROM sqlite_schema WHERE name='planting_plans'").get().sql;
        db.exec(sql.replace(/CREATE TABLE planting_plans/u,'CREATE TABLE planting_plans_replacement').replace('CHECK(enabled IN (0,1))',''));
        db.exec('INSERT INTO planting_plans_replacement SELECT * FROM planting_plans; DROP TABLE planting_plans; ALTER TABLE planting_plans_replacement RENAME TO planting_plans;');
      }
      if (corruption === 'cross-owner-plan') db.prepare('UPDATE planting_plans SET owner_id=?').run(f.execute.profile.id);
      if (corruption === 'foreign-environment-grant') db.exec("UPDATE planting_grants SET environment='production'");
      if (corruption === 'invalid-staff-ref') db.exec("UPDATE planting_grants SET staff_ref='private-account-name'");
      if (corruption === 'unsafe-command') db.exec(`UPDATE planting_commands SET result_json='{"private":"synthetic-body"}'`);
      if (corruption === 'foreign-command') { const c = JSON.parse(db.prepare('SELECT result_json FROM planting_commands').get().result_json); c.ownerId=f.dispatch.profile.id; db.prepare('UPDATE planting_commands SET result_json=?').run(JSON.stringify(c)); }
      if (corruption === 'missing-history') db.exec('DELETE FROM farm_record_events');
      if (corruption === 'wrong-order-version') db.exec('UPDATE planting_orders SET version=2');
      if (corruption === 'invalid-event') { const e=JSON.parse(db.prepare('SELECT data_json FROM planting_events').get().data_json); e.actorRef='private-login-identity'; db.prepare('UPDATE planting_events SET data_json=?').run(JSON.stringify(e)); }
    } finally { db.close(); }
    rewriteManifest(backup);
    await assert.rejects(verifyBackup({ backupDirectory: backup }), error => ['INVALID_APPLICATION_DATA','INVALID_APPLICATION_SCHEMA','FOREIGN_KEY_CHECK_FAILED'].includes(error.code));
    await assert.rejects(restoreBackup({ backupDirectory: backup, outputDirectory: f.output('refused') }));
  });
}

for (const schema of [2, 3, 4, 5, 6, 7]) {
  test(`legacy schema${schema} remains strictly verified and restores without adding planting tables or changing its schema`, async t => {
    const f = fixture(t, false); f.db.exec(DROP_PLANTING);
    if (schema < 7) f.db.exec('DROP TABLE forum_reports; DROP TABLE forum_content; DROP TABLE forum_usage; DROP TABLE forum_commands; DROP TABLE forum_moderation;');
    if (schema < 6) f.db.exec('DROP TABLE friends_relations; DROP TABLE friends_blocks; DROP TABLE friends_commands; DROP TABLE friends_profiles;');
    if (schema < 5) f.db.exec('DROP TABLE farm_record_events; DROP TABLE farm_records; DROP TABLE farm_imports;');
    if (schema < 3) f.db.exec('DROP TABLE deletion_confirmations; DROP TABLE deletion_receipts;');
    f.db.exec(`PRAGMA user_version=${schema}`);
    const backup = f.output('backup'); assert.equal((await createBackup({ databasePath: f.databasePath, outputDirectory: backup })).schemaVersion, schema);
    await restoreBackup({ backupDirectory: backup, outputDirectory: f.output('restored') });
    const file=path.join(f.output('restored'),'farm.sqlite'); assert.equal(inspectApplicationDatabase(file), schema);
    const db = new DatabaseSync(file, { readOnly:true });
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE 'planting_%'").get().n, 0); assert.equal(db.prepare('PRAGMA user_version').get().user_version,schema); }
    finally { db.close(); }
  });
}
