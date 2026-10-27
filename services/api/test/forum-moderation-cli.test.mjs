import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { RECOVERY_SQL } from '../src/recovery.mjs';

const CLI = fileURLToPath(new URL('../../../tools/moderate-forum.mjs', import.meta.url));
const NOW = Date.now() - 60000;
function privatePath(file, directory = false) {
  if (process.platform !== 'win32') { chmodSync(file, directory ? 0o700 : 0o600); return; }
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $item = Get-Item -LiteralPath $env:FORUM_SYNTHETIC_PATH
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
  `], { env: { ...process.env, FORUM_SYNTHETIC_PATH: file }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, 'synthetic private ACL');
}
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'farm-forum-cli-')); privatePath(directory, true);
  t.after(() => { assert.equal(path.dirname(directory), tmpdir()); rmSync(directory, { recursive: true }); });
  const database = path.join(directory, 'synthetic.sqlite'), output = path.join(directory, 'queue.json'), input = path.join(directory, 'batch.json');
  const config = normalizeConfig({ databasePath: database, mode: 'development', clock: () => NOW });
  const store = new FarmStore(config); store.close(); privatePath(database);
  const run = (args, options = {}) => {
    const child = spawnSync(process.execPath, [...(options.preload ? ['--import', pathToFileURL(options.preload).href] : []), CLI, ...args], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, ...options.env }, windowsHide: true,
    });
    assert.equal(child.error, undefined); return { ...child, output: child.stdout + child.stderr };
  };
  const exportArgs = (...extra) => ['--database', database, '--environment', 'development', '--export', '--output', output, ...extra];
  const applyArgs = () => ['--database', database, '--environment', 'development', '--apply', '--input', input];
  const save = value => { writeFileSync(input, JSON.stringify(value), { mode: 0o600 }); privatePath(input); };
  const open = () => new FarmStore(config);
  return { directory, database, output, input, config, run, exportArgs, applyArgs, save, open };
}
const batch = decisions => ({ formatVersion: 1, batchId: 'synthetic-moderation-001', operatorId: 'synthetic-operator', decisions });
const fixedFailure = (result, code) => {
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, operation: 'forum-moderation', code });
  assert.equal(result.stdout, '');
};

test('moderation requires explicit development database and distinct export/apply private paths', t => {
  const f = fixture(t);
  for (const args of [[], ['--environment', 'development', '--export', '--output', f.output],
    ['--database', f.database, '--export', '--output', f.output], f.exportArgs('--apply'),
    f.exportArgs('--input', f.input), f.exportArgs('--database', f.database),
    f.exportArgs('--unknown'), ['--database', 'relative.sqlite', '--environment', 'development', '--export', '--output', f.output],
    ['--database', f.database, '--environment', 'development', '--apply'],
    ['--database', f.database, '--environment', 'development', '--export', '--output', f.database]]) {
    fixedFailure(f.run(args), 'INVALID_ARGUMENTS');
  }
  fixedFailure(f.run(['--database', f.database, '--environment', 'production', '--export', '--output', f.output]), 'FORUM_UNAVAILABLE');
  fixedFailure(f.run(f.exportArgs(), { env: { NODE_ENV: 'production' } }), 'FORUM_UNAVAILABLE');
  assert.equal(existsSync(f.output), false);
});

test('queue export uses a new private file and prints only fixed counts', t => {
  const f = fixture(t), result = f.run(f.exportArgs());
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, operation: 'forum-moderation-export', contents: 0, reports: 0 });
  const queue = JSON.parse(readFileSync(f.output, 'utf8'));
  assert.deepEqual(Object.keys(queue).sort(), ['formatVersion', 'environment', 'serverTime', 'contentState', 'contents', 'reports', 'parents'].sort());
  assert.equal(queue.contentState, 'pending');
  assert.equal(queue.environment, 'development'); assert.deepEqual(queue.contents, []); assert.deepEqual(queue.reports, []);
  assert.deepEqual(queue.parents, []);
  if (process.platform !== 'win32') assert.equal(lstatSync(f.output).mode & 0o077, 0);
  const original = readFileSync(f.output); fixedFailure(f.run(f.exportArgs()), 'OUTPUT_EXISTS');
  assert.deepEqual(readFileSync(f.output), original); assert.equal(result.output.includes(f.directory), false);
});

test('moderation accepts a strictly verified schema9 without changing its recovery epoch', t => {
  const f = fixture(t), db = new DatabaseSync(f.database);
  db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles;' + RECOVERY_SQL + " INSERT OR IGNORE INTO recovery_epoch VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0); PRAGMA user_version=9");
  const epoch = db.prepare('SELECT epoch FROM recovery_epoch').get().epoch; db.close();
  const result = f.run(f.exportArgs()); assert.equal(result.status, 0, result.output);
  const checked = new DatabaseSync(f.database, { readOnly: true });
  try { assert.equal(checked.prepare('PRAGMA user_version').get().user_version, 9); assert.equal(checked.prepare('SELECT epoch FROM recovery_epoch').get().epoch, epoch); } finally { checked.close(); }
});

for (const schema of [7, 8]) test(`moderation accepts a fully verified schema${schema} without silently migrating its database`, t => {
  const f = fixture(t), db = new DatabaseSync(f.database);
  db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch');
  if (schema === 7) db.exec('DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands');
  db.exec(`PRAGMA user_version=${schema}`); db.close();
  const result = f.run(f.exportArgs()); assert.equal(result.status, 0, result.output);
  const checked = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(checked.prepare('PRAGMA user_version').get().user_version, schema);
    assert.equal(checked.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='planting_orders'").get().n, schema === 7 ? 0 : 1);
    assert.equal(checked.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE 'recovery_%' OR name='planting_intents'").get().n, 0);
  } finally { checked.close(); }
});

for (const schema of [7, 8]) test(`schema${schema}-preserving offline Store option rejects a different actual schema and production before changing bytes`, t => {
  const f = fixture(t), original = readFileSync(f.database);
  assert.throws(() => new FarmStore(f.config, { preserveSchemaVersion: schema }));
  assert.deepEqual(readFileSync(f.database), original);
  const db = new DatabaseSync(f.database);
  db.exec('DROP TABLE eggs_commands; DROP TABLE eggs_batches; DROP TABLE eggs_grants; DROP TABLE eggs_profiles; DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch');
  if (schema === 7) db.exec('DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands');
  db.exec(`PRAGMA user_version=${schema}`); db.close();
  const legacy = readFileSync(f.database);
  assert.throws(() => new FarmStore(normalizeConfig({ databasePath: f.database, mode: 'production' }), { preserveSchemaVersion: schema }));
  assert.deepEqual(readFileSync(f.database), legacy);
});

test('moderation never creates missing databases or mutates non-service and future databases', t => {
  const f = fixture(t);
  rmSync(f.database); fixedFailure(f.run(f.exportArgs()), 'FILE_UNAVAILABLE'); assert.equal(existsSync(f.database), false);
  writeFileSync(f.database, 'synthetic private database', { mode: 0o600 }); privatePath(f.database);
  const invalid = readFileSync(f.database); fixedFailure(f.run(f.exportArgs()), 'DATABASE_UNAVAILABLE'); assert.deepEqual(readFileSync(f.database), invalid);
  rmSync(f.database); const db = new DatabaseSync(f.database); db.exec('CREATE TABLE users(id TEXT); CREATE TABLE server_clock(last_time INTEGER); PRAGMA user_version=8'); db.close(); privatePath(f.database);
  const future = readFileSync(f.database); fixedFailure(f.run(f.exportArgs()), 'DATABASE_UNAVAILABLE'); assert.deepEqual(readFileSync(f.database), future);
  assert.equal(existsSync(f.output), false);
});

test('moderation rejects linked DB, output ancestors, and unsafe SQLite companions', t => {
  const f = fixture(t), hard = path.join(f.directory, 'alias.sqlite'); linkSync(f.database, hard);
  fixedFailure(f.run(['--database', hard, '--environment', 'development', '--export', '--output', f.output]), 'UNSAFE_FILE'); rmSync(hard);
  const companion = path.join(f.directory, 'companion'); writeFileSync(companion, 'synthetic', { mode: 0o600 });
  linkSync(companion, f.database + '-wal'); fixedFailure(f.run(f.exportArgs()), 'UNSAFE_FILE'); rmSync(f.database + '-wal');
  try {
    const linked = path.join(f.directory, 'linked'); symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    fixedFailure(f.run(['--database', f.database, '--environment', 'development', '--export', '--output', path.join(linked, 'queue.json')]), 'UNSAFE_FILE');
  } catch (error) { if (error.code !== 'EPERM') throw error; }
  assert.equal(existsSync(f.output), false);
});

test('moderation rejects unsafe DB/input permissions and malformed batches without echoing UGC', t => {
  const f = fixture(t), secret = 'SYNTHETIC PRIVATE FORUM BODY';
  f.save({ ...batch([]), body: secret }); fixedFailure(f.run(f.applyArgs()), 'INVALID_MODERATION_BATCH');
  if (process.platform !== 'win32') {
    chmodSync(f.database, 0o644); fixedFailure(f.run(f.exportArgs()), 'UNSAFE_INPUT'); chmodSync(f.database, 0o600);
    chmodSync(f.input, 0o644); fixedFailure(f.run(f.applyArgs()), 'UNSAFE_INPUT');
  } else {
    const publicDirectory = mkdtempSync(path.join(tmpdir(), 'farm-forum-public-'));
    t.after(() => { assert.equal(path.dirname(publicDirectory), tmpdir()); rmSync(publicDirectory, { recursive: true }); });
    const publicInput = path.join(publicDirectory, 'public.json'); writeFileSync(publicInput, JSON.stringify(batch([])));
    fixedFailure(f.run(['--database', f.database, '--environment', 'development', '--apply', '--input', publicInput]), 'UNSAFE_INPUT');
    fixedFailure(f.run(['--database', f.database, '--environment', 'development', '--export', '--output', path.join(publicDirectory, 'queue.json')]), 'UNSAFE_INPUT');
  }
  assert.equal(existsSync(f.output), false);
});

test('moderation detects input replacement while reading before opening or changing the database', t => {
  const f = fixture(t); f.save(batch([])); const before = readFileSync(f.database), length = readFileSync(f.input).length;
  const preload = path.join(f.directory, 'swap.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync; let swapped = false;
fs.readSync = (...args) => { const result = read(...args); if (!swapped && args[1]?.length === ${length + 1}) {
swapped = true; fs.renameSync(process.env.FORUM_SWAP_INPUT, process.env.FORUM_SWAP_INPUT + '.old');
fs.writeFileSync(process.env.FORUM_SWAP_INPUT, '{}', { mode: 0o600 }); } return result; }; syncBuiltinESMExports();`);
  fixedFailure(f.run(f.applyArgs(), { preload, env: { FORUM_SWAP_INPUT: f.input } }), 'FILE_CHANGED');
  assert.deepEqual(readFileSync(f.database), before);
});

function seedContent(f) {
  const store = f.open(), now = store.serverNow();
  try {
    const owner = store.createIdentity('development', 'synthetic-moderation-author', now);
    store.friendCommand(owner.profile.id, 'enable-synthetic-forum', { action: 'enable', expectedVersion: 0 }, now);
    const posts = ['SYNTHETIC PRIVATE TITLE A', 'SYNTHETIC PRIVATE TITLE B'].map((title, index) => store.forumCommand(owner.profile.id,
      `synthetic-forum-post-${index}`, { action: 'submit-post', circle: 'harvest', title, body: 'SYNTHETIC PRIVATE BODY FOR LOCAL REVIEW' }, now));
    for (const post of posts) assert.equal(post.outcome, 'applied');
    return { owner, posts };
  } finally { store.close(); }
}
const decision = (id, expectedVersion = 1, action = 'approve', kind = 'content', expectedContentVersion) => ({
  kind, id, expectedVersion, ...(kind === 'report' ? { expectedContentVersion } : {}), decision: action, reason: 'other',
});
function exportQueue(f, state) {
  const result = f.run(f.exportArgs(...(state ? ['--state', state] : []))); assert.equal(result.status, 0, result.output);
  const queue = JSON.parse(readFileSync(f.output, 'utf8')); rmSync(f.output); return { queue, result };
}

test('private review exports pending UGC without terminal leakage and applies an atomic replayable batch', t => {
  const f = fixture(t), { posts } = seedContent(f), { queue, result } = exportQueue(f);
  assert.equal(queue.contents.length, 2); assert.equal(queue.contents.every(content => content.author.self === false), true);
  assert.equal(queue.contents.some(content => content.title === 'SYNTHETIC PRIVATE TITLE A'), true);
  assert.equal(result.output.includes('SYNTHETIC'), false); assert.equal(result.output.includes(f.directory), false);
  const decisions = posts.map(post => decision(post.contentId)); f.save(batch(decisions));
  const applied = f.run(f.applyArgs()); assert.equal(applied.status, 0, applied.output);
  assert.deepEqual(JSON.parse(applied.stdout), { ok: true, operation: 'forum-moderation', applied: 2, replayed: false });
  const replay = f.run(f.applyArgs()); assert.equal(replay.status, 0, replay.output);
  assert.deepEqual(JSON.parse(replay.stdout), { ok: true, operation: 'forum-moderation', applied: 2, replayed: true });
  assert.equal(exportQueue(f).queue.contents.length, 0);
  f.save(batch([decision(posts[0].contentId, 2, 'hide')]));
  const conflict = f.run(f.applyArgs()); assert.equal(conflict.status, 1); assert.equal(conflict.output.includes('SYNTHETIC'), false);
  // A fresh stale batch must roll the first valid change back along with the second.
  f.save({ ...batch([decision(posts[0].contentId, 2, 'hide'), decision(posts[1].contentId, 999, 'hide')]), batchId: 'synthetic-stale-batch' });
  assert.equal(f.run(f.applyArgs()).status, 1);
  f.save({ ...batch(posts.map(post => decision(post.contentId, 2, 'hide'))), batchId: 'synthetic-after-rollback' });
  const afterRollback = f.run(f.applyArgs()); assert.equal(afterRollback.status, 0, afterRollback.output);
  assert.equal(JSON.parse(afterRollback.stdout).applied, 2);
});

test('old CLI approval replay after withdrawal never republishes or stores UGC in moderation receipts', t => {
  const f = fixture(t), { owner, posts } = seedContent(f), id = posts[0].contentId;
  f.save(batch([decision(id)])); const applied = f.run(f.applyArgs()); assert.equal(applied.status, 0, applied.output);
  const store = f.open();
  try { assert.equal(store.forumCommand(owner.profile.id, 'synthetic-withdraw-key', { action: 'withdraw', contentId: id, expectedVersion: 2 }, store.serverNow()).outcome, 'applied'); }
  finally { store.close(); }
  const replay = f.run(f.applyArgs()); assert.equal(replay.status, 0, replay.output); assert.equal(JSON.parse(replay.stdout).replayed, true);
  const remaining = exportQueue(f).queue.contents; assert.equal(remaining.length, 1); assert.notEqual(remaining[0].id, id);
  const restored = f.open();
  try {
    const tombstone = restored.forumMine(owner.profile.id, 'start', restored.serverNow()).items.find(content => content.id === id);
    assert.equal(tombstone.state, 'withdrawn'); assert.equal(tombstone.title, ''); assert.equal(tombstone.body, '');
  } finally { restored.close(); }
  const database = new DatabaseSync(f.database, { readOnly: true });
  try {
    const receipts = JSON.stringify(database.prepare('SELECT * FROM forum_moderation').all());
    assert.equal(receipts.includes('SYNTHETIC PRIVATE TITLE'), false); assert.equal(receipts.includes('SYNTHETIC PRIVATE BODY'), false);
  } finally { database.close(); }
  f.save({ ...batch([decision(id, 2, 'hide')]), batchId: 'synthetic-withdrawn-stale' }); assert.equal(f.run(f.applyArgs()).status, 1);
});

test('moderation rejects more than twenty decisions and partial schema7 before opening a writable service', t => {
  const f = fixture(t), decisions = Array.from({ length: 21 }, (_, index) => decision(index.toString(16).padStart(32, '0')));
  f.save(batch(decisions)); fixedFailure(f.run(f.applyArgs()), 'INVALID_MODERATION_BATCH');
  const db = new DatabaseSync(f.database); db.exec('DROP TABLE friends_commands'); db.close();
  const before = readFileSync(f.database); fixedFailure(f.run(f.exportArgs()), 'DATABASE_UNAVAILABLE');
  assert.deepEqual(readFileSync(f.database), before); assert.equal(existsSync(f.output), false);
});

test('export refuses an output created after its initial check without overwriting it', t => {
  const f = fixture(t), preload = path.join(f.directory, 'output-race.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync; let created = false;
fs.openSync = (file, flags, ...args) => { if (!created && file === process.env.FORUM_SWAP_OUTPUT && (flags & fs.constants.O_CREAT)) {
created = true; fs.writeFileSync(file, 'synthetic concurrent occupant', { mode: 0o600, flag: 'wx' }); }
return open(file, flags, ...args); }; syncBuiltinESMExports();`);
  fixedFailure(f.run(f.exportArgs(), { preload, env: { FORUM_SWAP_OUTPUT: f.output } }), 'OUTPUT_EXISTS');
  assert.equal(readFileSync(f.output, 'utf8'), 'synthetic concurrent occupant');
});

test('moderation refuses a database replaced during header verification before SQLite writes', t => {
  const f = fixture(t), before = readFileSync(f.database), preload = path.join(f.directory, 'database-race.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync; let swapped = false;
fs.readSync = (...args) => { const result = read(...args); if (!swapped && args[1]?.length === 16) {
swapped = true; fs.renameSync(process.env.FORUM_SWAP_DB, process.env.FORUM_SWAP_DB + '.old');
fs.writeFileSync(process.env.FORUM_SWAP_DB, 'synthetic replacement db', { mode: 0o600 }); } return result; }; syncBuiltinESMExports();`);
  fixedFailure(f.run(f.exportArgs(), { preload, env: { FORUM_SWAP_DB: f.database } }), 'FILE_CHANGED');
  assert.deepEqual(readFileSync(f.database + '.old'), before);
  assert.equal(readFileSync(f.database, 'utf8'), 'synthetic replacement db'); assert.equal(existsSync(f.output), false);
});

test('export refuses a replaced output directory before writing UGC', t => {
  const f = fixture(t), directory = path.join(f.directory, 'review'); mkdirSync(directory, { mode: 0o700 }); privatePath(directory, true);
  const output = path.join(directory, 'queue.json'), preload = path.join(f.directory, 'directory-race.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync; let swapped = false;
fs.readSync = (...args) => { const result = read(...args); if (!swapped && args[1]?.length === 16) {
swapped = true; fs.renameSync(process.env.FORUM_SWAP_DIRECTORY, process.env.FORUM_SWAP_DIRECTORY + '.old');
fs.mkdirSync(process.env.FORUM_SWAP_DIRECTORY, { mode: 0o700 }); } return result; }; syncBuiltinESMExports();`);
  fixedFailure(f.run(['--database', f.database, '--environment', 'development', '--export', '--output', output],
    { preload, env: { FORUM_SWAP_DIRECTORY: directory } }), 'FILE_CHANGED');
  assert.equal(existsSync(output), false); assert.equal(existsSync(path.join(directory + '.old', 'queue.json')), false);
});

test('private report review hides its current target and resolves exactly one original report', t => {
  const f = fixture(t), { posts } = seedContent(f), id = posts[0].contentId;
  f.save(batch([decision(id)])); assert.equal(f.run(f.applyArgs()).status, 0);
  const store = f.open(); let reportId;
  try {
    const now = store.serverNow(), viewer = store.createIdentity('development', 'synthetic-moderation-reporter', now);
    store.friendCommand(viewer.profile.id, 'synthetic-reporter-enable', { action: 'enable', expectedVersion: 0 }, now);
    assert.equal(store.forumCommand(viewer.profile.id, 'synthetic-report-command', { action: 'report', contentId: id, expectedVersion: 2, reason: 'privacy' }, now).outcome, 'applied');
    reportId = store.forumModerationQueue(now).reports[0].id;
  } finally { store.close(); }
  const queue = exportQueue(f).queue; assert.equal(queue.reports.length, 1);
  assert.equal(queue.reports[0].content.id, id); assert.equal(queue.reports[0].content.title, 'SYNTHETIC PRIVATE TITLE A');
  assert.equal(queue.reports[0].content.author.self, false);
  f.save({ ...batch([decision(id, 2, 'hide')]), batchId: 'synthetic-other-operator-hide' }); assert.equal(f.run(f.applyArgs()).status, 0);
  f.save({ ...batch([decision(id, 3, 'restore')]), batchId: 'synthetic-other-operator-restore' }); assert.equal(f.run(f.applyArgs()).status, 0);
  f.save({ ...batch([decision(reportId, 1, 'hide', 'report', queue.reports[0].content.version)]), batchId: 'synthetic-stale-report-target' });
  fixedFailure(f.run(f.applyArgs()), 'CONTENT_CHANGED');
  const current = exportQueue(f).queue.reports[0]; assert.equal(current.content.version, 4);
  f.save({ ...batch([decision(reportId, 1, 'hide', 'report', current.content.version)]), batchId: 'synthetic-report-review' });
  const applied = f.run(f.applyArgs()); assert.equal(applied.status, 0, applied.output);
  assert.equal(exportQueue(f).queue.reports.length, 0);
  assert.equal(JSON.parse(f.run(f.applyArgs()).stdout).replayed, true);
  const checked = f.open();
  try {
    const content = checked.forumModerationQueue(checked.serverNow()).contents.find(content => content.id === id);
    assert.equal(content, undefined);
  } finally { checked.close(); }
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT state FROM forum_content WHERE id = ?').get(id).state, 'hidden');
    assert.deepEqual({ ...db.prepare('SELECT status, resolution, version FROM forum_reports WHERE id = ?').get(reportId) }, { status: 'resolved', resolution: 'hidden', version: 2 });
  } finally { db.close(); }
});

test('private comment queue includes exactly its parent context and keeps both texts out of stdout', t => {
  const f = fixture(t), { owner, posts } = seedContent(f), id = posts[0].contentId;
  f.save(batch([decision(id)])); assert.equal(f.run(f.applyArgs()).status, 0);
  const store = f.open(); let commentId;
  try {
    const result = store.forumCommand(owner.profile.id, 'synthetic-comment-for-review', { action: 'submit-comment', postId: id, expectedVersion: 2,
      body: 'SYNTHETIC PRIVATE COMMENT CONTEXT' }, store.serverNow()); assert.equal(result.outcome, 'applied'); commentId = result.contentId;
  } finally { store.close(); }
  const { queue, result } = exportQueue(f);
  assert.equal(queue.contents.find(content => content.id === commentId).parentId, id);
  assert.equal(queue.parents.length, 1); assert.equal(queue.parents[0].id, id);
  assert.equal(queue.parents[0].title, 'SYNTHETIC PRIVATE TITLE A'); assert.equal(queue.parents[0].author.self, false);
  assert.equal(result.output.includes('SYNTHETIC'), false);
});

test('operators inspect current published and hidden versions through CLI files before hide and restore', t => {
  const f = fixture(t); seedContent(f);
  const pending = exportQueue(f).queue, chosen = pending.contents.find(content => content.title === 'SYNTHETIC PRIVATE TITLE A');
  f.save({ ...batch([decision(chosen.id, chosen.version)]), batchId: 'synthetic-state-approval' });
  assert.equal(f.run(f.applyArgs()).status, 0);
  const publishedExport = exportQueue(f, 'published'), published = publishedExport.queue.contents.find(content => content.id === chosen.id);
  assert.equal(publishedExport.queue.contentState, 'published'); assert.equal(published.state, 'published'); assert.equal(published.version, 2);
  assert.equal(publishedExport.result.output.includes('SYNTHETIC'), false);
  f.save({ ...batch([decision(published.id, published.version, 'hide')]), batchId: 'synthetic-state-hide' });
  assert.equal(f.run(f.applyArgs()).status, 0);
  const hiddenExport = exportQueue(f, 'hidden'), hidden = hiddenExport.queue.contents.find(content => content.id === chosen.id);
  assert.equal(hiddenExport.queue.contentState, 'hidden'); assert.equal(hidden.state, 'hidden'); assert.equal(hidden.version, 3);
  assert.equal(hiddenExport.result.output.includes('SYNTHETIC'), false);
  f.save({ ...batch([decision(hidden.id, hidden.version, 'restore')]), batchId: 'synthetic-state-restore' });
  assert.equal(f.run(f.applyArgs()).status, 0);
  const restored = exportQueue(f, 'published').queue.contents.find(content => content.id === chosen.id);
  assert.equal(restored.state, 'published'); assert.equal(restored.version, 4);
  const other = exportQueue(f, 'pending').queue.contents[0];
  f.save({ ...batch([decision(other.id, other.version, 'reject')]), batchId: 'synthetic-state-reject' });
  assert.equal(f.run(f.applyArgs()).status, 0);
  const rejected = exportQueue(f, 'rejected').queue;
  assert.equal(rejected.contentState, 'rejected'); assert.equal(rejected.contents[0].state, 'rejected');
  assert.equal(rejected.contents[0].version, 2);
});

test('state filtering refuses unknown duplicate or apply options before any database write', t => {
  const f = fixture(t); f.save(batch([decision('a'.repeat(32))])); const before = readFileSync(f.database);
  for (const state of ['withdrawn', 'all', 'PUBLISHED', '']) fixedFailure(f.run(f.exportArgs('--state', state)), 'INVALID_ARGUMENTS');
  fixedFailure(f.run(f.exportArgs('--state', 'published', '--state', 'hidden')), 'INVALID_ARGUMENTS');
  fixedFailure(f.run([...f.applyArgs(), '--state', 'pending']), 'INVALID_ARGUMENTS');
  assert.deepEqual(readFileSync(f.database), before); assert.equal(existsSync(f.output), false);
});
