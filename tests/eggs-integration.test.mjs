import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, chmodSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { FarmStore } from '../services/api/src/store.mjs';
import { normalizeConfig } from '../services/api/src/config.mjs';
import { validateEggsDatabase } from '../services/api/src/eggs.mjs';
import { createApp } from '../services/api/src/server.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';
import { createBackup, verifyBackup, restoreBackup, inspectApplicationDatabase } from '../services/api/tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const RECORD = 'animal-eggs-0001';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-eggs-http-')), file = path.join(directory, 'farm.sqlite');
  let now = NOW, app, base; const logs = [];
  async function start() { app = createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true, clock: () => now, logger: entry => logs.push(entry), requestRateLimit: { maxRequests: 10000, windowMs: 60000 }, ...options }); base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`; }
  await start(); t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(route, auth, body) { const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
  async function ok(route, auth, body) { const r = await request(route, auth, body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.data; }
  const login = account => ok('/auth/development', null, { account });
  const database = work => { const db = new DatabaseSync(file); try { return work(db); } finally { db.close(); } };
  const record = ownerId => ({ id: RECORD, ownerId, kind: 'animal', name: '合成鸡舍', unitLabel: '鸡舍1', cycleRef: 'synthetic-cycle', status: 'growing', startedAt: NOW - 1000, expectedHarvestAt: null, observedAt: NOW - 100, measurements: { headCount: 10 } });
  function put(ownerId, expectedVersion = 0, patch = {}) { app.store.importFarmBatch({ formatVersion: 1, batchId: `batch-eggs-${expectedVersion}-synthetic`, source: 'synthetic-field', entries: [{ expectedVersion, record: { ...record(ownerId), ...patch } }] }, app.store.serverNow()); }
  function provision(staff, patch = {}) { assert.equal(typeof app.store.provisionEggs, 'function', 'Store owns the eggs transaction seam'); return app.store.provisionEggs({ recordId: RECORD, expectedProfileVersion: 0, recordVersion: 1, profile: 'chicken-eggs', enabled: true, maxDailyQuantity: 20, staff: [{ accountId: staff.profile.id, role: 'record' }], ...patch }, app.store.serverNow()); }
  async function seed(configure = true) { const a = await login('eggs-owner'), b = await login('eggs-other'), staff = await login('eggs-staff'); put(a.profile.id); if (configure) provision(staff); return { a, b, staff }; }
  async function prepare(auth, command, audience = 'customer') { const v = await ok('/account/recovery', auth); return (await ok('/account/recovery/prepare', auth, { expectedEpoch: v.epoch, expectedVersion: v.version, audience, command })).intent; }
  const act = (action, auth, id) => ok('/account/recovery/' + action, auth, { intentId: id });
  async function command(auth, input, audience = 'customer') { const p = await prepare(auth, input, audience), r = await act('execute', auth, p.id); await act('ack', auth, p.id); return r.intent.receipt; }
  const register = (staff, patch = {}) => command(staff, { domain: 'eggs', action: 'register', recordId: RECORD, expectedProfileVersion: 1, sourceRef: 'synthetic-source-0001', quantity: 5, ...patch }, 'staff');
  const collect = (a, batchId, expectedRevision = 0, expectedBatchVersion = 1) => command(a, { domain: 'eggs', action: 'collect', batchId, expectedBatchVersion, expectedRevision });
  return { seed, ok, request, login, database, put, provision, prepare, act, command, register, collect, logs, file, get app() { return app; }, get now() { return now; }, advance(ms) { now += ms; }, restart: async () => { await app.close(); await start(); } };
}

test('HTTP eggs discovery is authenticated, isolated and explicit; names or planting powers never enable eggs', async t => {
  const f = await fixture(t), { a, b, staff } = await f.seed(false);
  assert.equal((await f.request('/eggs/status')).status, 401);
  assert.equal((await f.ok('/eggs/record/' + RECORD, a)).enabled, false);
  assert.equal((await f.register(staff)).code, 'NOT_FOUND');
  f.provision(staff);
  assert.equal((await f.ok('/eggs/status', staff)).hasStaffAccess, true);
  assert.equal((await f.ok('/staff/eggs/records/start', staff)).items[0].permissions.canRegister, true);
  assert.equal((await f.request('/eggs/record/' + RECORD, b)).status, 404);
  assert.equal((await f.request('/staff/eggs/record/' + RECORD, b)).status, 404);
  assert.equal((await f.request('/eggs/batches/BAD', a)).status, 400);
  assert.equal((await f.request('/eggs/status?ownerId=other', a)).status, 400);
  assert.equal((await f.request('/eggs/commands', a, {})).status, 404);
});

test('daily actual production and unique source apply once; withdrawal permits corrected source but never reuses old source', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), before = await f.ok('/bootstrap', a);
  const original = await f.register(staff); assert.equal(original.code, 'OK');
  assert.equal((await f.register(staff, { sourceRef: 'synthetic-source-0002' })).code, 'DAILY_BATCH_EXISTS');
  assert.equal((await f.command(staff, { domain: 'eggs', action: 'withdraw', batchId: original.batchId, expectedBatchVersion: 1 }, 'staff')).code, 'OK');
  assert.equal((await f.register(staff)).code, 'SOURCE_EXISTS');
  const fixed = await f.register(staff, { sourceRef: 'synthetic-source-0002', quantity: 7 }); assert.equal(fixed.code, 'OK');
  const after = await f.ok('/bootstrap', a); assert.equal(after.revision, before.revision); assert.deepEqual(after.system, before.system);
  f.advance(86400000); const staffNext = await f.login('eggs-staff'), aNext = await f.login('eggs-owner');
  assert.equal((await f.register(staffNext, { sourceRef: 'synthetic-source-0003' })).code, 'OK');
  assert.equal((await f.ok('/eggs/batch/' + fixed.batchId, aNext)).permissions.canCollect, true);
});

test('independent authorized staff race one Shanghai-day batch, while quantities, profile changes and role boundaries are enforced', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), other = await f.login('eggs-staff-other');
  f.provision(staff, { expectedProfileVersion: 1, staff: [{ accountId: staff.profile.id, role: 'record' }, { accountId: other.profile.id, role: 'record' }] });
  assert.equal((await f.register(staff)).code, 'PROFILE_CHANGED');
  assert.equal((await f.register(staff, { expectedProfileVersion: 2, quantity: 21 })).code, 'QUANTITY_LIMIT');
  const results = await Promise.all([f.register(staff, { expectedProfileVersion: 2 }), f.register(other, { expectedProfileVersion: 2, sourceRef: 'synthetic-source-0002' })]);
  assert.deepEqual(results.map(x => x.code).sort(), ['DAILY_BATCH_EXISTS', 'OK']);
  const made = results.find(x => x.code === 'OK');
  assert.equal((await f.request('/account/recovery/prepare', a, { expectedEpoch: 'a'.repeat(32), expectedVersion: 0, audience: 'customer', command: { domain: 'eggs', action: 'register', recordId: RECORD, expectedProfileVersion: 2, sourceRef: 'synthetic-source-0003', quantity: 1 } })).status, 400);
  assert.equal(f.database(db => validateEggsDatabase(db, f.now)), true);
  assert.equal((await f.ok('/eggs/batches/start', a)).items[0].id, made.batchId);
});

test('collect atomically issues eggs, XP and harvest once, independent of normal observations; original results survive restart and revocation', async t => {
  const f = await fixture(t), { a, b, staff } = await f.seed(), made = await f.register(staff), before = await f.ok('/bootstrap', a);
  f.put(a.profile.id, 1, { observedAt: f.now, measurements: { headCount: 9, weightKg: 20 } });
  assert.equal((await f.collect(b, made.batchId)).code, 'NOT_FOUND');
  const command = { domain: 'eggs', action: 'collect', batchId: made.batchId, expectedBatchVersion: 1, expectedRevision: 0 }, p = await f.prepare(a, command);
  const results = await Promise.all([f.act('execute', a, p.id), f.act('execute', a, p.id)]), receipt = results[0].intent.receipt;
  assert.deepEqual(results[1].intent.receipt, receipt); assert.equal(receipt.quantity, 5); assert.equal(receipt.appliedRevision, 1);
  await f.act('ack', a, p.id);
  const state = await f.ok('/bootstrap', a); assert.equal(state.revision, 1); assert.equal(state.system.inventory.eggs, 5); assert.equal(state.system.xp, before.system.xp + 8); assert.equal(state.system.daily.harvest, 1); assert.equal(state.system.stats.harvest, 1); assert.equal(state.tasks.find(x => x.id === 'harvest').ready, true);
  assert.equal((await f.collect(a, made.batchId, 1, 2)).code, 'INVALID_STATE');
  f.provision(staff, { expectedProfileVersion: 1, recordVersion: 2, enabled: false, staff: [] });
  await f.restart(); assert.deepEqual((await f.act('execute', a, p.id)).intent.receipt, receipt);
  assert.equal((await f.request('/staff/eggs/batch/' + made.batchId, staff)).status, 404);
  const text = JSON.stringify(f.logs); assert.equal(text.includes(a.profile.id), false); assert.equal(text.includes(made.batchId), false); assert.equal(text.includes('synthetic-source'), false);
});

test('revision conflicts, overflow, removed grants and archived records never partially consume production', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), made = await f.register(staff);
  assert.equal((await f.collect(a, made.batchId, 99)).code, 'REVISION_CONFLICT');
  f.database(db => { const row = db.prepare('SELECT state_json FROM users WHERE id = ?').get(a.profile.id), data = JSON.parse(row.state_json); data.system.inventory.eggs = Number.MAX_SAFE_INTEGER; db.prepare('UPDATE users SET state_json = ? WHERE id = ?').run(JSON.stringify(data), a.profile.id); });
  assert.equal((await f.collect(a, made.batchId)).code, 'ASSET_LIMIT');
  assert.equal((await f.ok('/eggs/batch/' + made.batchId, a)).batch.status, 'available');
  assert.equal((await f.ok('/bootstrap', a)).revision, 0);
  f.provision(staff, { expectedProfileVersion: 1, staff: [] });
  assert.equal((await f.command(staff, { domain: 'eggs', action: 'withdraw', batchId: made.batchId, expectedBatchVersion: 1 }, 'staff')).code, 'NOT_FOUND');
  f.put(a.profile.id, 1, { status: 'archived', observedAt: f.now });
  assert.equal((await f.collect(a, made.batchId)).code, 'RECORD_CHANGED');
});

test('currently authorized record staff may withdraw an archived available batch without issuing assets', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), made = await f.register(staff), before = await f.ok('/bootstrap', a);
  f.put(a.profile.id, 1, { status: 'archived', observedAt: f.now });
  assert.equal((await f.ok('/staff/eggs/batch/' + made.batchId, staff)).permissions.canWithdraw, true);
  assert.equal((await f.command(staff, { domain: 'eggs', action: 'withdraw', batchId: made.batchId, expectedBatchVersion: 1 }, 'staff')).code, 'OK');
  assert.equal((await f.ok('/eggs/batch/' + made.batchId, a)).batch.status, 'withdrawn');
  const after = await f.ok('/bootstrap', a); assert.equal(after.revision, before.revision); assert.deepEqual(after.system, before.system);
});

test('uncollected production does not permanently block account deletion; staff references are removed', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(); await f.register(staff);
  const deletion = await f.ok('/account/deletion/prepare', a, { expectedRevision: 0 });
  assert.equal((await f.ok('/account/deletion/confirm', null, { confirmationToken: deletion.confirmationToken })).deleted, true);
  assert.equal(f.database(db => db.prepare('SELECT COUNT(*) AS n FROM eggs_batches').get().n), 0);
  assert.equal((await f.ok('/staff/eggs/records/start', staff)).items.length, 0);
});

test('staff deletion anonymizes the current production references and revokes all independent record grants', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), made = await f.register(staff);
  const deletion = await f.ok('/account/deletion/prepare', staff, { expectedRevision: 0 });
  assert.equal((await f.ok('/account/deletion/confirm', null, { confirmationToken: deletion.confirmationToken })).deleted, true);
  f.database(db => { const r = db.prepare('SELECT recorded_by,withdrawn_by FROM eggs_batches WHERE id = ?').get(made.batchId); assert.equal(r.recorded_by, null); assert.equal(r.withdrawn_by, null); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM eggs_grants WHERE account_id = ?').get(staff.profile.id).n, 0); assert.equal(validateEggsDatabase(db, f.now), true); });
  assert.equal((await f.collect(a, made.batchId)).code, 'OK');
  assert.equal(f.database(db => validateEggsDatabase(db, f.now)), true);
});

test('production identities fail closed without creating an eggs profile', async t => {
  const f = await fixture(t, { mode: 'production', allowDevelopmentAuth: false });
  const a = f.app.store.createIdentity('weixin', 'synthetic-prod-eggs', f.app.store.serverNow());
  assert.equal((await f.ok('/eggs/status', a)).available, false);
  assert.equal((await f.request('/eggs/batches/start', a)).status, 503);
});

test('backup verification rejects changed issued assets and the missing original harvest event', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), made = await f.register(staff); await f.collect(a, made.batchId);
  assert.equal(f.database(db => validateEggsDatabase(db, f.now)), true);
  for (const corrupt of [s => { s.system.eventIds = s.system.eventIds.filter(x => x !== 'eggs-' + made.batchId); }, s => { s.system.inventory.eggs = 4; }, s => { s.system.stats.harvest = 0; }]) {
    f.database(db => { const original = db.prepare('SELECT state_json FROM users WHERE id = ?').get(a.profile.id).state_json, s = JSON.parse(original); corrupt(s); db.prepare('UPDATE users SET state_json = ? WHERE id = ?').run(JSON.stringify(s), a.profile.id); assert.throws(() => validateEggsDatabase(db, f.now)); db.prepare('UPDATE users SET state_json = ? WHERE id = ?').run(original, a.profile.id); });
  }
});

test('backup verification binds available production to the original register quantity and source', async t => {
  const f = await fixture(t), { staff } = await f.seed(), made = await f.register(staff);
  for (const patch of [{ quantity: 6 }, { sourceRef: 'synthetic-forged-0001' }]) {
    f.database(db => {
      const original = db.prepare('SELECT data_json,source_ref FROM eggs_batches WHERE id = ?').get(made.batchId), b = { ...JSON.parse(original.data_json), ...patch };
      db.prepare('UPDATE eggs_batches SET data_json = ?, source_ref = ? WHERE id = ?').run(JSON.stringify(b), b.sourceRef, made.batchId);
      assert.throws(() => validateEggsDatabase(db, f.now), 'stored batch must agree with its original command');
      db.prepare('UPDATE eggs_batches SET data_json = ?, source_ref = ? WHERE id = ?').run(original.data_json, original.source_ref, made.batchId);
    });
  }
});

for (const status of ['available', 'withdrawn']) test(`backup rejects a missing ${status} batch while its original customer and record remain`, async t => {
  const f = await fixture(t), { staff } = await f.seed(), made = await f.register(staff);
  if (status === 'withdrawn') assert.equal((await f.command(staff, { domain: 'eggs', action: 'withdraw', batchId: made.batchId, expectedBatchVersion: 1 }, 'staff')).code, 'OK');
  assert.equal(inspectApplicationDatabase(f.file), 10);
  f.database(db => { db.prepare('DELETE FROM eggs_batches WHERE id = ?').run(made.batchId); });
  assert.throws(() => inspectApplicationDatabase(f.file), 'a live customer production batch cannot disappear behind historical staff receipts');
});

test('deleted registering staff, surviving withdrawer and then deleted customer leave valid minimal backup history', async t => {
  const f = await fixture(t), { a, staff } = await f.seed(), other = await f.login('eggs-withdrawer');
  f.provision(staff, { expectedProfileVersion: 1, staff: [{ accountId: staff.profile.id, role: 'record' }, { accountId: other.profile.id, role: 'record' }] });
  const made = await f.register(staff, { expectedProfileVersion: 2 });
  async function deleteAccount(auth) { const snapshot = await f.ok('/bootstrap', auth), deletion = await f.ok('/account/deletion/prepare', auth, { expectedRevision: snapshot.revision }); assert.equal((await f.ok('/account/deletion/confirm', null, { confirmationToken: deletion.confirmationToken })).deleted, true); }
  await deleteAccount(staff);
  assert.equal((await f.command(other, { domain: 'eggs', action: 'withdraw', batchId: made.batchId, expectedBatchVersion: 1 }, 'staff')).code, 'OK');
  const original = f.database(db => db.prepare("SELECT result_json FROM eggs_commands WHERE owner_id = ? AND json_extract(result_json,'$.action') = 'withdraw'").get(other.profile.id).result_json);
  await deleteAccount(a);
  assert.equal(inspectApplicationDatabase(f.file), 10);
  const output = await mkdtemp(path.join(tmpdir(), 'farm-eggs-deleted-backup-'));
  t.after(async () => { await rm(output, { recursive: true, force: true }); });
  const bundle = path.join(output, 'backup'), restored = path.join(output, 'restored');
  assert.equal((await createBackup({ databasePath: f.file, outputDirectory: bundle })).schemaVersion, 10);
  assert.equal((await verifyBackup({ backupDirectory: bundle })).schemaVersion, 10);
  await restoreBackup({ backupDirectory: bundle, outputDirectory: restored });
  const file = path.join(restored, 'farm.sqlite'); assert.equal(inspectApplicationDatabase(file), 10);
  const db = new DatabaseSync(file); try { assert.equal(db.prepare('SELECT result_json FROM eggs_commands WHERE owner_id = ?').get(other.profile.id).result_json, original); } finally { db.close(); }
});

function privatePath(file, directory = false) {
  if (process.platform !== 'win32') { chmodSync(file, directory ? 0o700 : 0o600); return; }
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $item = Get-Item -LiteralPath $env:EGGS_SYNTHETIC_PATH
    $acl = $item.GetAccessControl(); $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($id in @($owner, 'S-1-5-18', 'S-1-5-32-544')) {
      $sid = New-Object System.Security.Principal.SecurityIdentifier($id)
      if ($item.PSIsContainer) { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow') }
      else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
      $acl.AddAccessRule($rule)
    }
    $item.SetAccessControl($acl)
  `], { env: { ...process.env, EGGS_SYNTHETIC_PATH: file }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, 'synthetic private ACL');
}

test('private eggs CLI requires current existing schema10 and protects explicit inputs', async t => {
  assert.equal(existsSync(new URL('../tools/provision-eggs.mjs', import.meta.url)), true, 'private current-schema provisioning is implemented');
  const { runEggsProvision } = await import('../tools/provision-eggs.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-eggs-cli-')); privatePath(directory, true);
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'synthetic.sqlite'), input = path.join(directory, 'input.json');
  const store = new FarmStore(normalizeConfig({ databasePath: file, mode: 'development', clock: () => NOW })), now = store.serverNow();
  const a = store.createIdentity('development', 'eggs-cli-owner', now), s = store.createIdentity('development', 'eggs-cli-staff', now);
  store.importFarmBatch({ formatVersion: 1, batchId: 'batch-eggs-cli-0001', source: 'synthetic-cli', entries: [{ expectedVersion: 0, record: { id: RECORD, ownerId: a.profile.id, kind: 'animal', name: '合成鸡舍', unitLabel: '鸡舍1', cycleRef: 'synthetic-cycle', status: 'growing', startedAt: NOW, expectedHarvestAt: null, observedAt: NOW, measurements: {} } }] }, now); store.close(); privatePath(file);
  writeFileSync(input, JSON.stringify({ recordId: RECORD, expectedProfileVersion: 0, recordVersion: 1, profile: 'chicken-eggs', enabled: true, maxDailyQuantity: 20, staff: [{ accountId: s.profile.id, role: 'record' }] }), { mode: 0o600 }); privatePath(input);
  const args = ['--database', file, '--environment', 'development', '--input', input];
  assert.throws(() => runEggsProvision([])); assert.throws(() => runEggsProvision([...args, '--input', input]));
  assert.deepEqual(runEggsProvision(args), { ok: true, operation: 'eggs-provision', version: 1, grants: 1 });
  const db = new DatabaseSync(file); db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; PRAGMA user_version = 9'); db.close();
  assert.throws(() => runEggsProvision(args), e => e.code === 'DATABASE_UNAVAILABLE');
  const legacy = new DatabaseSync(file); assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 9); assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'eggs_profiles'").get().n, 0); legacy.close();
});
