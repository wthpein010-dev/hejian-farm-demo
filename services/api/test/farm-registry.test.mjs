import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { validateFarmRegistryDatabase } from '../src/farm-registry.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const record = (ownerId, changes = {}) => ({ id: 'plot-unit-001', ownerId, kind: 'plot', name: '合成水稻',
  unitLabel: '合成A区', cycleRef: 'synthetic-cycle-1', status: 'planned', startedAt: null,
  expectedHarvestAt: null, observedAt: NOW - 1000, measurements: {}, ...changes });
const batch = (ownerId, changes = {}, batchId = 'batch-test-001', expectedVersion = 0) => ({
  formatVersion: 1, batchId, source: 'synthetic-test', entries: [{ expectedVersion, record: record(ownerId, changes) }],
});

function fixture(t, mode = 'development') {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-registry-'));
  const file = path.join(directory, 'test.sqlite');
  const store = new FarmStore(normalizeConfig({ databasePath: file, mode, clock: () => NOW }));
  const owner = store.createIdentity('development', 'synthetic-owner', store.serverNow());
  const neighbor = store.createIdentity('development', 'synthetic-neighbor', store.serverNow());
  t.after(() => { store.close(); assert.equal(path.dirname(directory), tmpdir()); rmSync(directory, { recursive: true }); });
  const database = work => { const db = new DatabaseSync(file); try { return work(db); } finally { db.close(); } };
  return { store, file, database, owner, neighbor, id: owner.profile.id };
}

test('farm imports persist independently of financial state, paginate and isolate owners', t => {
  const f = fixture(t), before = f.store.bootstrap(f.id, NOW);
  assert.equal(typeof f.store.importFarmBatch, 'function', 'private farm import is available');
  const result = f.store.importFarmBatch(batch(f.id), NOW);
  assert.deepEqual(result, { ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: false });
  assert.deepEqual(f.store.bootstrap(f.id, NOW), before);
  const page = f.store.farmPage(f.id, 'plots', 'start', NOW);
  assert.deepEqual([page.ownerId, page.environment, page.kind, page.items.length, page.nextCursor], [f.id, 'development', 'plots', 1, null]);
  assert.deepEqual([page.items[0].id, page.items[0].version, page.items[0].createdAt, page.items[0].updatedAt], ['plot-unit-001', 1, NOW, NOW]);
  assert.equal(f.store.farmPage(f.neighbor.profile.id, 'plots', 'start', NOW).items.length, 0);
  assert.equal(f.store.farmPage(f.id, 'animals', 'start', NOW).items.length, 0);
  assert.throws(() => f.store.farmDetail(f.neighbor.profile.id, 'plot-unit-001', 0, NOW), { code: 'NOT_FOUND' });
  assert.throws(() => f.store.farmPage('absent-owner', 'plots', 'start', NOW));
  assert.equal(f.database(db => db.prepare('PRAGMA user_version').get().user_version), 5);
  assert.ok(f.store.privacy(f.id).dataCategories.some(category => category.id === 'farm-records'));
});

test('same batch replays its original anonymous counts while different payload and partial conflicts roll back', t => {
  const f = fixture(t), input = batch(f.id);
  assert.equal(typeof f.store.importFarmBatch, 'function');
  f.store.importFarmBatch(input, NOW);
  assert.deepEqual(f.store.importFarmBatch(input, NOW + 100), { ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: true });
  assert.throws(() => f.store.importFarmBatch(batch(f.id, { name: 'changed' }), NOW), { code: 'IMPORT_CONFLICT' });
  const mixed = batch(f.id, { id: 'plot-unit-002' }, 'batch-mixed-001');
  mixed.entries.push({ expectedVersion: 0, record: record(f.id) });
  assert.throws(() => f.store.importFarmBatch(mixed, NOW), { code: 'VERSION_CONFLICT' });
  assert.equal(f.store.farmPage(f.id, 'plots', 'start', NOW).items.length, 1);
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM farm_imports').get().n), 1);
  const unavailable = batch('missing-owner', {}, 'batch-missing-01');
  assert.throws(() => f.store.importFarmBatch(unavailable, NOW), { code: 'OWNER_UNAVAILABLE' });
  f.database(db => db.prepare('UPDATE users SET environment = ? WHERE id = ?').run('production', f.neighbor.profile.id));
  assert.throws(() => f.store.importFarmBatch(batch(f.neighbor.profile.id, {}, 'batch-crossenv-01'), NOW), { code: 'OWNER_UNAVAILABLE' });
});

test('observation history enforces expected versions, immutable ownership and monotonic lifecycle', t => {
  const f = fixture(t);
  assert.equal(typeof f.store.importFarmBatch, 'function');
  f.store.importFarmBatch(batch(f.id), NOW);
  const updates = [
    [{ ownerId: f.neighbor.profile.id }, 'RECORD_CONFLICT'], [{ kind: 'animal' }, 'RECORD_CONFLICT'],
    [{ cycleRef: 'different-cycle' }, 'RECORD_CONFLICT'], [{ observedAt: NOW - 2000 }, 'RECORD_CONFLICT'],
  ];
  for (const [change, code] of updates) assert.throws(() => f.store.importFarmBatch(batch(f.id, change, 'batch-failed-001', 1), NOW), { code });
  f.store.importFarmBatch(batch(f.id, { status: 'growing', startedAt: NOW - 5000, observedAt: NOW }, 'batch-grow-0001', 1), NOW + 10);
  assert.throws(() => f.store.importFarmBatch(batch(f.id, { status: 'planned', startedAt: NOW - 5000, observedAt: NOW }, 'batch-back-0001', 2), NOW + 20), { code: 'RECORD_CONFLICT' });
  assert.throws(() => f.store.importFarmBatch(batch(f.id, { status: 'ready', startedAt: NOW - 4000, observedAt: NOW }, 'batch-start-001', 2), NOW + 20), { code: 'RECORD_CONFLICT' });
  f.store.importFarmBatch(batch(f.id, { status: 'archived', startedAt: NOW - 5000, observedAt: NOW }, 'batch-end-00001', 2), NOW + 20);
  assert.throws(() => f.store.importFarmBatch(batch(f.id, { status: 'growing', startedAt: NOW - 5000, observedAt: NOW }, 'batch-reopen-01', 3), NOW + 30), { code: 'RECORD_CONFLICT' });
  const detail = f.store.farmDetail(f.id, 'plot-unit-001', 0, NOW + 30);
  assert.deepEqual(detail.events.map(event => event.version), [3, 2, 1]);
  assert.equal(detail.record.status, 'archived');
  assert.deepEqual(f.store.farmDetail(f.id, 'plot-unit-001', 3, NOW + 30).events.map(event => event.version), [2, 1]);
});

test('stable id cursors and version cursors visit every item once', t => {
  const f = fixture(t);
  assert.equal(typeof f.store.importFarmBatch, 'function');
  const many = batch(f.id); many.entries = Array.from({ length: 23 }, (_, i) => ({ expectedVersion: 0,
    record: record(f.id, { id: 'plot-unit-' + String(i + 1).padStart(3, '0') }) }));
  f.store.importFarmBatch(many, NOW);
  const first = f.store.farmPage(f.id, 'plots', 'start', NOW), second = f.store.farmPage(f.id, 'plots', first.nextCursor, NOW);
  assert.deepEqual([first.items.length, second.items.length, first.nextCursor, second.nextCursor], [20, 3, 'plot-unit-020', null]);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 23);
  for (let version = 1; version <= 22; version++) f.store.importFarmBatch(batch(f.id, { observedAt: NOW }, 'batch-update-' + String(version).padStart(3, '0'), version), NOW + version);
  const latest = f.store.farmDetail(f.id, 'plot-unit-001', 0, NOW + 30);
  const earlier = f.store.farmDetail(f.id, 'plot-unit-001', latest.nextBeforeVersion, NOW + 30);
  assert.deepEqual([latest.events.length, latest.nextBeforeVersion, earlier.events.length, earlier.nextBeforeVersion], [20, 4, 3, null]);
  assert.deepEqual(earlier.events.map(event => event.version), [3, 2, 1]);
});

test('deletion erases current records and events and an old batch cannot revive the account', t => {
  const f = fixture(t);
  assert.equal(typeof f.store.importFarmBatch, 'function');
  const input = batch(f.id); f.store.importFarmBatch(input, NOW);
  const ready = f.store.prepareDeletion(f.id, f.owner.token, 0, NOW);
  assert.equal(f.store.confirmDeletion(ready.data.confirmationToken, NOW).status, 200);
  const counts = f.database(db => ['farm_records', 'farm_record_events', 'farm_imports'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n));
  assert.deepEqual(counts, [0, 0, 1]);
  assert.deepEqual(f.store.importFarmBatch(input, NOW + 1), { ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: true });
  assert.throws(() => f.store.importFarmBatch(batch(f.id, {}, 'batch-after-001'), NOW + 1), { code: 'OWNER_UNAVAILABLE' });
  const retained = f.database(db => JSON.stringify(db.prepare('SELECT * FROM farm_imports').all()));
  assert.equal(retained.includes(f.id), false); assert.equal(retained.includes('plot-unit-001'), false);
});

test('backup content validation rejects exact-boundary violations in event sources and anonymous imports', t => {
  const f = fixture(t);
  f.store.importFarmBatch(batch(f.id), NOW);
  assert.equal(f.database(db => validateFarmRegistryDatabase(db, NOW)), true);
  const corruptions = [
    ["UPDATE farm_record_events SET source = ?", 'synthetic-test\n'],
    ["UPDATE farm_imports SET batch_id = ?", 'batch-test-001\n'],
    ["UPDATE farm_imports SET fingerprint = ?", 'a'.repeat(64) + '\n'],
  ];
  for (const [sql, value] of corruptions) f.database(db => {
    db.exec('BEGIN');
    try {
      db.prepare(sql).run(value);
      assert.throws(() => validateFarmRegistryDatabase(db, NOW), { code: 'INVALID_FARM_DATA', message: '农场资料未能通过校验' });
    } finally { db.exec('ROLLBACK'); }
  });
});

test('backup content validation rejects missing versions, timeline reversals, changed ownership and unsafe receipts', t => {
  const f = fixture(t);
  f.store.importFarmBatch(batch(f.id), NOW);
  f.store.importFarmBatch(batch(f.id, { status: 'growing', observedAt: NOW }, 'batch-backup-02', 1), NOW + 100);
  const corruptions = [
    db => db.exec('DELETE FROM farm_record_events WHERE version = 1'),
    db => db.prepare('UPDATE farm_record_events SET recorded_at = ? WHERE version = 2').run(NOW - 1),
    db => db.prepare('UPDATE farm_records SET owner_id = ?').run(f.neighbor.profile.id),
    db => db.prepare('UPDATE farm_imports SET result_json = ?').run(JSON.stringify({ ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: false, ownerId: f.id })),
    db => db.prepare('UPDATE farm_imports SET created_at = ?').run(NOW + 101),
    db => {
      const row = db.prepare('SELECT * FROM farm_record_events WHERE version = 1').get(), value = JSON.parse(row.data_json);
      value.status = 'archived'; db.prepare('UPDATE farm_record_events SET data_json = ? WHERE version = 1').run(JSON.stringify(value));
    },
    db => {
      const row = db.prepare('SELECT * FROM farm_record_events WHERE version = 2').get(), value = JSON.parse(row.data_json);
      value.name = 'different last event'; db.prepare('UPDATE farm_record_events SET data_json = ? WHERE version = 2').run(JSON.stringify(value));
    },
  ];
  for (const corrupt of corruptions) f.database(db => {
    db.exec('BEGIN');
    try { corrupt(db); assert.throws(() => validateFarmRegistryDatabase(db, NOW + 100), { code: 'INVALID_FARM_DATA' }); }
    finally { db.exec('ROLLBACK'); }
  });
  assert.equal(f.database(db => validateFarmRegistryDatabase(db, NOW + 100)), true);
});

test('corrupt current JSON produces a fixed registry error instead of a SQLite implementation error', t => {
  const f = fixture(t); f.store.importFarmBatch(batch(f.id), NOW);
  f.database(db => db.prepare('UPDATE farm_records SET data_json = ?').run('{private-invalid-json'));
  assert.throws(() => f.store.farmPage(f.id, 'plots', null, NOW), { code: 'INVALID_FARM_DATA', message: '农场资料未能通过校验' });
  assert.throws(() => f.store.farmDetail(f.id, 'plot-unit-001', 0, NOW), { code: 'INVALID_FARM_DATA' });
});

test('two connections enforce the stored version and reopen preserves original import results', t => {
  const f = fixture(t), config = normalizeConfig({ databasePath: f.file, mode: 'development', clock: () => NOW });
  let other = new FarmStore(config);
  try {
    const original = batch(f.id); f.store.importFarmBatch(original, NOW);
    other.importFarmBatch(batch(f.id, { observedAt: NOW, status: 'growing' }, 'batch-other-01', 1), NOW + 10);
    assert.throws(() => f.store.importFarmBatch(batch(f.id, { status: 'ready', observedAt: NOW }, 'batch-stale-01', 1), NOW + 20), { code: 'VERSION_CONFLICT' });
    other.close(); other = new FarmStore(config);
    assert.equal(other.farmDetail(f.id, 'plot-unit-001', 0, NOW + 20).record.version, 2);
    assert.deepEqual(other.importFarmBatch(original, NOW + 20), { ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: true });
    assert.deepEqual(other.farmDetail(f.id, 'plot-unit-001', 0, NOW + 20).events.map(event => event.version), [2, 1]);
  } finally { other.close(); }
});
