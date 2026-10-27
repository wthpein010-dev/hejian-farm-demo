import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeFarmBatch } from '../shared/farm-records.mjs';
import { FarmStore } from '../services/api/src/store.mjs';
import { normalizeConfig } from '../services/api/src/config.mjs';
import { FarmRegistryError } from '../services/api/src/farm-registry.mjs';

const MAX_BYTES = 1024 * 1024;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
class FarmImportCliError extends Error {
  constructor(code) { super('Farm import refused'); this.code = code; }
}
const fail = code => { throw new FarmImportCliError(code); };

function argumentsFor(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--input', '--environment', '--database', '--validate', '--apply'].includes(option) || values.has(option)) fail('INVALID_ARGUMENTS');
    if (option === '--validate' || option === '--apply') values.set(option, true);
    else {
      const value = args[++i];
      if (typeof value !== 'string' || !value.length || value.startsWith('--')) fail('INVALID_ARGUMENTS');
      values.set(option, value);
    }
  }
  if (!values.has('--input') || !['development', 'production'].includes(values.get('--environment')) ||
      values.has('--validate') === values.has('--apply') || values.has('--database') !== values.has('--apply')) fail('INVALID_ARGUMENTS');
  const absolute = value => {
    if (!path.isAbsolute(value) || value.includes('\0') ||
        (process.platform === 'win32' && (value.startsWith('\\\\') || value.slice(path.parse(value).root.length).includes(':')))) fail('INVALID_ARGUMENTS');
    return path.resolve(value);
  };
  return { input: absolute(values.get('--input')), environment: values.get('--environment'), apply: values.has('--apply'),
    database: values.has('--database') ? absolute(values.get('--database')) : null };
}

// Inspect every ancestor, including Windows junctions, before using a native
// SQLite path. An open descriptor pins the file; repeated checks reject swaps.
function captureTree(file) {
  const tree = []; let cursor = file;
  for (;;) {
    let stat; try { stat = lstatSync(cursor); } catch { fail('FILE_UNAVAILABLE'); }
    if (stat.isSymbolicLink() || (cursor === file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) fail('UNSAFE_FILE');
    tree.push({ file: cursor, stat });
    const parent = path.dirname(cursor); if (parent === cursor) return tree; cursor = parent;
  }
}
function assertTree(tree) {
  for (const entry of tree) {
    let current; try { current = lstatSync(entry.file); } catch { fail('FILE_CHANGED'); }
    if (!sameFile(current, entry.stat) || current.isSymbolicLink() || current.isFile() !== entry.stat.isFile() ||
        current.isDirectory() !== entry.stat.isDirectory() || (current.isFile() && current.nlink !== 1)) fail('FILE_CHANGED');
  }
}
function assertPrivate(file, stat) {
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('UNSAFE_INPUT');
    return;
  }
  // Windows mode bits do not represent ACLs. Accept only the current user,
  // SYSTEM and local administrators; never print ACLs, SIDs or the path.
  const script = `try {
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
    $acl = [System.IO.File]::GetAccessControl($env:FARM_IMPORT_PRIVATE_PATH)
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -eq 'Allow') {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($allowed -notcontains $sid) { exit 1 }
      }
    }
    exit 0
  } catch { exit 1 }`;
  const checked = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FARM_IMPORT_PRIVATE_PATH: file }, stdio: 'pipe', timeout: 10000, windowsHide: true,
  });
  if (checked.error || checked.status !== 0) fail('UNSAFE_INPUT');
}
function hold(file, privateInput = false) {
  const tree = captureTree(file); let fd;
  if (privateInput) assertPrivate(file, tree[0].stat);
  assertTree(tree);
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { fail('FILE_UNAVAILABLE'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(stat, tree[0].stat)) fail('FILE_CHANGED');
    assertTree(tree);
    return { fd, tree, stat };
  } catch (error) { closeSync(fd); throw error; }
}
function assertHeld(held, unchanged = false) {
  assertTree(held.tree);
  const current = fstatSync(held.fd);
  if (!sameFile(current, held.stat) || !current.isFile() || current.nlink !== 1 ||
      (unchanged && (current.size !== held.stat.size || current.mtimeMs !== held.stat.mtimeMs || current.ctimeMs !== held.stat.ctimeMs))) fail('FILE_CHANGED');
}
function readInput(file) {
  const held = hold(file, true);
  try {
    if (held.stat.size < 1 || held.stat.size > MAX_BYTES) fail('UNSAFE_INPUT');
    const bytes = Buffer.alloc(held.stat.size + 1); let offset = 0, length;
    while ((length = readSync(held.fd, bytes, offset, bytes.length - offset, offset)) > 0) {
      offset += length; if (offset > MAX_BYTES || offset === bytes.length) fail('FILE_CHANGED');
    }
    assertHeld(held, true);
    if (offset !== held.stat.size) fail('FILE_CHANGED');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))); }
    catch { fail('INVALID_FARM_DATA'); }
    return value;
  } finally { closeSync(held.fd); }
}
function safeCompanions(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let stat; try { stat = lstatSync(file + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; fail('DATABASE_UNAVAILABLE'); }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_FILE');
  }
}
function verifyServiceDatabase(file, held) {
  const header = Buffer.alloc(16);
  if (readSync(held.fd, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0'))) fail('DATABASE_UNAVAILABLE');
  let db;
  try {
    assertHeld(held); safeCompanions(file);
    db = new DatabaseSync(file, { readOnly: true });
    assertHeld(held); safeCompanions(file);
    if (![2, 3, 4, 5, 6, 7].includes(db.prepare('PRAGMA user_version').get().user_version) ||
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'server_clock')").get().n !== 2) fail('DATABASE_UNAVAILABLE');
  } catch (error) {
    if (error instanceof FarmImportCliError) throw error;
    fail('DATABASE_UNAVAILABLE');
  } finally { db?.close(); }
}

export function runFarmImport(args) {
  const options = argumentsFor(args), now = Date.now(), raw = readInput(options.input);
  let normalized;
  try { normalized = normalizeFarmBatch(raw, { environment: options.environment, now }); }
  catch { fail('INVALID_FARM_DATA'); }
  if (!options.apply) return { ok: true, operation: 'farm-import-validate', entries: normalized.entries.length };
  let held;
  try { held = hold(options.database); }
  catch (error) { if (error instanceof FarmImportCliError) throw error; fail('DATABASE_UNAVAILABLE'); }
  let store;
  try {
    verifyServiceDatabase(options.database, held);
    assertHeld(held); safeCompanions(options.database);
    store = new FarmStore(normalizeConfig({ mode: options.environment, databasePath: options.database }));
    assertHeld(held); safeCompanions(options.database);
    const serverTime = store.serverNow();
    assertHeld(held); safeCompanions(options.database);
    const result = store.importFarmBatch(raw, serverTime);
    assertHeld(held); safeCompanions(options.database);
    return result;
  } catch (error) {
    if (error instanceof FarmImportCliError || error instanceof FarmRegistryError) throw error;
    fail('DATABASE_UNAVAILABLE');
  } finally { store?.close(); closeSync(held.fd); }
}

if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(runFarmImport(process.argv.slice(2))) + '\n'); }
  catch (error) {
    const code = error instanceof FarmImportCliError || error instanceof FarmRegistryError ? error.code : 'IMPORT_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, operation: 'farm-import', code }) + '\n');
    process.exitCode = 1;
  }
}
