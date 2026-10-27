import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { RECOVERY_SQL } from '../src/recovery.mjs';

const CLI = fileURLToPath(new URL('../../../tools/import-farm-records.mjs', import.meta.url));
const NOW = Date.now() - 60000;
function privateFile(file) {
  if (process.platform !== 'win32') return;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $acl = [System.IO.File]::GetAccessControl($env:FARM_SYNTHETIC_INPUT)
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
    foreach ($id in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $sid = New-Object System.Security.Principal.SecurityIdentifier($id)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [System.IO.File]::SetAccessControl($env:FARM_SYNTHETIC_INPUT, $acl)
  `], { env: { ...process.env, FARM_SYNTHETIC_INPUT: file }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'synthetic input has a private Windows ACL');
}
const input = (ownerId = 'synthetic-owner') => ({ formatVersion: 1, batchId: 'batch-cli-0001', source: 'synthetic-cli', entries: [{
  expectedVersion: 0, record: { id: 'cli-plot-0001', ownerId, kind: 'plot', name: '合成番茄', unitLabel: '合成区',
    cycleRef: 'synthetic-cycle', status: 'planned', startedAt: null, expectedHarvestAt: null, observedAt: NOW, measurements: {} },
}] });
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-import-cli-'));
  t.after(() => { assert.equal(path.dirname(directory), tmpdir()); rmSync(directory, { recursive: true }); });
  const file = path.join(directory, 'private.json');
  const save = value => { writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); privateFile(file); };
  save(input());
  const run = (...args) => {
    const child = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.error, undefined); return { ...child, output: child.stdout + child.stderr };
  };
  return { directory, file, save, run };
}

test('validate requires explicit unambiguous options and never creates or opens a database', t => {
  const f = fixture(t), absent = path.join(f.directory, 'absent.sqlite');
  const validation = f.run('--input', f.file, '--environment', 'development', '--validate');
  assert.equal(validation.status, 0, validation.output);
  assert.deepEqual(JSON.parse(validation.stdout), { ok: true, operation: 'farm-import-validate', entries: 1 });
  for (const args of [[], ['--input', f.file], ['--input', f.file, '--validate'],
    ['--input', f.file, '--environment', 'development', '--validate', '--apply'],
    ['--input', f.file, '--environment', 'development', '--validate', '--database', absent],
    ['--input', f.file, '--environment', 'development', '--apply'],
    ['--input', f.file, '--environment', 'development', '--environment', 'production', '--validate'],
    ['--input', f.file, '--environment', 'development', '--validate', '--unknown']]) {
    const denied = f.run(...args); assert.equal(denied.status, 1); assert.equal(JSON.parse(denied.stderr).code, 'INVALID_ARGUMENTS');
    assert.equal(denied.output.includes(f.directory), false);
  }
  assert.equal(existsSync(absent), false);
});

test('malformed, oversized, linked and non-private inputs are refused with fixed redacted errors', t => {
  const f = fixture(t), run = file => f.run('--input', file, '--environment', 'development', '--validate');
  f.save('{"secret-path":"' + f.directory.replaceAll('\\', '\\\\') + '"');
  assert.equal(run(f.file).status, 1);
  f.save(' '.repeat(1024 * 1024 + 1));
  assert.equal(JSON.parse(run(f.file).stderr).code, 'UNSAFE_INPUT');
  f.save(input());
  const alias = path.join(f.directory, 'hardlink.json'); linkSync(f.file, alias);
  const hard = run(f.file); assert.equal(hard.status, 1); assert.equal(hard.output.includes(f.file), false);
  rmSync(alias);
  const linked = path.join(f.directory, 'symbolic.json');
  try { symlinkSync(f.file, linked, 'file'); assert.equal(run(linked).status, 1); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  if (process.platform !== 'win32') { chmodSync(f.file, 0o644); assert.equal(run(f.file).status, 1); }
  else {
    const publicFile = path.join(f.directory, 'inherited-access.json'); writeFileSync(publicFile, JSON.stringify(input()));
    assert.equal(JSON.parse(run(publicFile).stderr).code, 'UNSAFE_INPUT');
  }
  const invalid = input(); invalid.entries[0].record.address = 'PRIVATE ADDRESS'; f.save(invalid);
  const refused = run(f.file); assert.equal(refused.status, 1);
  assert.equal(refused.output.includes('PRIVATE ADDRESS'), false); assert.equal(refused.output.includes('synthetic-owner'), false);
});

test('apply only targets an existing SQLite service database and cannot create users', async t => {
  const f = fixture(t), missing = path.join(f.directory, 'not-created.sqlite');
  const args = database => ['--input', f.file, '--environment', 'development', '--apply', '--database', database];
  const absent = f.run(...args(missing)); assert.equal(absent.status, 1); assert.equal(existsSync(missing), false);
  const invalid = path.join(f.directory, 'not-sqlite'); writeFileSync(invalid, 'private invalid database', { mode: 0o600 });
  const bytes = readFileSync(invalid); assert.equal(f.run(...args(invalid)).status, 1); assert.deepEqual(readFileSync(invalid), bytes);
  const { FarmStore } = await import('../src/store.mjs');
  const { normalizeConfig } = await import('../src/config.mjs');
  const database = path.join(f.directory, 'service.sqlite');
  const config = normalizeConfig({ databasePath: database, mode: 'development', clock: () => NOW });
  let store = new FarmStore(config); const owner = store.createIdentity('development', 'synthetic-cli', store.serverNow()); store.close();
  const db = new DatabaseSync(database);
  db.exec(RECOVERY_SQL + " INSERT OR IGNORE INTO recovery_epoch VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0); PRAGMA user_version=9"); db.close();
  chmodSync(database, 0o600); f.save(input(owner.profile.id));
  const applied = f.run(...args(database)); assert.equal(applied.status, 0, applied.output);
  assert.deepEqual(JSON.parse(applied.stdout), { ok: true, operation: 'farm-import', created: 1, updated: 0, replayed: false });
  const replay = f.run(...args(database)); assert.equal(replay.status, 0, replay.output); assert.equal(JSON.parse(replay.stdout).replayed, true);
  store = new FarmStore(config);
  try { assert.equal(store.farmPage(owner.profile.id, 'plots', null, Date.now()).items.length, 1); }
  finally { store.close(); }
  f.save(input('missing-owner'));
  const denied = f.run(...args(database)); assert.equal(denied.status, 1); assert.equal(denied.output.includes('missing-owner'), false);
});

test('apply refuses linked database files and unsafe SQLite companion files', async t => {
  const f = fixture(t), { FarmStore } = await import('../src/store.mjs'), { normalizeConfig } = await import('../src/config.mjs');
  const database = path.join(f.directory, 'service.sqlite'), store = new FarmStore(normalizeConfig({ databasePath: database, mode: 'development', clock: () => NOW }));
  const owner = store.createIdentity('development', 'synthetic-link-owner', store.serverNow()); store.close(); f.save(input(owner.profile.id));
  const args = file => ['--input', f.file, '--environment', 'development', '--apply', '--database', file];
  const hard = path.join(f.directory, 'alias.sqlite'); linkSync(database, hard);
  assert.equal(JSON.parse(f.run(...args(hard)).stderr).code, 'UNSAFE_FILE'); rmSync(hard);
  try {
    const symbolic = path.join(f.directory, 'symbolic.sqlite'); symlinkSync(database, symbolic, 'file');
    assert.equal(JSON.parse(f.run(...args(symbolic)).stderr).code, 'UNSAFE_FILE');
  } catch (error) { if (error.code !== 'EPERM') throw error; }
  const companionSource = path.join(f.directory, 'synthetic-companion'); writeFileSync(companionSource, 'synthetic');
  linkSync(companionSource, database + '-wal');
  assert.equal(JSON.parse(f.run(...args(database)).stderr).code, 'UNSAFE_FILE');
  rmSync(database + '-wal');
});

test('farm import retains its explicit apply upgrade contract for an existing schema8 service database', async t => {
  const f = fixture(t), { FarmStore } = await import('../src/store.mjs'), { normalizeConfig } = await import('../src/config.mjs');
  const database = path.join(f.directory, 'legacy-service.sqlite'), store = new FarmStore(normalizeConfig({ databasePath: database, mode: 'development', clock: () => NOW }));
  const owner = store.createIdentity('development', 'synthetic-legacy-import', store.serverNow()); store.close(); f.save(input(owner.profile.id));
  const legacy = new DatabaseSync(database);
  legacy.exec('DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; PRAGMA user_version=8'); legacy.close();
  const applied = f.run('--input', f.file, '--environment', 'development', '--apply', '--database', database);
  assert.equal(applied.status, 0, applied.output);
  const checked = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(checked.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(checked.prepare('SELECT COUNT(*) n FROM recovery_epoch').get().n, 1);
    assert.equal(checked.prepare('SELECT COUNT(*) n FROM farm_records').get().n, 1);
  } finally { checked.close(); }
});

test('input identity is rechecked after a file is exchanged during reading', t => {
  const f = fixture(t), preload = path.join(f.directory, 'synthetic-swap.mjs');
  const original = readFileSync(f.file);
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync; let exchanged = false;
fs.readSync = (...args) => {
  const result = read(...args);
  if (!exchanged && args[1]?.length === ${original.length + 1}) {
    exchanged = true;
    fs.renameSync(process.env.FARM_SYNTHETIC_INPUT, process.env.FARM_SYNTHETIC_INPUT + '.previous');
    fs.writeFileSync(process.env.FARM_SYNTHETIC_INPUT, 'synthetic replacement', { mode: 0o600 });
  }
  return result;
};
syncBuiltinESMExports();`, { mode: 0o600 });
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, CLI, '--input', f.file, '--environment', 'development', '--validate'], {
    env: { ...process.env, FARM_SYNTHETIC_INPUT: f.file }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 1);
  assert.deepEqual(JSON.parse(child.stderr), { ok: false, operation: 'farm-import', code: 'FILE_CHANGED' });
  assert.equal(child.stderr.includes(f.directory), false);
  assert.equal(existsSync(f.file + '.previous'), true);
});
