import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { RECOVERY_SQL } from '../src/recovery.mjs';

const CLI = fileURLToPath(new URL('../../../tools/provision-planting.mjs', import.meta.url));
const NOW = Date.now() - 60000;
function privatePath(file, directory = false) {
  if (process.platform !== 'win32') { chmodSync(file, directory ? 0o700 : 0o600); return; }
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $item = Get-Item -LiteralPath $env:PLANTING_SYNTHETIC_PATH
    $acl = $item.GetAccessControl()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($id in @($owner, 'S-1-5-18', 'S-1-5-32-544')) {
      $sid = New-Object System.Security.Principal.SecurityIdentifier($id)
      if ($item.PSIsContainer) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      } else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
      $acl.AddAccessRule($rule)
    }
    $item.SetAccessControl($acl)
  `], { env: { ...process.env, PLANTING_SYNTHETIC_PATH: file }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, 'synthetic private ACL');
}
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-planting-cli-')); privatePath(directory, true);
  t.after(() => { assert.equal(path.dirname(directory), tmpdir()); rmSync(directory, { recursive: true }); });
  const database = path.join(directory, 'synthetic.sqlite'), input = path.join(directory, 'provision.json');
  const config = normalizeConfig({ databasePath: database, mode: 'development', clock: () => NOW });
  const store = new FarmStore(config), now = store.serverNow();
  const owner = store.createIdentity('development', 'synthetic-planting-owner', now);
  const dispatch = store.createIdentity('development', 'synthetic-planting-dispatch', now);
  const execute = store.createIdentity('development', 'synthetic-planting-execute', now);
  store.importFarmBatch({ formatVersion: 1, batchId: 'planting-cli-initial', source: 'synthetic-cli', entries: [{ expectedVersion: 0,
    record: { id: 'plot-cli-000001', ownerId: owner.profile.id, kind: 'plot', name: '合成白菜', unitLabel: '合成地块',
      cycleRef: 'synthetic-cycle', status: 'planned', startedAt: null, expectedHarvestAt: null, observedAt: now, measurements: {} } }] }, now);
  store.close(); privatePath(database);
  const provision = { recordId: 'plot-cli-000001', expectedPlanVersion: 0, recordVersion: 1, enabled: true, notBefore: NOW,
    staff: [{ accountId: dispatch.profile.id, role: 'dispatch' }, { accountId: execute.profile.id, role: 'execute' }] };
  const save = value => { writeFileSync(input, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); privatePath(input); };
  save(provision);
  const args = () => ['--database', database, '--environment', 'development', '--input', input];
  const run = (arguments_ = args(), options = {}) => {
    const child = spawnSync(process.execPath, [...(options.preload ? ['--import', pathToFileURL(options.preload).href] : []), CLI, ...arguments_], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, ...options.env }, windowsHide: true,
    });
    assert.equal(child.error, undefined); return { ...child, output: child.stdout + child.stderr };
  };
  return { directory, database, input, config, owner, dispatch, execute, provision, save, args, run };
}
function fixedFailure(result, code) {
  assert.equal(result.status, 1, result.output); assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, operation: 'planting-provision', code });
}

test('provision requires explicit unambiguous private paths and development; production never opens a database', t => {
  const f = fixture(t), before = readFileSync(f.database);
  for (const args of [[], ['--database', f.database, '--input', f.input], [...f.args(), '--unknown'], [...f.args(), '--apply'],
    [...f.args(), '--database', f.database], ['--database', 'relative.sqlite', '--environment', 'development', '--input', f.input],
    ['--database', f.database, '--environment', 'development', '--input', f.database]]) fixedFailure(f.run(args), 'INVALID_ARGUMENTS');
  fixedFailure(f.run(['--database', f.database, '--environment', 'production', '--input', f.input]), 'PLANTING_UNAVAILABLE');
  for (const env of [{ NODE_ENV: 'production' }, { FARM_MODE: 'production' }]) fixedFailure(f.run(f.args(), { env }), 'PLANTING_UNAVAILABLE');
  assert.deepEqual(readFileSync(f.database), before);
});

test('private provisioning installs and replaces the complete grant list without terminal identity leakage', t => {
  const f = fixture(t), applied = f.run();
  assert.equal(applied.status, 0, applied.output);
  assert.deepEqual(JSON.parse(applied.stdout), { ok: true, operation: 'planting-provision', version: 1, grants: 2 });
  for (const privateValue of [f.directory, f.owner.profile.id, f.dispatch.profile.id, f.execute.profile.id, f.provision.recordId]) assert.equal(applied.output.includes(privateValue), false);
  f.save({ ...f.provision, expectedPlanVersion: 1, staff: [{ accountId: f.dispatch.profile.id, role: 'dispatch' }] });
  const replaced = f.run(); assert.equal(replaced.status, 0, replaced.output);
  assert.deepEqual(JSON.parse(replaced.stdout), { ok: true, operation: 'planting-provision', version: 2, grants: 1 });
  const store = new FarmStore(f.config);
  try {
    assert.equal(store.plantingStatus(f.dispatch.profile.id, store.serverNow()).hasStaffAccess, true);
    assert.equal(store.plantingStatus(f.execute.profile.id, store.serverNow()).hasStaffAccess, false);
    assert.equal(store.plantingRecord(f.owner.profile.id, f.provision.recordId, store.serverNow()).enabled, true);
  } finally { store.close(); }
  fixedFailure(f.run(), 'PLAN_CHANGED');
});

test('private provisioning preserves a fully verified schema8 rather than silently adding recovery tables', t => {
  const f = fixture(t), db = new DatabaseSync(f.database);
  db.exec('DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; PRAGMA user_version=8'); db.close();
  const result = f.run(); assert.equal(result.status, 0, result.output);
  const checked = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(checked.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(checked.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE 'recovery_%' OR name='planting_intents'").get().n, 0);
    assert.deepEqual({ ...checked.prepare('SELECT enabled,version FROM planting_plans').get() }, { enabled: 1, version: 1 });
  } finally { checked.close(); }
});

test('private provisioning accepts a verified schema9 and preserves its recovery epoch', t => {
  const f = fixture(t), db = new DatabaseSync(f.database);
  db.exec(RECOVERY_SQL + " INSERT OR IGNORE INTO recovery_epoch VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0); PRAGMA user_version=9");
  const epoch = db.prepare('SELECT epoch FROM recovery_epoch').get().epoch; db.close();
  const result = f.run(); assert.equal(result.status, 0, result.output);
  const checked = new DatabaseSync(f.database, { readOnly: true });
  try { assert.equal(checked.prepare('PRAGMA user_version').get().user_version, 9); assert.equal(checked.prepare('SELECT epoch FROM recovery_epoch').get().epoch, epoch); } finally { checked.close(); }
});

test('malformed oversized and unknown-field input leaves the database unchanged and never echoes private JSON', t => {
  const f = fixture(t), before = readFileSync(f.database), secret = 'SYNTHETIC PRIVATE STAFF LIST';
  for (const value of ['{"secret":"' + secret, { ...f.provision, secret }, { ...f.provision, staff: [...f.provision.staff, f.provision.staff[0]] }]) {
    f.save(value); const refused = f.run(); fixedFailure(refused, 'INVALID_PLANTING_PROVISION'); assert.equal(refused.output.includes(secret), false);
    assert.deepEqual(readFileSync(f.database), before);
  }
  f.save(' '.repeat(1024 * 1024 + 1)); fixedFailure(f.run(), 'UNSAFE_INPUT'); assert.deepEqual(readFileSync(f.database), before);
});

test('provision refuses absent partial old and future databases before any creation or migration', t => {
  const f = fixture(t); rmSync(f.database); fixedFailure(f.run(), 'FILE_UNAVAILABLE'); assert.equal(existsSync(f.database), false);
  for (const version of [7, 8, 9]) {
    const db = new DatabaseSync(f.database); db.exec(`CREATE TABLE users(id TEXT); CREATE TABLE server_clock(last_time INTEGER); PRAGMA user_version=${version}`); db.close(); privatePath(f.database);
    const before = readFileSync(f.database); fixedFailure(f.run(), 'DATABASE_UNAVAILABLE'); assert.deepEqual(readFileSync(f.database), before); rmSync(f.database);
  }
});

test('provision rejects hard links, linked directories and unsafe SQLite companions', t => {
  const f = fixture(t), hard = path.join(f.directory, 'hard.sqlite'); linkSync(f.database, hard);
  fixedFailure(f.run(['--database', hard, '--environment', 'development', '--input', f.input]), 'UNSAFE_FILE'); rmSync(hard);
  linkSync(f.input, f.database + '-wal'); fixedFailure(f.run(), 'UNSAFE_FILE'); rmSync(f.database + '-wal');
  try {
    const linked = path.join(f.directory, 'linked'); symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    fixedFailure(f.run(['--database', path.join(linked, 'synthetic.sqlite'), '--environment', 'development', '--input', f.input]), 'UNSAFE_FILE');
  } catch (error) { if (error.code !== 'EPERM') throw error; }
  const hardInput = path.join(f.directory, 'hard.json'); linkSync(f.input, hardInput); fixedFailure(f.run(), 'UNSAFE_FILE');
});

test('provision rejects public input and database directories before granting staff permissions', t => {
  const f = fixture(t);
  if (process.platform !== 'win32') {
    chmodSync(f.input, 0o644); fixedFailure(f.run(), 'UNSAFE_INPUT'); chmodSync(f.input, 0o600);
    chmodSync(f.directory, 0o755); fixedFailure(f.run(), 'UNSAFE_INPUT');
  } else {
    const publicDirectory = mkdtempSync(path.join(tmpdir(), 'farm-planting-public-'));
    t.after(() => { assert.equal(path.dirname(publicDirectory), tmpdir()); rmSync(publicDirectory, { recursive: true }); });
    const input = path.join(publicDirectory, 'input.json'); writeFileSync(input, JSON.stringify(f.provision));
    fixedFailure(f.run(['--database', f.database, '--environment', 'development', '--input', input]), 'UNSAFE_INPUT');
    const database = path.join(publicDirectory, 'public.sqlite'); writeFileSync(database, readFileSync(f.database)); privatePath(database);
    fixedFailure(f.run(['--database', database, '--environment', 'development', '--input', f.input]), 'UNSAFE_INPUT');
  }
});

test('a private JSON file in a public directory cannot be used to grant authority', t => {
  const f = fixture(t), directory = mkdtempSync(path.join(tmpdir(), 'farm-planting-input-public-'));
  t.after(() => { assert.equal(path.dirname(directory), tmpdir()); rmSync(directory, { recursive: true }); });
  if (process.platform !== 'win32') chmodSync(directory, 0o755);
  const input = path.join(directory, 'private.json'); writeFileSync(input, JSON.stringify(f.provision), { mode: 0o600 }); privatePath(input);
  fixedFailure(f.run(['--database', f.database, '--environment', 'development', '--input', input]), 'UNSAFE_INPUT');
});

test('a complete legacy schema7 is refused without adding schema8 tables or changing any bytes', t => {
  const f = fixture(t), db = new DatabaseSync(f.database);
  db.exec('DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands; PRAGMA user_version=7'); db.close();
  const before=readFileSync(f.database); fixedFailure(f.run(), 'DATABASE_UNAVAILABLE'); assert.deepEqual(readFileSync(f.database), before);
});

test('provision cannot create an unknown staff account or partially install its otherwise valid list', t => {
  const f = fixture(t); f.save({ ...f.provision, staff: [...f.provision.staff, { accountId: 'unknown-synthetic-account', role: 'execute' }] });
  fixedFailure(f.run(), 'ACCOUNT_UNAVAILABLE');
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM planting_plans').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM planting_grants').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
  } finally { db.close(); }
  f.save(f.provision); const result=f.run(); assert.equal(result.status,0,result.output); assert.equal(JSON.parse(result.stdout).version,1);
});

test('replacement during private JSON read is rejected before opening SQLite for writes', t => {
  const f = fixture(t), before = readFileSync(f.database), length = readFileSync(f.input).length;
  const preload = path.join(f.directory, 'swap.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync; let changed = false;
fs.readSync = (...args) => { const result = read(...args); if (!changed && args[1]?.length === ${length + 1}) {
changed = true; fs.renameSync(process.env.PLANTING_SWAP_INPUT, process.env.PLANTING_SWAP_INPUT + '.old');
fs.writeFileSync(process.env.PLANTING_SWAP_INPUT, '{}', { mode: 0o600 }); } return result; }; syncBuiltinESMExports();`);
  fixedFailure(f.run(f.args(), { preload, env: { PLANTING_SWAP_INPUT: f.input } }), 'FILE_CHANGED');
  assert.deepEqual(readFileSync(f.database), before);
});

test('a database replaced during header verification is refused before SQLite writes', t => {
  const f = fixture(t), before = readFileSync(f.database), preload = path.join(f.directory, 'database-swap.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync; let changed = false;
fs.readSync = (...args) => { const result = read(...args); if (!changed && args[1]?.length === 16) {
changed = true; fs.renameSync(process.env.PLANTING_SWAP_DB, process.env.PLANTING_SWAP_DB + '.old');
fs.writeFileSync(process.env.PLANTING_SWAP_DB, 'synthetic replaced database', { mode: 0o600 }); } return result; }; syncBuiltinESMExports();`);
  fixedFailure(f.run(f.args(), { preload, env: { PLANTING_SWAP_DB: f.database } }), 'FILE_CHANGED');
  assert.deepEqual(readFileSync(f.database + '.old'), before); assert.equal(readFileSync(f.database,'utf8'),'synthetic replaced database');
});
