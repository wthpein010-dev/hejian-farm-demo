import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createBackup, verifyBackup } from '../tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const RECORD_ID = 'plot-boundary-001';
const BATCH_ID = 'batch-boundary-001';
const batch = (ownerId, batchId = BATCH_ID) => ({ formatVersion: 1, batchId, source: 'synthetic-boundary',
  entries: [{ expectedVersion: 0, record: { id: RECORD_ID, ownerId, kind: 'plot', name: '合成白菜',
    unitLabel: '合成位置', cycleRef: 'synthetic-cycle-1', status: 'growing', startedAt: NOW - 86400000,
    expectedHarvestAt: null, observedAt: NOW - 100, measurements: { moisturePercent: 31 } } }] });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-registry-boundaries-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores.toReversed()) store.close();
    const cleanupPath = path.resolve(directory);
    assert.equal(path.dirname(cleanupPath), path.resolve(tmpdir()));
    assert.ok(path.basename(cleanupPath).startsWith('farm-registry-boundaries-'));
    await rm(cleanupPath, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'source'));
  const databasePath = path.join(directory, 'source', 'farm.sqlite');
  const open = environment => {
    const store = new FarmStore(normalizeConfig({ databasePath, mode: environment, clock: () => NOW }));
    stores.push(store);
    const auth = store.createIdentity(environment === 'development' ? 'development' : 'weixin',
      `synthetic-${environment}-owner`, store.serverNow());
    return { store, auth, input: batch(auth.profile.id) };
  };
  const database = work => {
    const db = new DatabaseSync(databasePath);
    try { return work(db); } finally { db.close(); }
  };
  return { directory, databasePath, open, database, output: name => path.join(directory, name) };
}

test('the same record and batch IDs stay isolated across development and production in one database', async t => {
  const f = await fixture(t), development = f.open('development'), production = f.open('production');
  const developmentBefore = development.store.bootstrap(development.auth.profile.id, NOW);
  const productionBefore = production.store.bootstrap(production.auth.profile.id, NOW);
  for (const account of [development, production]) {
    assert.deepEqual(account.store.importFarmBatch(account.input, NOW), {
      ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: false,
    });
  }
  for (const [environment, account] of [['development', development], ['production', production]]) {
    const page = account.store.farmPage(account.auth.profile.id, 'plots', null, NOW);
    const detail = account.store.farmDetail(account.auth.profile.id, RECORD_ID, 0, NOW);
    assert.deepEqual(page.items.map(record => [record.id, record.ownerId, record.environment]),
      [[RECORD_ID, account.auth.profile.id, environment]]);
    assert.deepEqual(detail.events.map(event => [event.record.ownerId, event.record.environment]),
      [[account.auth.profile.id, environment]]);
    assert.equal(account.store.importFarmBatch(account.input, NOW).replayed, true);
  }
  assert.throws(() => development.store.farmPage(production.auth.profile.id, 'plots', null, NOW));
  assert.throws(() => production.store.farmDetail(development.auth.profile.id, RECORD_ID, 0, NOW));
  assert.throws(() => development.store.importFarmBatch(batch(production.auth.profile.id, 'batch-cross-env-001'), NOW),
    { code: 'OWNER_UNAVAILABLE' });
  assert.deepEqual(f.database(db => db.prepare('SELECT environment, batch_id FROM farm_imports ORDER BY environment').all())
    .map(row => [row.environment, row.batch_id]), [['development', BATCH_ID], ['production', BATCH_ID]]);
  assert.deepEqual(development.store.bootstrap(development.auth.profile.id, NOW), developmentBefore);
  assert.deepEqual(production.store.bootstrap(production.auth.profile.id, NOW), productionBefore);
});

test('deleting one environment and replaying its old batch never recreates records or changes the other environment', async t => {
  const f = await fixture(t), development = f.open('development'), production = f.open('production');
  development.store.importFarmBatch(development.input, NOW);
  production.store.importFarmBatch(production.input, NOW);
  const productionPage = production.store.farmPage(production.auth.profile.id, 'plots', null, NOW);
  const productionDetail = production.store.farmDetail(production.auth.profile.id, RECORD_ID, 0, NOW);
  const productionSnapshot = production.store.bootstrap(production.auth.profile.id, NOW);
  const deletion = development.store.prepareDeletion(development.auth.profile.id, development.auth.token, 0, NOW);
  assert.equal(development.store.confirmDeletion(deletion.data.confirmationToken, NOW).status, 200);
  assert.deepEqual(development.store.importFarmBatch(development.input, NOW), {
    ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: true,
  });
  assert.equal(development.store.authenticate(development.auth.token, NOW), null);
  assert.throws(() => development.store.importFarmBatch(batch(development.auth.profile.id, 'batch-after-delete-001'), NOW),
    { code: 'OWNER_UNAVAILABLE' });
  assert.deepEqual(f.database(db => db.prepare('SELECT environment, COUNT(*) AS n FROM farm_records GROUP BY environment').all())
    .map(row => [row.environment, row.n]), [['production', 1]]);
  assert.deepEqual(f.database(db => db.prepare('SELECT environment, COUNT(*) AS n FROM farm_record_events GROUP BY environment').all())
    .map(row => [row.environment, row.n]), [['production', 1]]);
  assert.deepEqual(f.database(db => db.prepare('SELECT environment, COUNT(*) AS n FROM farm_imports GROUP BY environment ORDER BY environment').all())
    .map(row => [row.environment, row.n]), [['development', 1], ['production', 1]]);
  assert.equal(production.store.importFarmBatch(production.input, NOW).replayed, true);
  assert.deepEqual(production.store.farmPage(production.auth.profile.id, 'plots', null, NOW), productionPage);
  assert.deepEqual(production.store.farmDetail(production.auth.profile.id, RECORD_ID, 0, NOW), productionDetail);
  assert.deepEqual(production.store.bootstrap(production.auth.profile.id, NOW), productionSnapshot);
});

function rebuildTable(db, table, change) {
  const original = db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('table', table).sql;
  const changed = change(original), replacement = `${table}_replacement`;
  assert.notEqual(changed, original, 'the requested schema constraint must actually be changed');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(changed.replace(new RegExp(`CREATE TABLE ${table}\\b`, 'i'), `CREATE TABLE ${replacement}`));
  db.exec(`INSERT INTO ${replacement} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table}`);
  if (table === 'farm_records') db.exec('CREATE INDEX farm_records_owner ON farm_records(owner_id, environment, id)');
}

async function rewriteManifest(directory) {
  const file = path.join(directory, 'farm.sqlite'), manifestPath = path.join(directory, 'manifest.json');
  const bytes = await readFile(file), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  Object.assign(manifest, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

const schemaAlterations = [
  ['missing-composite-fk', 'farm_record_events', sql =>
    sql.replace(/,\s*FOREIGN KEY \(environment, record_id\) REFERENCES farm_records\(environment, id\)/u, '')],
  ['cascade-composite-fk', 'farm_record_events', sql =>
    sql.replace('REFERENCES farm_records(environment, id)', 'REFERENCES farm_records(environment, id) ON DELETE CASCADE')],
  ['missing-current-version-check', 'farm_records', sql => sql.replace(' CHECK (version >= 1)', '')],
  ['missing-event-version-check', 'farm_record_events', sql => sql.replace(' CHECK (version >= 1)', '')],
  ['nullable-owner', 'farm_records', sql => sql.replace('owner_id TEXT NOT NULL', 'owner_id TEXT')],
];

for (const [alteration, table, change] of schemaAlterations) {
  test(`schema9 backup refuses ${alteration} after manifest size and hash are recomputed`, async t => {
    const f = await fixture(t), account = f.open('development'), backup = f.output('backup');
    account.store.importFarmBatch(account.input, NOW);
    assert.equal((await createBackup({ databasePath: f.databasePath, outputDirectory: backup })).schemaVersion, 9);
    assert.equal((await verifyBackup({ backupDirectory: backup })).schemaVersion, 9);
    const db = new DatabaseSync(path.join(backup, 'farm.sqlite'));
    try {
      rebuildTable(db, table, change);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM farm_records').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM farm_record_events').get().n, 1);
    } finally { db.close(); }
    await rewriteManifest(backup);
    await assert.rejects(verifyBackup({ backupDirectory: backup }), { code: 'INVALID_APPLICATION_SCHEMA' });
    assert.equal(account.store.farmPage(account.auth.profile.id, 'plots', null, NOW).items.length, 1);
  });
}
