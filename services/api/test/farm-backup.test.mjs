import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createBackup, verifyBackup, restoreBackup } from '../tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const config = databasePath => normalizeConfig({ databasePath, mode: 'development', allowDevelopmentAuth: true, clock: () => NOW });
const sample = ownerId => ({ id: 'plot-00000001', ownerId, kind: 'plot', name: '合成白菜', unitLabel: '合成区A',
  cycleRef: 'cycle-first', status: 'growing', startedAt: NOW - 86400000, expectedHarvestAt: null,
  observedAt: NOW - 100, measurements: { moisturePercent: 31 } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-record-backup-'));
  await mkdir(path.join(directory, 'source'));
  const databasePath = path.join(directory, 'source', 'farm.sqlite');
  const store = new FarmStore(config(databasePath));
  const auth = store.createIdentity('development', 'farm-backup-owner', store.serverNow());
  assert.equal(typeof store.importFarmBatch, 'function');
  const original = sample(auth.profile.id), current = { ...original, observedAt: NOW - 50, measurements: { moisturePercent: 45 } };
  store.importFarmBatch({ formatVersion: 1, batchId: 'backup-initial-01', source: 'synthetic-field', entries: [{ expectedVersion: 0, record: original }] }, store.serverNow());
  store.importFarmBatch({ formatVersion: 1, batchId: 'backup-updated-02', source: 'synthetic-field', entries: [{ expectedVersion: 1, record: current }] }, store.serverNow());
  t.after(async () => {
    store.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('farm-record-backup-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, store, auth, output: name => path.join(directory, name) };
}

async function rewriteManifest(directory) {
  const file = path.join(directory, 'farm.sqlite'), manifestPath = path.join(directory, 'manifest.json');
  const bytes = await readFile(file), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  Object.assign(manifest, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('schema6 online backup and isolated restore preserve farm pages/history while clearing old sessions and preserving financial state', async t => {
  const f = await fixture(t), before = f.store.bootstrap(f.auth.profile.id, NOW);
  const page = f.store.farmPage(f.auth.profile.id, 'plots', null, NOW), detail = f.store.farmDetail(f.auth.profile.id, 'plot-00000001', 0, NOW);
  const report = await createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup') });
  assert.equal(report.schemaVersion, 6); assert.equal((await verifyBackup({ backupDirectory: f.output('backup') })).schemaVersion, 6);
  await restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('restored') });
  const restored = new FarmStore(config(path.join(f.output('restored'), 'farm.sqlite')));
  try {
    assert.equal(restored.authenticate(f.auth.token, NOW), null);
    const auth = restored.createIdentity('development', 'farm-backup-owner', NOW);
    assert.deepEqual(restored.farmPage(auth.profile.id, 'plots', null, NOW), page);
    assert.deepEqual(restored.farmDetail(auth.profile.id, 'plot-00000001', 0, NOW), detail);
    assert.deepEqual(restored.bootstrap(auth.profile.id, NOW), before);
    assert.equal(restored.farmDetail(auth.profile.id, 'plot-00000001', 0, NOW).events.length, 2);
  } finally { restored.close(); }
});

for (const corruption of ['missing-history', 'wrong-current', 'cross-owner-event', 'future-observation', 'invalid-import-receipt', 'extra-index', 'missing-owner-index']) {
  test(`schema6 backup refuses ${corruption} even after an operator recomputes the file hash`, async t => {
    const f = await fixture(t), backup = f.output('backup');
    await createBackup({ databasePath: f.databasePath, outputDirectory: backup });
    const db = new DatabaseSync(path.join(backup, 'farm.sqlite'));
    try {
      if (corruption === 'missing-history') db.exec('DELETE FROM farm_record_events WHERE version = 1');
      if (corruption === 'extra-index') db.exec('CREATE INDEX farm_surprise ON farm_records(version)');
      if (corruption === 'missing-owner-index') db.exec('DROP INDEX farm_records_owner');
      if (corruption === 'invalid-import-receipt') db.exec(`UPDATE farm_imports SET result_json = '{"ok":true,"account":"private"}'`);
      if (['wrong-current', 'future-observation'].includes(corruption)) {
        const row = db.prepare('SELECT data_json FROM farm_records').get(), data = JSON.parse(row.data_json);
        if (corruption === 'wrong-current') data.name = '不同的当前资料'; else data.observedAt = NOW + 100;
        db.prepare('UPDATE farm_records SET data_json = ?').run(JSON.stringify(data));
      }
      if (corruption === 'cross-owner-event') {
        const row = db.prepare('SELECT data_json FROM farm_record_events WHERE version = 1').get(), data = JSON.parse(row.data_json);
        data.ownerId = 'different-account'; db.prepare('UPDATE farm_record_events SET data_json = ? WHERE version = 1').run(JSON.stringify(data));
      }
    } finally { db.close(); }
    await rewriteManifest(backup);
    await assert.rejects(verifyBackup({ backupDirectory: backup }), error => ['INVALID_APPLICATION_DATA', 'INVALID_APPLICATION_SCHEMA'].includes(error.code));
    await assert.rejects(restoreBackup({ backupDirectory: backup, outputDirectory: f.output('refused') }));
  });
}
