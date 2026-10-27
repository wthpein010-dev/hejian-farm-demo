import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, fsyncSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export class PrivateFileError extends Error {
  constructor(code) { super('Private file operation refused'); this.code = code; }
}
export const privateFileFailure = code => { throw new PrivateFileError(code); };

export function absolutePrivatePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
      (process.platform === 'win32' && (value.startsWith('\\\\') || value.slice(path.parse(value).root.length).includes(':')))) privateFileFailure('INVALID_ARGUMENTS');
  return path.resolve(value);
}

// Native SQLite APIs accept a path rather than the held descriptor. Check every
// ancestor (including junctions) and pin its identity around each native use.
export function capturePrivateTree(file, directory = false) {
  const tree = []; let cursor = file;
  for (;;) {
    let stat; try { stat = lstatSync(cursor); } catch { privateFileFailure('FILE_UNAVAILABLE'); }
    const isDirectory = directory || cursor !== file;
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) privateFileFailure('UNSAFE_FILE');
    tree.push({ file: cursor, stat });
    const parent = path.dirname(cursor); if (parent === cursor) return tree; cursor = parent;
  }
}
export function assertPrivateTree(tree) {
  for (const entry of tree) {
    let current; try { current = lstatSync(entry.file); } catch { privateFileFailure('FILE_CHANGED'); }
    if (!sameFile(current, entry.stat) || current.isSymbolicLink() || current.isFile() !== entry.stat.isFile() ||
        current.isDirectory() !== entry.stat.isDirectory() || (current.isFile() && current.nlink !== 1)) privateFileFailure('FILE_CHANGED');
  }
}
export function assertPrivatePermission(file, stat) {
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) privateFileFailure('UNSAFE_INPUT');
    return;
  }
  // Mode bits do not model Windows ACLs. Only the current user, SYSTEM and
  // local Administrators may have any Allow entry. ACL details stay off stdout.
  const script = `try {
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
    $item = Get-Item -LiteralPath $env:FARM_PRIVATE_FILE_PATH
    $acl = $item.GetAccessControl()
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -eq 'Allow') {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($allowed -notcontains $sid) { exit 1 }
      }
    }
    if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 1 }
    exit 0
  } catch { exit 1 }`;
  const checked = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FARM_PRIVATE_FILE_PATH: file }, stdio: 'pipe', timeout: 10000, windowsHide: true,
  });
  if (checked.error || checked.status !== 0) privateFileFailure('UNSAFE_INPUT');
}
export function holdPrivateFile(file, privateDirectory = false) {
  const tree = capturePrivateTree(file); let fd;
  assertPrivatePermission(file, tree[0].stat);
  if (privateDirectory) assertPrivatePermission(tree[1].file, tree[1].stat);
  assertPrivateTree(tree);
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { privateFileFailure('FILE_UNAVAILABLE'); }
  try {
    const held = { fd, tree, stat: fstatSync(fd) };
    if (!sameFile(held.stat, tree[0].stat)) privateFileFailure('FILE_CHANGED');
    assertPrivateHeld(held); return held;
  } catch (error) { closeSync(fd); throw error; }
}
export function assertPrivateHeld(held, unchanged = false) {
  assertPrivateTree(held.tree);
  const current = fstatSync(held.fd);
  if (!sameFile(current, held.stat) || !current.isFile() || current.nlink !== 1 ||
      (unchanged && (current.size !== held.stat.size || current.mtimeMs !== held.stat.mtimeMs || current.ctimeMs !== held.stat.ctimeMs))) privateFileFailure('FILE_CHANGED');
}
export function readPrivateJson(file, invalidCode, maxBytes = 1024 * 1024) {
  const held = holdPrivateFile(file);
  try {
    if (held.stat.size < 1 || held.stat.size > maxBytes) privateFileFailure('UNSAFE_INPUT');
    const bytes = Buffer.alloc(held.stat.size + 1); let offset = 0, length;
    while ((length = readSync(held.fd, bytes, offset, bytes.length - offset, offset)) > 0) {
      offset += length; if (offset > maxBytes || offset === bytes.length) privateFileFailure('FILE_CHANGED');
    }
    assertPrivateHeld(held, true);
    if (offset !== held.stat.size) privateFileFailure('FILE_CHANGED');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))); }
    catch { privateFileFailure(invalidCode); }
  } finally { closeSync(held.fd); }
}
export function assertSafeSqliteCompanions(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let stat; try { stat = lstatSync(file + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; privateFileFailure('DATABASE_UNAVAILABLE'); }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) privateFileFailure('UNSAFE_FILE');
    assertPrivatePermission(file + suffix, stat);
    const current = lstatSync(file + suffix);
    if (!sameFile(stat, current) || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) privateFileFailure('FILE_CHANGED');
  }
}
export function preparePrivateOutput(file) {
  const tree = capturePrivateTree(path.dirname(file), true);
  assertPrivatePermission(tree[0].file, tree[0].stat);
  assertPrivateTree(tree);
  try { lstatSync(file); privateFileFailure('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { file, tree };
}
export function writeNewPrivateJson(output, value) {
  assertPrivateTree(output.tree);
  assertPrivatePermission(output.tree[0].file, lstatSync(output.tree[0].file));
  assertPrivateTree(output.tree);
  let fd, original;
  try {
    try { fd = openSync(output.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { privateFileFailure(error.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'FILE_UNAVAILABLE'); }
    original = fstatSync(fd);
    const tree = capturePrivateTree(output.file), held = { fd, stat: original, tree };
    if (!sameFile(original, tree[0].stat)) privateFileFailure('FILE_CHANGED');
    assertPrivateTree(output.tree); assertPrivatePermission(output.file, original); assertPrivateHeld(held);
    const bytes = Buffer.from(JSON.stringify(value) + '\n'); let offset = 0;
    while (offset < bytes.length) { const length = writeSync(fd, bytes, offset, bytes.length - offset); if (!length) privateFileFailure('FILE_UNAVAILABLE'); offset += length; }
    fsyncSync(fd); assertPrivateHeld(held); assertPrivateTree(output.tree);
    assertPrivatePermission(output.file, fstatSync(fd)); assertPrivateHeld(held);
  } catch (error) {
    // Never remove an exchanged path or a file that existed before this run.
    try { if (original && sameFile(lstatSync(output.file), original)) unlinkSync(output.file); } catch { /* best effort, no sensitive output */ }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
