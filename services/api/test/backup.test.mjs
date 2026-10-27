import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, lstat, symlink } from 'node:fs/promises';
import { renameSync, linkSync, symlinkSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

let tools = {};
try { tools = await import('../tools/sqlite-backup.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const NOW = Date.parse('2026-10-27T04:00:00Z');
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-backup-test-'));
  const sourceDirectory = path.join(directory, 'source');
  await mkdir(sourceDirectory, { mode: 0o700 });
  const databasePath = path.join(sourceDirectory, 'farm.sqlite');
  const apps = [];
  async function service(file = databasePath) {
    const app = createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true,
      clock: () => NOW, requestRateLimit: { maxRequests: 10000, windowMs: 60000 } });
    apps.push(app);
    const port = await listenOnFetchSafePort(app.server);
    const base = `http://127.0.0.1:${port}/api/v1`;
    async function request(route, { token, body, key, discard = false } = {}) {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (discard) { await response.body.cancel(); return { status: response.status }; }
      return { status: response.status, json: await response.json() };
    }
    async function login(account = 'backup-account') {
      const r = await request('/auth/development', { body: { account } });
      assert.equal(r.status, 200); return r.json.data;
    }
    async function snapshot(token) {
      const r = await request('/bootstrap', { token });
      assert.equal(r.status, 200); return r.json.data;
    }
    return { app, request, login, snapshot };
  }
  t.after(async () => {
    for (const app of apps) await app.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('farm-backup-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, service, output: label => path.join(directory, label) };
}

function requireTools() {
  assert.equal(typeof tools.createBackup, 'function', 'a real online SQLite backup operation must exist');
  assert.equal(typeof tools.restoreBackup, 'function', 'a new-target-only SQLite restore operation must exist');
  assert.equal(typeof tools.verifyBackup, 'function', 'backup verification must exist');
}

async function rewriteManifest(directory) {
  const bytes = await readFile(path.join(directory, 'farm.sqlite'));
  const file = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.sha256 = digest(bytes); manifest.bytes = bytes.length;
  await writeFile(file, JSON.stringify(manifest));
}

function rebuildTable(db, table, change) {
  const original = db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('table', table).sql;
  const temporary = `${table}_replacement`;
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(change(original).replace(new RegExp(`CREATE TABLE ${table}\\b`, 'i'), `CREATE TABLE ${temporary}`));
  db.exec(`INSERT INTO ${temporary} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table}`);
}

async function withWriteFault(mode, action) {
  const original = fs.writeSync;
  fs.writeSync = (fd, payload, offset, length, position) => {
    if (mode === 'zero') return 0;
    const buffer = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const start = typeof payload === 'string' ? 0 : offset;
    const wanted = typeof payload === 'string' ? buffer.length : length;
    return original(fd, buffer, start, Math.min(7, wanted), typeof payload === 'string' ? (offset ?? null) : position);
  };
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs.writeSync = original; syncBuiltinESMExports(); }
}

test('online WAL backup restores confirmed assets, invalidates old sessions and replays an unreceived checkout exactly once after login', async t => {
  const f = await fixture(t), source = await f.service(), auth = await source.login();
  let r = await source.request('/cart/items', { token: auth.token, key: 'backup-cart-first',
    body: { sku: 'feed-pack', delta: 1, expectedRevision: 0 } });
  assert.equal(r.status, 200);
  const checkoutBody = { expectedRevision: 1 };
  r = await source.request('/checkout', { token: auth.token, key: 'backup-lost-checkout', body: checkoutBody, discard: true });
  assert.equal(r.status, 200);
  const confirmed = await source.snapshot(auth.token);
  assert.deepEqual([confirmed.wallet.points, confirmed.wallet.feed, confirmed.revision], [50, 9, 2]);
  requireTools();

  // Keep the writer's WAL active and make enough real application pages to
  // exercise an incremental online backup while HTTP writes keep committing.
  const fill = new DatabaseSync(f.databasePath);
  fill.exec('PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE');
  const insert = fill.prepare("INSERT INTO code_claims VALUES (?, 'weixin', 'used', ?, ?)");
  for (let i = 0; i < 12000; i++) insert.run(`backup-fixture-${String(i).padStart(8, '0')}-${'x'.repeat(100)}`, NOW, NOW);
  fill.exec('COMMIT');
  assert.ok((await lstat(f.databasePath + '-wal')).size > 0);
  const writer = await source.login('concurrent-writer');
  let copying = true, overlappingWrites = 0;
  const copyingResult = tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup'), pagesPerStep: 1 })
    .finally(() => { copying = false; });
  const writes = (async () => {
    let revision = 0;
    for (let i = 0; i < 12; i++) {
      const during = copying;
      const response = await source.request('/cart/items', { token: writer.token, key: `backup-writer-${i}`,
        body: { sku: 'feed-pack', delta: i % 2 === 0 ? 1 : -1, expectedRevision: revision } });
      assert.equal(response.status, 200); revision = response.json.data.revision;
      if (during && copying) overlappingWrites++;
    }
  })();
  let report;
  try { [report] = await Promise.all([copyingResult, writes]); } finally { fill.close(); }
  assert.ok(overlappingWrites > 0, 'at least one HTTP write must commit during the online backup');
  assert.ok([2, 3, 4, 5, 6, 7, 8, 9, 10].includes(report.schemaVersion));
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await readdir(f.output('backup'))).sort(), ['farm.sqlite', 'manifest.json']);
  const bytes = await readFile(path.join(f.output('backup'), 'farm.sqlite'));
  assert.equal(bytes.includes(Buffer.from(auth.token)), false);
  assert.equal(JSON.stringify(report).includes(auth.profile.id), false);
  assert.equal(JSON.stringify(report).includes(auth.token), false);
  assert.equal((await tools.verifyBackup({ backupDirectory: f.output('backup') })).sha256, report.sha256);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.output('backup'))).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(f.output('backup'), 'farm.sqlite'))).mode & 0o777, 0o600);
  }

  await tools.restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('restored') });
  const recovered = await f.service(path.join(f.output('restored'), 'farm.sqlite'));
  assert.equal((await recovered.request('/bootstrap', { token: auth.token })).status, 401);
  const newSession = await recovered.login();
  assert.equal(newSession.profile.id, auth.profile.id);
  assert.deepEqual(await recovered.snapshot(newSession.token), confirmed);
  r = await recovered.request('/checkout', { token: newSession.token, key: 'backup-lost-checkout', body: checkoutBody });
  assert.equal(r.status, 200); assert.deepEqual(r.json.data, confirmed); assert.equal(r.json.replayed, true);
  assert.deepEqual((await recovered.snapshot(newSession.token)).wallet, confirmed.wallet);
});

test('backup is standalone and remains usable after the entire original database directory is removed', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(), auth = await source.login();
  await source.request('/activities/sign-in', { token: auth.token, key: 'independent-sign-in', body: { expectedRevision: 0 } });
  const confirmed = await source.snapshot(auth.token);
  await tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup') });
  await source.app.close();
  const sourceDirectory = path.dirname(f.databasePath);
  assert.equal(path.dirname(sourceDirectory), f.directory);
  await rm(sourceDirectory, { recursive: true });
  await tools.restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('restored') });
  const recovered = await f.service(path.join(f.output('restored'), 'farm.sqlite'));
  assert.equal((await recovered.request('/bootstrap', { token: auth.token })).status, 401);
  const newSession = await recovered.login();
  assert.equal(newSession.profile.id, auth.profile.id);
  assert.deepEqual(await recovered.snapshot(newSession.token), confirmed);
});

test('restore clears schema3 deletion confirmations and sessions, retaining anonymous deletion receipts and backup bytes', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(), auth = await source.login(); await source.app.close();
  const db = new DatabaseSync(f.databasePath);
  db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles;');
  db.exec(`CREATE TABLE IF NOT EXISTS deletion_confirmations (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), session_hash TEXT NOT NULL,
    expected_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deletion_receipts (token_hash TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
    DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands; DROP TABLE forum_commands; DROP TABLE forum_reports; DROP TABLE forum_content; DROP TABLE forum_usage; DROP TABLE forum_moderation; DROP TABLE friends_commands; DROP TABLE friends_blocks; DROP TABLE friends_relations; DROP TABLE friends_profiles;
    DROP TABLE IF EXISTS farm_record_events; DROP TABLE IF EXISTS farm_records; DROP TABLE IF EXISTS farm_imports; PRAGMA user_version=3`);
  db.prepare('INSERT INTO deletion_confirmations VALUES (?, ?, ?, 0, ?)').run('a'.repeat(64), auth.profile.id, digest(auth.token), NOW + 60000);
  db.prepare('INSERT INTO deletion_receipts VALUES (?, ?)').run('b'.repeat(64), NOW);
  db.close();
  const backedUp = await tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup-v3') });
  const restored = await tools.restoreBackup({ backupDirectory: f.output('backup-v3'), outputDirectory: f.output('restored-v3') });
  const restoredFile = path.join(f.output('restored-v3'), 'farm.sqlite');
  const clean = new DatabaseSync(restoredFile, { readOnly: true });
  assert.equal(clean.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.equal(clean.prepare('SELECT COUNT(*) AS count FROM deletion_confirmations').get().count, 0);
  assert.equal(clean.prepare('SELECT COUNT(*) AS count FROM deletion_receipts').get().count, 1);
  assert.equal(clean.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1); clean.close();
  assert.equal(restored.sessionsInvalidated, true);
  assert.equal(restored.sourceSha256, backedUp.sha256);
  assert.equal(restored.sha256, digest(await readFile(restoredFile)));
  assert.notEqual(restored.sha256, backedUp.sha256);
  assert.equal((await tools.verifyBackup({ backupDirectory: f.output('backup-v3') })).sha256, backedUp.sha256);
});

test('existing targets, relative paths and overlapping directories are rejected without altering source or existing files', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(), auth = await source.login();
  const original = await source.snapshot(auth.token);
  await mkdir(f.output('existing')); await writeFile(path.join(f.output('existing'), 'keep.txt'), 'keep-existing-data');
  await assert.rejects(tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('existing') }));
  await assert.rejects(tools.createBackup({ databasePath: f.databasePath, outputDirectory: path.join(path.dirname(f.databasePath), 'nested') }));
  await assert.rejects(tools.createBackup({ databasePath: f.databasePath, outputDirectory: 'relative-backup' }));
  await assert.rejects(tools.createBackup({ databasePath: f.output('missing.sqlite'), outputDirectory: f.output('never-created') }));
  assert.equal(await readFile(path.join(f.output('existing'), 'keep.txt'), 'utf8'), 'keep-existing-data');
  assert.deepEqual(await source.snapshot(auth.token), original);
  await tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup') });
  const sourceHash = digest(await readFile(path.join(f.output('backup'), 'farm.sqlite')));
  await assert.rejects(tools.restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('existing') }));
  await assert.rejects(tools.restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: path.join(f.output('backup'), 'nested') }));
  await assert.rejects(tools.restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: f.output('backup') }));
  assert.equal(digest(await readFile(path.join(f.output('backup'), 'farm.sqlite'))), sourceHash);
  assert.equal(await readFile(path.join(f.output('existing'), 'keep.txt'), 'utf8'), 'keep-existing-data');
  assert.equal((await readdir(path.dirname(f.databasePath))).includes('nested'), false);
});

test('corrupt bytes, foreign key violations, invalid application tables and future schema cannot be restored', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(); await source.login();
  for (const kind of ['hash', 'integrity', 'foreign-key', 'missing-table', 'bad-state', 'bad-shape', 'future-schema']) {
    const directory = f.output(`backup-${kind}`);
    await tools.createBackup({ databasePath: f.databasePath, outputDirectory: directory });
    const file = path.join(directory, 'farm.sqlite');
    if (kind === 'hash' || kind === 'integrity') {
      const bytes = await readFile(file); bytes[0] = 0; await writeFile(file, bytes);
      if (kind === 'integrity') await rewriteManifest(directory);
    } else {
      const db = new DatabaseSync(file);
      if (kind === 'foreign-key') db.exec("PRAGMA foreign_keys=OFF; INSERT INTO sessions VALUES ('orphan-session', 'missing-user', 1, 2, NULL)");
      if (kind === 'missing-table') db.exec('DROP TABLE idempotency');
      if (kind === 'bad-state') db.exec("UPDATE users SET state_json = '{invalid-state-json'");
      if (kind === 'bad-shape') db.exec("UPDATE users SET state_json = json_set(state_json, '$.system.inventory.fertilizer', -1)");
      if (kind === 'future-schema') db.exec('PRAGMA user_version = 999');
      db.close(); await rewriteManifest(directory);
      if (kind === 'future-schema') {
        const manifestFile = path.join(directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8')); manifest.schemaVersion = 999;
        await writeFile(manifestFile, JSON.stringify(manifest));
      }
    }
    const before = digest(await readFile(file));
    await assert.rejects(tools.restoreBackup({ backupDirectory: directory, outputDirectory: f.output(`reject-${kind}`) }), undefined, kind);
    await assert.rejects(lstat(f.output(`reject-${kind}`)), { code: 'ENOENT' });
    assert.equal(digest(await readFile(file)), before, kind);
  }
});

for (const alteration of ['missing-identity-unique', 'extra-unique-index', 'missing-code-check', 'illegal-code-status']) {
  test(`restore refuses schema semantics alteration: ${alteration}`, async t => {
    requireTools();
    const f = await fixture(t), source = await f.service(), auth = await source.login();
    const directory = f.output('backup');
    await tools.createBackup({ databasePath: f.databasePath, outputDirectory: directory });
    const file = path.join(directory, 'farm.sqlite'), db = new DatabaseSync(file);
    if (alteration === 'missing-identity-unique') {
      rebuildTable(db, 'users', sql => sql.replace(/,\s*UNIQUE\s*\(environment,\s*identity_provider,\s*identity_subject\)/i, ''));
      db.prepare(`INSERT INTO users SELECT ?, environment, identity_provider, identity_subject, display_name,
        state_json, revision, created_at, updated_at FROM users WHERE id = ?`).run('duplicate-identity-user', auth.profile.id);
    } else if (alteration === 'extra-unique-index') db.exec('CREATE UNIQUE INDEX users_revision_unique ON users(revision)');
    else {
      rebuildTable(db, 'code_claims', sql => sql.replace(/ CHECK\s*\(status IN\s*\('pending',\s*'used',\s*'failed'\)\)/i, ''));
      if (alteration === 'illegal-code-status') db.prepare('INSERT INTO code_claims VALUES (?, ?, ?, ?, ?)')
        .run('c'.repeat(64), 'weixin', 'unexpected', NOW, NOW);
    }
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); db.close();
    await rewriteManifest(directory);
    const before = digest(await readFile(file));
    await assert.rejects(tools.restoreBackup({ backupDirectory: directory, outputDirectory: f.output('rejected') }), undefined, alteration);
    await assert.rejects(lstat(f.output('rejected')), { code: 'ENOENT' });
    assert.equal(digest(await readFile(file)), before);
  });
}

for (const alteration of ['foreign-account', 'wrong-environment', 'missing-revision', 'future-revision', 'missing-time', 'future-time', 'missing-catalog', 'invalid-capabilities']) {
  test(`restore refuses invalid successful receipt metadata: ${alteration}`, async t => {
    requireTools();
    const f = await fixture(t), source = await f.service(), a = await source.login('receipt-owner-a'), b = await source.login('receipt-owner-b');
    const success = await source.request('/activities/sign-in', { token: a.token, key: 'owned-receipt-first', body: { expectedRevision: 0 } });
    assert.equal(success.status, 200);
    let receipt = structuredClone(success.json.data);
    if (alteration === 'foreign-account') receipt = await source.snapshot(b.token);
    if (alteration === 'wrong-environment') receipt.environment = 'production';
    if (alteration === 'missing-revision') delete receipt.revision;
    if (alteration === 'future-revision') receipt.revision = 999;
    if (alteration === 'missing-time') delete receipt.serverTime;
    if (alteration === 'future-time') receipt.serverTime = NOW + 1;
    if (alteration === 'missing-catalog') delete receipt.catalog;
    if (alteration === 'invalid-capabilities') receipt.capabilities.payments = true;
    const directory = f.output('backup');
    await tools.createBackup({ databasePath: f.databasePath, outputDirectory: directory });
    const file = path.join(directory, 'farm.sqlite'), db = new DatabaseSync(file);
    db.prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ?').run(JSON.stringify(receipt), a.profile.id); db.close();
    await rewriteManifest(directory);
    const before = digest(await readFile(file));
    await assert.rejects(tools.restoreBackup({ backupDirectory: directory, outputDirectory: f.output('rejected') }), undefined, alteration);
    await assert.rejects(lstat(f.output('rejected')), { code: 'ENOENT' });
    assert.equal(digest(await readFile(file)), before);
  });
}

test('legal short manifest writes finish completely and produce a verifiable backup before reporting success', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(); await source.login();
  const result = await withWriteFault('short', () => tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('short') }));
  assert.equal(result.ok, true);
  await assert.doesNotReject(tools.verifyBackup({ backupDirectory: f.output('short') }), 'successful short writes must produce a complete manifest');
});

test('zero-progress manifest write fails and removes only its new private artifacts', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(), auth = await source.login();
  const before = await source.snapshot(auth.token);
  await assert.rejects(withWriteFault('zero', () => tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('zero') })), { code: 'WRITE_STALLED' });
  await assert.rejects(lstat(f.output('zero')), { code: 'ENOENT' });
  assert.deepEqual(await source.snapshot(auth.token), before);
});

test('a replaced reserved output path fails closed and cleanup preserves the replacement and its victim', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(); await source.login();
  const victimFile = f.output('victim.sqlite');
  await writeFile(victimFile, 'existing-private-file-must-stay-unchanged');
  for (const replacement of ['hardlink', 'junction']) {
    const output = f.output(`replaced-${replacement}`);
    const copying = tools.createBackup({ databasePath: f.databasePath, outputDirectory: output, pagesPerStep: 1 });
    const reserved = path.join(output, 'farm.sqlite');
    try { renameSync(reserved, path.join(output, 'original-reserved.sqlite')); }
    catch (error) {
      // SQLite's native Windows destination handle denies renaming while the
      // backup is active. This is also a successful prevention of replacement.
      if (process.platform !== 'win32' || error.code !== 'EBUSY') throw error;
      assert.equal((await copying).ok, true);
      assert.equal(await readFile(victimFile, 'utf8'), 'existing-private-file-must-stay-unchanged');
      continue;
    }
    if (replacement === 'hardlink') linkSync(victimFile, reserved);
    else symlinkSync(f.output('source'), reserved, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(copying);
    assert.equal(await readFile(victimFile, 'utf8'), 'existing-private-file-must-stay-unchanged');
    assert.ok((await readdir(output)).includes('farm.sqlite'), 'cleanup must preserve a replacement it does not own');
    assert.equal((await readdir(output)).includes('manifest.json'), false);
    assert.equal((await source.snapshot((await source.login()).token)).wallet.points, 80);
  }
});

test('v2 backups remain accepted and schema claims must match the actual database', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(); await source.login(); await source.app.close();
  const db = new DatabaseSync(f.databasePath);
  db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands; DROP TABLE forum_commands; DROP TABLE forum_reports; DROP TABLE forum_content; DROP TABLE forum_usage; DROP TABLE forum_moderation; DROP TABLE friends_commands; DROP TABLE friends_blocks; DROP TABLE friends_relations; DROP TABLE friends_profiles; DROP TABLE IF EXISTS farm_record_events; DROP TABLE IF EXISTS farm_records; DROP TABLE IF EXISTS farm_imports; DROP TABLE IF EXISTS deletion_confirmations; DROP TABLE IF EXISTS deletion_receipts; PRAGMA user_version = 2'); db.close();
  const report = await tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup-v2') });
  assert.equal(report.schemaVersion, 2);
  await tools.restoreBackup({ backupDirectory: f.output('backup-v2'), outputDirectory: f.output('restored-v2') });
  const manifestFile = path.join(f.output('backup-v2'), 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')); manifest.schemaVersion = 3;
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(tools.restoreBackup({ backupDirectory: f.output('backup-v2'), outputDirectory: f.output('rejected-claim') }));
});

test('directory links and linked input files are rejected before touching their destinations', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(); await source.login();
  await mkdir(f.output('link-victim')); await writeFile(path.join(f.output('link-victim'), 'keep.txt'), 'untouched');
  await symlink(f.output('link-victim'), f.output('linked-parent'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.createBackup({ databasePath: f.databasePath, outputDirectory: path.join(f.output('linked-parent'), 'backup') }));
  await symlink(path.dirname(f.databasePath), f.output('linked-source'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.createBackup({ databasePath: path.join(f.output('linked-source'), 'farm.sqlite'), outputDirectory: f.output('backup-linked') }));
  await tools.createBackup({ databasePath: f.databasePath, outputDirectory: f.output('backup') });
  await symlink(f.output('backup'), f.output('linked-backup'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.restoreBackup({ backupDirectory: f.output('linked-backup'), outputDirectory: f.output('restore-linked') }));
  await assert.rejects(tools.restoreBackup({ backupDirectory: f.output('backup'), outputDirectory: path.join(f.output('linked-parent'), 'restore') }));
  assert.deepEqual(await readdir(f.output('link-victim')), ['keep.txt']);
  assert.equal(await readFile(path.join(f.output('link-victim'), 'keep.txt'), 'utf8'), 'untouched');
});

test('CLI backup and restore require explicit paths and report only non-personal metadata', async t => {
  requireTools();
  const f = await fixture(t), source = await f.service(), auth = await source.login('cli-private-account');
  const backupCli = fileURLToPath(new URL('../tools/backup.mjs', import.meta.url));
  const restoreCli = fileURLToPath(new URL('../tools/restore.mjs', import.meta.url));
  const verifyCli = fileURLToPath(new URL('../tools/verify.mjs', import.meta.url));
  const backedUp = await run(process.execPath, [backupCli, '--database', f.databasePath, '--output', f.output('cli-backup')]);
  const report = JSON.parse(backedUp.stdout); assert.equal(report.ok, true); assert.equal(report.operation, 'backup');
  const checked = await run(process.execPath, [verifyCli, '--backup', f.output('cli-backup')]).catch(error => error);
  assert.equal(checked.code, undefined, 'a standalone verify CLI must validate the artifact');
  assert.equal(JSON.parse(checked.stdout).operation, 'verify');
  const recovered = await run(process.execPath, [restoreCli, '--backup', f.output('cli-backup'), '--output', f.output('cli-restored')]);
  assert.equal(JSON.parse(recovered.stdout).operation, 'restore');
  for (const output of [backedUp.stdout, backedUp.stderr, recovered.stdout, recovered.stderr]) {
    assert.equal(output.includes(auth.token), false); assert.equal(output.includes(auth.profile.id), false);
    assert.equal(output.includes('cli-private-account'), false); assert.equal(output.includes(f.directory), false);
  }
  const incomplete = await run(process.execPath, [restoreCli, '--backup', f.output('cli-backup')]).catch(error => error);
  assert.equal(incomplete.code, 1); assert.equal(incomplete.stdout, ''); assert.match(incomplete.stderr, /RESTORE_FAILED/);
  const sentinel = path.join(f.output('cli-backup'), 'manifest.json'); const before = await readFile(sentinel, 'utf8');
  const repeat = await run(process.execPath, [backupCli, '--database', f.databasePath, '--output', f.output('cli-backup')]).catch(error => error);
  assert.equal(repeat.code, 1); assert.equal(await readFile(sentinel, 'utf8'), before);
});
