import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync,
  lstatSync, mkdirSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { decodeReceipt } from '../src/receipt-codec.mjs';
import { FARM_REGISTRY_TABLE_SQL, FARM_REGISTRY_INDEX_SQL, validateFarmRegistryDatabase } from '../src/farm-registry.mjs';
import { FRIENDS_TABLE_SQL, FRIENDS_INDEX_SQL, validateFriendsDatabase } from '../src/friends.mjs';
import { FORUM_TABLE_SQL, FORUM_INDEX_SQL, validateForumDatabase } from '../src/forum.mjs';
import { PLANTING_TABLE_SQL, PLANTING_INDEX_SQL, validatePlantingDatabase, restorePlantingAuthorization } from '../src/planting.mjs';
import { RECOVERY_TABLE_SQL, RECOVERY_INDEX_SQL, validateRecoveryDatabase, restoreRecoveryDatabase } from '../src/recovery.mjs';
import { EGGS_TABLE_SQL, EGGS_INDEX_SQL, validateEggsDatabase, restoreEggsDatabase } from '../src/eggs.mjs';

const require = createRequire(import.meta.url);
const Systems = require('../../../prototype/systems.js');
const Domain = require('../../../prototype/domain.js');

const DATABASE = 'farm.sqlite';
const MANIFEST = 'manifest.json';
const FORMAT = 1;
const SUPPORTED_SCHEMAS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);
const COLUMNS = {
  server_clock: ['singleton:INTEGER', 'last_time:INTEGER'],
  users: ['id:TEXT', 'environment:TEXT', 'identity_provider:TEXT', 'identity_subject:TEXT', 'display_name:TEXT',
    'state_json:TEXT', 'revision:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  sessions: ['token_hash:TEXT', 'user_id:TEXT', 'created_at:INTEGER', 'expires_at:INTEGER', 'revoked_at:INTEGER'],
  idempotency: ['user_id:TEXT', 'key:TEXT', 'fingerprint:TEXT', 'success_json:TEXT', 'created_at:INTEGER'],
  code_claims: ['code_hash:TEXT', 'provider:TEXT', 'status:TEXT', 'created_at:INTEGER', 'updated_at:INTEGER'],
  deletion_confirmations: ['token_hash:TEXT', 'user_id:TEXT', 'session_hash:TEXT', 'expected_revision:INTEGER', 'expires_at:INTEGER'],
  deletion_receipts: ['token_hash:TEXT', 'completed_at:INTEGER'],
  farm_records: ['environment:TEXT', 'id:TEXT', 'owner_id:TEXT', 'data_json:TEXT', 'version:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  farm_record_events: ['environment:TEXT', 'record_id:TEXT', 'version:INTEGER', 'data_json:TEXT', 'source:TEXT', 'recorded_at:INTEGER'],
  farm_imports: ['environment:TEXT', 'batch_id:TEXT', 'fingerprint:TEXT', 'result_json:TEXT', 'created_at:INTEGER'],
  friends_profiles: ['owner_id:TEXT', 'environment:TEXT', 'peer_id:TEXT', 'code:TEXT', 'enabled:INTEGER', 'version:INTEGER', 'allowance_day:TEXT', 'allowance_count:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  friends_relations: ['environment:TEXT', 'left_id:TEXT', 'right_id:TEXT', 'sender_id:TEXT', 'state:TEXT', 'created_at:INTEGER', 'updated_at:INTEGER'],
  friends_blocks: ['environment:TEXT', 'owner_id:TEXT', 'peer_id:TEXT', 'created_at:INTEGER'],
  friends_commands: ['environment:TEXT', 'owner_id:TEXT', 'key:TEXT', 'fingerprint:TEXT', 'result_json:TEXT', 'created_at:INTEGER'],
  forum_content: ['environment:TEXT', 'id:TEXT', 'owner_id:TEXT', 'kind:TEXT', 'parent_id:TEXT', 'circle:TEXT', 'title:TEXT', 'body:TEXT', 'state:TEXT', 'version:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER', 'published_at:INTEGER', 'reason_code:TEXT'],
  forum_usage: ['owner_id:TEXT', 'environment:TEXT', 'day:TEXT', 'posts:INTEGER', 'comments:INTEGER', 'reports:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  forum_reports: ['environment:TEXT', 'id:TEXT', 'owner_id:TEXT', 'content_id:TEXT', 'reason:TEXT', 'status:TEXT', 'resolution:TEXT', 'version:INTEGER', 'created_at:INTEGER', 'resolved_at:INTEGER'],
  forum_commands: ['environment:TEXT', 'owner_id:TEXT', 'key:TEXT', 'fingerprint:TEXT', 'result_json:TEXT', 'created_at:INTEGER'],
  forum_moderation: ['environment:TEXT', 'batch_id:TEXT', 'operator_id:TEXT', 'decisions_json:TEXT', 'fingerprint:TEXT', 'result_json:TEXT', 'created_at:INTEGER'],
  planting_plans: ['environment:TEXT', 'record_id:TEXT', 'owner_id:TEXT', 'version:INTEGER', 'record_version:INTEGER', 'enabled:INTEGER', 'not_before:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  planting_grants: ['environment:TEXT', 'record_id:TEXT', 'account_id:TEXT', 'role:TEXT', 'staff_ref:TEXT', 'active:INTEGER', 'version:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  planting_orders: ['environment:TEXT', 'id:TEXT', 'record_id:TEXT', 'owner_id:TEXT', 'assignee_id:TEXT', 'status:TEXT', 'version:INTEGER', 'data_json:TEXT', 'created_at:INTEGER', 'updated_at:INTEGER'],
  planting_events: ['environment:TEXT', 'order_id:TEXT', 'version:INTEGER', 'data_json:TEXT'],
  planting_commands: ['environment:TEXT', 'owner_id:TEXT', 'key:TEXT', 'fingerprint:TEXT', 'result_json:TEXT', 'created_at:INTEGER'],
  recovery_epoch: ['singleton:INTEGER', 'epoch:TEXT', 'created_at:INTEGER'],
  recovery_slots: ['owner_id:TEXT', 'environment:TEXT', 'version:INTEGER', 'open_id:TEXT', 'created_at:INTEGER', 'updated_at:INTEGER'],
  planting_intents: ['environment:TEXT', 'id:TEXT', 'owner_id:TEXT', 'prepare_epoch:TEXT', 'prepare_version:INTEGER', 'fingerprint:TEXT', 'audience:TEXT', 'command_json:TEXT', 'operation_key:TEXT', 'phase:TEXT', 'version:INTEGER', 'receipt_json:TEXT', 'created_at:INTEGER', 'updated_at:INTEGER', 'closed_at:INTEGER'],
  eggs_profiles: ['environment:TEXT', 'record_id:TEXT', 'owner_id:TEXT', 'version:INTEGER', 'record_version:INTEGER', 'cycle_ref:TEXT', 'profile:TEXT', 'enabled:INTEGER', 'max_daily_quantity:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  eggs_grants: ['environment:TEXT', 'record_id:TEXT', 'account_id:TEXT', 'role:TEXT', 'active:INTEGER', 'version:INTEGER', 'created_at:INTEGER', 'updated_at:INTEGER'],
  eggs_batches: ['environment:TEXT', 'id:TEXT', 'record_id:TEXT', 'owner_id:TEXT', 'recorded_by:TEXT', 'withdrawn_by:TEXT', 'record_version:INTEGER', 'cycle_ref:TEXT', 'day:TEXT', 'source_ref:TEXT', 'status:TEXT', 'version:INTEGER', 'data_json:TEXT', 'created_at:INTEGER', 'updated_at:INTEGER'],
  eggs_commands: ['environment:TEXT', 'owner_id:TEXT', 'key:TEXT', 'fingerprint:TEXT', 'target_owner_id:TEXT', 'target_record_id:TEXT', 'result_json:TEXT', 'created_at:INTEGER'],
};
const PRIMARY_KEYS = { server_clock: ['singleton'], users: ['id'], sessions: ['token_hash'],
  idempotency: ['user_id', 'key'], code_claims: ['code_hash'], deletion_confirmations: ['token_hash'], deletion_receipts: ['token_hash'],
  farm_records: ['environment', 'id'], farm_record_events: ['environment', 'record_id', 'version'], farm_imports: ['environment', 'batch_id'],
  friends_profiles: ['owner_id'], friends_relations: ['environment', 'left_id', 'right_id'], friends_blocks: ['environment', 'owner_id', 'peer_id'], friends_commands: ['environment', 'owner_id', 'key'],
  forum_content: ['environment', 'id'], forum_usage: ['owner_id'], forum_reports: ['environment', 'id'], forum_commands: ['environment', 'owner_id', 'key'], forum_moderation: ['environment', 'batch_id'],
  planting_plans: ['environment', 'record_id'], planting_grants: ['environment', 'record_id', 'account_id', 'role'],
  planting_orders: ['environment', 'id'], planting_events: ['environment', 'order_id', 'version'], planting_commands: ['environment', 'owner_id', 'key'],
  recovery_epoch: ['singleton'], recovery_slots: ['owner_id', 'environment'], planting_intents: ['environment', 'id'],
  eggs_profiles: ['environment', 'record_id'], eggs_grants: ['environment', 'record_id', 'account_id', 'role'],
  eggs_batches: ['environment', 'id'], eggs_commands: ['environment', 'owner_id', 'key'] };
// A versioned schema contract includes constraints and indexes: table_info and
// foreign_key_check alone cannot detect removed UNIQUE/CHECK constraints or an
// added index which changes which future application writes can succeed.
const TABLE_SQL = {
  ...FARM_REGISTRY_TABLE_SQL,
  ...FRIENDS_TABLE_SQL,
  ...FORUM_TABLE_SQL,
  ...PLANTING_TABLE_SQL,
  ...RECOVERY_TABLE_SQL,
  ...EGGS_TABLE_SQL,
  server_clock: `CREATE TABLE server_clock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_time INTEGER NOT NULL)`,
  users: `CREATE TABLE users (id TEXT PRIMARY KEY, environment TEXT NOT NULL, identity_provider TEXT NOT NULL,
    identity_subject TEXT NOT NULL, display_name TEXT NOT NULL, state_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (environment, identity_provider, identity_subject))`,
  sessions: `CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`,
  idempotency: `CREATE TABLE idempotency (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, success_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, key))`,
  code_claims: `CREATE TABLE code_claims (code_hash TEXT PRIMARY KEY, provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'used', 'failed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  deletion_confirmations: `CREATE TABLE deletion_confirmations (token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id), session_hash TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0), expires_at INTEGER NOT NULL)`,
  deletion_receipts: `CREATE TABLE deletion_receipts (token_hash TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)`,
};

function normalizedSql(sql) {
  if (typeof sql !== 'string') return null;
  const tokens = (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\s]/g) ?? [])
    .map(token => token.startsWith("'") ? token : token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"').toLowerCase()
      : token.startsWith('`') ? token.slice(1, -1).replaceAll('``', '`').toLowerCase()
        : token.startsWith('[') ? token.slice(1, -1).toLowerCase() : token.toLowerCase());
  if (tokens[0] === 'create' && ['table', 'index'].includes(tokens[1]) && tokens.slice(2, 5).join(' ') === 'if not exists') tokens.splice(2, 3);
  if (tokens.slice(0, 3).join(' ') === 'create unique index' && tokens.slice(3, 6).join(' ') === 'if not exists') tokens.splice(3, 3);
  if (tokens.at(-1) === ';') tokens.pop();
  return JSON.stringify(tokens);
}

function validateIndexes(db, tables) {
  const expected = {};
  for (const table of tables) {
    if (!['server_clock', 'recovery_epoch'].includes(table)) expected[`sqlite_autoindex_${table}_1`] = { table, sql: null, columns: PRIMARY_KEYS[table], origin: 'pk', unique: 1 };
  }
  expected.sqlite_autoindex_users_2 = { table: 'users', sql: null,
    columns: ['environment', 'identity_provider', 'identity_subject'], origin: 'u', unique: 1 };
  expected.sessions_expiry = { table: 'sessions', sql: 'CREATE INDEX sessions_expiry ON sessions(expires_at)',
    columns: ['expires_at'], origin: 'c', unique: 0 };
  if (tables.includes('deletion_confirmations')) expected.deletion_confirmations_user = { table: 'deletion_confirmations',
    sql: 'CREATE INDEX deletion_confirmations_user ON deletion_confirmations(user_id)', columns: ['user_id'], origin: 'c', unique: 0 };
  if (tables.includes('farm_records')) expected.farm_records_owner = { table: 'farm_records',
    sql: FARM_REGISTRY_INDEX_SQL.farm_records_owner, columns: ['owner_id', 'environment', 'id'], origin: 'c', unique: 0 };
  if (tables.includes('friends_profiles')) {
    expected.sqlite_autoindex_friends_profiles_2 = { table: 'friends_profiles', sql: null, columns: ['peer_id'], origin: 'u', unique: 1 };
    expected.sqlite_autoindex_friends_profiles_3 = { table: 'friends_profiles', sql: null, columns: ['code'], origin: 'u', unique: 1 };
    for (const [name, table, columns] of [['friends_relations_left', 'friends_relations', ['left_id', 'environment']],
      ['friends_relations_right', 'friends_relations', ['right_id', 'environment']], ['friends_blocks_peer', 'friends_blocks', ['peer_id', 'environment']]]) {
      expected[name] = { table, sql: FRIENDS_INDEX_SQL[name], columns, origin: 'c', unique: 0 };
    }
  }
  if (tables.includes('forum_content')) {
    expected.sqlite_autoindex_forum_reports_2 = { table: 'forum_reports', sql: null, columns: ['environment', 'owner_id', 'content_id'], origin: 'u', unique: 1 };
    for (const [name, table, columns] of [
      ['forum_content_feed', 'forum_content', ['environment', 'kind', 'state', 'created_at', 'id']],
      ['forum_content_owner', 'forum_content', ['owner_id', 'environment', 'created_at', 'id']],
      ['forum_content_parent', 'forum_content', ['environment', 'parent_id', 'created_at', 'id']],
      ['forum_reports_owner', 'forum_reports', ['owner_id', 'environment', 'created_at', 'id']]]) expected[name] = { table, sql: FORUM_INDEX_SQL[name], columns, origin: 'c', unique: 0 };
  }
  if (tables.includes('planting_plans')) {
    expected.planting_one_active = { table: 'planting_orders', sql: PLANTING_INDEX_SQL.planting_one_active,
      columns: ['environment', 'record_id'], origin: 'c', unique: 1, partial: 1 };
    for (const [name, table, columns] of [
      ['planting_orders_owner', 'planting_orders', ['owner_id', 'environment', 'id']],
      ['planting_orders_assignee', 'planting_orders', ['assignee_id', 'environment', 'id']],
      ['planting_grants_account', 'planting_grants', ['account_id', 'environment', 'active']]]) expected[name] = { table, sql: PLANTING_INDEX_SQL[name], columns, origin: 'c', unique: 0 };
  }
  if (tables.includes('planting_intents')) {
    for (const [name, columns] of [
      ['recovery_prepare_once', ['owner_id', 'environment', 'prepare_epoch', 'prepare_version']],
      ['recovery_operation_once', ['environment', 'owner_id', 'operation_key']],
      ['recovery_one_open', ['owner_id', 'environment']]]) expected[name] = { table: 'planting_intents',
      sql: RECOVERY_INDEX_SQL[name], columns, origin: 'c', unique: 1, partial: name === 'recovery_one_open' ? 1 : 0 };
  }
  if (tables.includes('eggs_profiles')) {
    for (const [name, table, columns, unique, partial] of [
      ['eggs_one_daily_batch', 'eggs_batches', ['environment', 'record_id', 'cycle_ref', 'day'], 1, 1],
      ['eggs_unique_source', 'eggs_batches', ['environment', 'source_ref'], 1, 0],
      ['eggs_batches_owner', 'eggs_batches', ['owner_id', 'environment', 'id'], 0, 0],
      ['eggs_grants_account', 'eggs_grants', ['account_id', 'environment', 'active', 'record_id'], 0, 0],
    ]) expected[name] = { table, sql: EGGS_INDEX_SQL[name], columns, origin: 'c', unique, partial };
  }
  const indexes = db.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index'").all();
  if (!isDeepStrictEqual(indexes.map(index => index.name).sort(), Object.keys(expected).sort())) fail('INVALID_APPLICATION_SCHEMA');
  for (const index of indexes) {
    const contract = expected[index.name];
    if (index.tbl_name !== contract.table || normalizedSql(index.sql) !== normalizedSql(contract.sql)) fail('INVALID_APPLICATION_SCHEMA');
  }
  for (const table of tables) {
    for (const index of db.prepare(`PRAGMA index_list(${table})`).all()) {
      const contract = expected[index.name];
      if (!contract || index.unique !== contract.unique || index.origin !== contract.origin || index.partial !== (contract.partial ?? 0)) fail('INVALID_APPLICATION_SCHEMA');
      const key = db.prepare(`PRAGMA index_xinfo(${index.name})`).all().filter(column => column.key === 1);
      if (!isDeepStrictEqual(key.map(column => column.name), contract.columns) ||
        key.some(column => column.cid < 0 || column.desc !== 0 || column.coll !== 'BINARY')) fail('INVALID_APPLICATION_SCHEMA');
    }
  }
}

export class BackupError extends Error {
  constructor(code) { super(`SQLite backup operation refused: ${code}`); this.name = 'BackupError'; this.code = code; }
}
const fail = code => { throw new BackupError(code); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
    (process.platform === 'win32' && (value.startsWith('\\\\') || path.basename(value).includes(':')))) fail('INVALID_PATH');
  return path.resolve(value);
}

// SQLite's native backup API takes paths. Reject all links/junctions, pin the
// existing chain by file identity, and use a fresh private destination directory.
function captureTree(file, { directory = false } = {}) {
  const entries = [];
  let cursor = file;
  for (;;) {
    let stat;
    try { stat = lstatSync(cursor); } catch { fail('PATH_UNAVAILABLE'); }
    if (stat.isSymbolicLink()) fail('LINK_PATH');
    const mustBeDirectory = cursor !== file || directory;
    if (mustBeDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_FILE_TYPE');
    entries.push({ file: cursor, stat });
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return entries;
}

function assertTree(entries) {
  for (const entry of entries) {
    let current;
    try { current = lstatSync(entry.file); } catch { fail('PATH_CHANGED'); }
    if (current.isSymbolicLink() || !sameFile(current, entry.stat) || current.isDirectory() !== entry.stat.isDirectory() ||
      (current.isFile() && current.nlink !== 1)) fail('PATH_CHANGED');
  }
}

function disjoint(left, right) {
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (contains(left, right) || contains(right, left)) fail('OVERLAPPING_PATHS');
}

function companions(file, allowLive = false) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let stat;
    try { stat = lstatSync(file + suffix); } catch (error) { if (error.code === 'ENOENT') continue; fail('PATH_UNAVAILABLE'); }
    if (!allowLive || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_SQLITE_SIDECAR');
  }
}

function destination(outputDirectory, inputDirectory) {
  const directory = absolute(outputDirectory);
  disjoint(inputDirectory, directory);
  const parents = captureTree(path.dirname(directory), { directory: true });
  try { lstatSync(directory); fail('TARGET_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { directory, parents };
}

function allocate(target) {
  assertTree(target.parents);
  try { mkdirSync(target.directory, { mode: 0o700 }); } catch { fail('TARGET_EXISTS_OR_UNAVAILABLE'); }
  target.tree = captureTree(target.directory, { directory: true });
  return target;
}

function reserve(target, name) {
  assertTree(target.tree);
  const file = path.join(target.directory, name);
  let fd;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch { fail('TARGET_FILE_UNAVAILABLE'); }
  const stat = fstatSync(fd);
  return { file, fd, stat };
}

function assertHeld(file) {
  const tree = captureTree(file.file);
  if (!sameFile(tree[0].stat, file.stat)) fail('PATH_CHANGED');
  return tree;
}

function cleanup(target, files) {
  // Never recurse into a failed or replaced destination. If its identity has
  // changed, leave it for an operator instead of deleting somebody else's data.
  if (!target.tree) return;
  try { assertTree(target.tree); } catch { return; }
  for (const file of files) {
    try { assertHeld(file); unlinkSync(file.file); } catch { /* Preserve replaced files. */ }
  }
  try { rmdirSync(target.directory); } catch { /* A partial private directory may remain. */ }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return; // NTFS durability/ACLs require deployment evidence.
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function openRead(file) {
  const tree = captureTree(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (!sameFile(fstatSync(fd), tree[0].stat)) { closeSync(fd); fail('PATH_CHANGED'); }
  return { file, fd, stat: tree[0].stat, tree };
}

function hashHandle(handle) {
  assertTree(handle.tree ?? assertHeld(handle));
  const stat = fstatSync(handle.fd), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  let position = 0, bytes;
  while ((bytes = readSync(handle.fd, buffer, 0, buffer.length, position)) > 0) {
    hash.update(buffer.subarray(0, bytes)); position += bytes;
  }
  const after = fstatSync(handle.fd);
  if (position !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('DATABASE_CHANGED');
  assertTree(handle.tree ?? assertHeld(handle));
  return { bytes: position, sha256: hash.digest('hex') };
}

function writeAll(fd, buffer, position = 0) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.length - offset) fail('WRITE_STALLED');
    offset += written;
  }
}

function stateObject(json) {
  let state;
  try { state = typeof json === 'string' ? JSON.parse(json) : json; } catch { fail('INVALID_APPLICATION_DATA'); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.wallet || !state.system ||
    !integer(state.wallet.points) || !integer(state.wallet.feed) || !integer(state.system.xp) ||
    !state.system.inventory || typeof state.system.inventory !== 'object' || !Array.isArray(state.system.coupons)) fail('INVALID_APPLICATION_DATA');
  if (!['points', 'feed', 'adToday', 'inviteCount'].every(key => integer(state.wallet[key])) ||
    typeof state.wallet.welcomeClaimed !== 'boolean' || !Array.isArray(state.wallet.receipts) ||
    state.wallet.receipts.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) ||
    new Set(state.wallet.receipts).size !== state.wallet.receipts.length) fail('INVALID_APPLICATION_DATA');
  // The same pure rules validate inventory, cart, coupons, daily state and
  // receipt IDs used by HTTP mutations. No copy of the domain validator.
  try { Systems.syncDay(state.system, 0); } catch { fail('INVALID_APPLICATION_DATA'); }
  return state;
}

function validateReceipt(row, latestTime, schemaVersion) {
  let decoded;
  try { decoded = decodeReceipt(row.success_json, { allowCompressed: schemaVersion >= 4 }); }
  catch { fail('INVALID_APPLICATION_RECEIPT'); }
  const snapshot = stateObject(decoded);
  const fields = ['serverTime', 'revision', 'environment', 'profile', 'wallet', 'system', 'catalog', 'tasks',
    'signIn', 'season', 'achievements', 'level', 'farm', 'capabilities'];
  if (!isDeepStrictEqual(Object.keys(snapshot).sort(), fields.sort()) || snapshot.environment !== row.environment ||
    !integer(snapshot.revision) || snapshot.revision > row.revision || !integer(snapshot.serverTime) ||
    snapshot.serverTime < row.user_created_at || snapshot.serverTime < row.receipt_created_at || snapshot.serverTime > latestTime ||
    !isDeepStrictEqual(snapshot.profile, { id: row.user_id, displayName: row.display_name })) fail('INVALID_APPLICATION_RECEIPT');
  try {
    const sandbox = row.environment === 'development' && row.identity_provider === 'development';
    const derived = { catalog: Systems.getCatalog(), tasks: Systems.getTasks(snapshot.system, snapshot.serverTime),
      signIn: Systems.getSignIn(snapshot.system, snapshot.serverTime), season: Systems.getSeasonStatus(snapshot.system, snapshot.serverTime),
      achievements: Systems.getAchievements(snapshot.system), level: Systems.getLevel(snapshot.system), farm: { plots: [], animals: [] },
      capabilities: { pointShop: sandbox, activities: sandbox, care: false, adoption: false,
        live: false, shipping: false, payments: false, advertising: false } };
    if (snapshot.system.daily.day !== Domain.chinaDayKey(snapshot.serverTime) ||
      Object.entries(derived).some(([key, value]) => !isDeepStrictEqual(snapshot[key], value))) fail('INVALID_APPLICATION_RECEIPT');
  } catch { fail('INVALID_APPLICATION_RECEIPT'); }
}

export function inspectApplicationDatabase(file) { return validateDatabase(file); }

function validateDatabase(file, { standalone = false } = {}) {
  const tree = captureTree(file);
  companions(file, !standalone);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; BEGIN');
    assertTree(tree);
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (!SUPPORTED_SCHEMAS.has(schemaVersion)) fail('UNSUPPORTED_SCHEMA');
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') fail('INTEGRITY_CHECK_FAILED');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_CHECK_FAILED');
    if (standalone && db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('NON_STANDALONE_DATABASE');
    const expected = Object.keys(COLUMNS).filter(name => (schemaVersion >= 3 || !name.startsWith('deletion_')) &&
      (schemaVersion >= 5 || !name.startsWith('farm_')) && (schemaVersion >= 6 || !name.startsWith('friends_')) &&
      (schemaVersion >= 7 || !name.startsWith('forum_')) && (schemaVersion >= 8 || !name.startsWith('planting_')) &&
      (schemaVersion >= 9 || (!name.startsWith('recovery_') && name !== 'planting_intents')) &&
      (schemaVersion >= 10 || !name.startsWith('eggs_'))).sort();
    const schema = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type != 'index'").all();
    if (schema.some(row => row.type !== 'table') || JSON.stringify(schema.map(row => row.name).sort()) !== JSON.stringify(expected)) fail('INVALID_APPLICATION_SCHEMA');
    for (const table of schema) if (normalizedSql(table.sql) !== normalizedSql(TABLE_SQL[table.name])) fail('INVALID_APPLICATION_SCHEMA');
    validateIndexes(db, expected);
    for (const table of expected) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (JSON.stringify(columns.map(column => `${column.name}:${column.type}`)) !== JSON.stringify(COLUMNS[table]) ||
        JSON.stringify(columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name)) !== JSON.stringify(PRIMARY_KEYS[table])) fail('INVALID_APPLICATION_SCHEMA');
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
      const expectedKeys = table === 'farm_record_events'
        ? [{ table: 'farm_records', from: 'environment', to: 'environment' }, { table: 'farm_records', from: 'record_id', to: 'id' }]
        : table === 'farm_records' ? [{ table: 'users', from: 'owner_id', to: 'id' }]
          : ['sessions', 'idempotency', 'deletion_confirmations'].includes(table) ? [{ table: 'users', from: 'user_id', to: 'id' }]
            : ['friends_profiles', 'friends_commands'].includes(table) ? [{ table: 'users', from: 'owner_id', to: 'id' }]
              : table === 'friends_relations' ? [{ table: 'users', from: 'left_id', to: 'id' }, { table: 'users', from: 'right_id', to: 'id' }]
                : table === 'friends_blocks' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'users', from: 'peer_id', to: 'id' }]
                  : ['forum_usage', 'forum_commands'].includes(table) ? [{ table: 'users', from: 'owner_id', to: 'id' }]
                    : table === 'forum_content' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'forum_content', from: 'environment', to: 'environment' }, { table: 'forum_content', from: 'parent_id', to: 'id' }]
                      : table === 'forum_reports' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'forum_content', from: 'environment', to: 'environment' }, { table: 'forum_content', from: 'content_id', to: 'id' }]
                        : table === 'planting_plans' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'farm_records', from: 'environment', to: 'environment' }, { table: 'farm_records', from: 'record_id', to: 'id' }]
                          : table === 'planting_grants' ? [{ table: 'users', from: 'account_id', to: 'id' }, { table: 'planting_plans', from: 'environment', to: 'environment' }, { table: 'planting_plans', from: 'record_id', to: 'record_id' }]
                            : table === 'planting_orders' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'users', from: 'assignee_id', to: 'id' }, { table: 'planting_plans', from: 'environment', to: 'environment' }, { table: 'planting_plans', from: 'record_id', to: 'record_id' }]
                              : table === 'planting_events' ? [{ table: 'planting_orders', from: 'environment', to: 'environment' }, { table: 'planting_orders', from: 'order_id', to: 'id' }]
                                : table === 'planting_commands' ? [{ table: 'users', from: 'owner_id', to: 'id' }]
                                  : table === 'recovery_slots' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'planting_intents', from: 'environment', to: 'environment' }, { table: 'planting_intents', from: 'open_id', to: 'id' }]
                                    : table === 'planting_intents' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'recovery_slots', from: 'owner_id', to: 'owner_id' }, { table: 'recovery_slots', from: 'environment', to: 'environment' }]
                                      : table === 'eggs_profiles' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'farm_records', from: 'environment', to: 'environment' }, { table: 'farm_records', from: 'record_id', to: 'id' }]
                                        : table === 'eggs_grants' ? [{ table: 'users', from: 'account_id', to: 'id' }, { table: 'eggs_profiles', from: 'environment', to: 'environment' }, { table: 'eggs_profiles', from: 'record_id', to: 'record_id' }]
                                          : table === 'eggs_batches' ? [{ table: 'users', from: 'owner_id', to: 'id' }, { table: 'users', from: 'recorded_by', to: 'id' }, { table: 'users', from: 'withdrawn_by', to: 'id' }, { table: 'eggs_profiles', from: 'environment', to: 'environment' }, { table: 'eggs_profiles', from: 'record_id', to: 'record_id' }]
                                            : table === 'eggs_commands' ? [{ table: 'users', from: 'owner_id', to: 'id' }] : [];
      const orderKey = row => row.table + '|' + row.from + '|' + row.to;
      const ordered = rows => rows.map(row => ({ table: row.table, from: row.from, to: row.to })).sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
      if (!isDeepStrictEqual(ordered(foreignKeys), ordered(expectedKeys)) ||
        foreignKeys.some(row => row.on_update !== 'NO ACTION' || row.on_delete !== 'NO ACTION' || row.match !== 'NONE') ||
        (!['friends_relations', 'friends_blocks', 'forum_content', 'forum_reports', 'planting_plans', 'planting_grants', 'planting_orders', 'recovery_slots', 'planting_intents', 'eggs_profiles', 'eggs_grants', 'eggs_batches'].includes(table) && foreignKeys.some(row => row.id !== 0)) ||
        (!['farm_record_events', 'forum_content', 'forum_reports', 'planting_plans', 'planting_grants', 'planting_orders', 'planting_events', 'recovery_slots', 'planting_intents', 'eggs_profiles', 'eggs_grants', 'eggs_batches'].includes(table) && foreignKeys.some(row => row.seq !== 0))) fail('INVALID_APPLICATION_SCHEMA');
    }
    const clock = db.prepare('SELECT singleton, last_time FROM server_clock').all();
    if (clock.length !== 1 || clock[0].singleton !== 1 || !integer(clock[0].last_time)) fail('INVALID_APPLICATION_DATA');
    for (const user of db.prepare('SELECT environment, state_json, revision, created_at, updated_at FROM users').iterate()) {
      if (!['development', 'production'].includes(user.environment) || !integer(user.revision) || !integer(user.created_at) || !integer(user.updated_at)) fail('INVALID_APPLICATION_DATA');
      stateObject(user.state_json);
    }
    for (const row of db.prepare(`SELECT i.success_json, i.user_id, i.created_at AS receipt_created_at,
      u.environment, u.identity_provider, u.display_name, u.revision, u.created_at AS user_created_at
      FROM idempotency AS i JOIN users AS u ON u.id = i.user_id WHERE i.success_json IS NOT NULL`).iterate()) validateReceipt(row, clock[0].last_time, schemaVersion);
    if (db.prepare("SELECT 1 FROM code_claims WHERE status NOT IN ('pending', 'used', 'failed') LIMIT 1").get()) fail('INVALID_APPLICATION_DATA');
    if (schemaVersion >= 5) {
      try { validateFarmRegistryDatabase(db, clock[0].last_time); }
      catch { fail('INVALID_APPLICATION_DATA'); }
    }
    if (schemaVersion >= 6) {
      try { validateFriendsDatabase(db, clock[0].last_time); }
      catch { fail('INVALID_APPLICATION_DATA'); }
    }
    if (schemaVersion >= 7) {
      try { validateForumDatabase(db, clock[0].last_time); }
      catch { fail('INVALID_APPLICATION_DATA'); }
    }
    if (schemaVersion >= 8) {
      try { validatePlantingDatabase(db, clock[0].last_time); }
      catch { fail('INVALID_APPLICATION_DATA'); }
    }
    if (schemaVersion >= 9) {
      try { validateRecoveryDatabase(db, clock[0].last_time, { allowEggs: schemaVersion >= 10 }); }
      catch { fail('INVALID_APPLICATION_DATA'); }
    }
    if (schemaVersion >= 10) {
      try { validateEggsDatabase(db, clock[0].last_time); }
      catch { fail('INVALID_APPLICATION_DATA'); }
    }
    db.exec('ROLLBACK');
    assertTree(tree);
    return schemaVersion;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('INVALID_SQLITE_DATABASE');
  } finally { db?.close(); }
}

function readManifest(directory) {
  const handle = openRead(path.join(directory, MANIFEST));
  try {
    if (handle.stat.size < 2 || handle.stat.size > 4096) fail('INVALID_MANIFEST');
    const buffer = Buffer.alloc(handle.stat.size);
    if (readSync(handle.fd, buffer, 0, buffer.length, 0) !== buffer.length) fail('INVALID_MANIFEST');
    let manifest;
    try { manifest = JSON.parse(buffer.toString('utf8')); } catch { fail('INVALID_MANIFEST'); }
    const keys = ['formatVersion', 'database', 'createdAt', 'schemaVersion', 'bytes', 'sha256'];
    if (!manifest || Array.isArray(manifest) || Object.keys(manifest).length !== keys.length || keys.some(key => !Object.hasOwn(manifest, key)) ||
      manifest.formatVersion !== FORMAT || manifest.database !== DATABASE || !SUPPORTED_SCHEMAS.has(manifest.schemaVersion) ||
      !integer(manifest.bytes) || manifest.bytes < 512 || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      typeof manifest.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.createdAt)) fail('INVALID_MANIFEST');
    assertTree(handle.tree);
    return manifest;
  } finally { closeSync(handle.fd); }
}

function verifiedInput(backupDirectory) {
  const directory = absolute(backupDirectory), tree = captureTree(directory, { directory: true });
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([DATABASE, MANIFEST].sort())) fail('UNEXPECTED_BACKUP_FILES');
  const manifest = readManifest(directory);
  const handle = openRead(path.join(directory, DATABASE));
  try {
    const hashed = hashHandle(handle);
    if (hashed.bytes !== manifest.bytes || hashed.sha256 !== manifest.sha256) fail('HASH_MISMATCH');
    const schemaVersion = validateDatabase(handle.file, { standalone: true });
    if (schemaVersion !== manifest.schemaVersion) fail('SCHEMA_MISMATCH');
    const after = hashHandle(handle);
    if (after.sha256 !== manifest.sha256) fail('HASH_MISMATCH');
    assertTree(tree);
    return { directory, tree, handle, manifest };
  } catch (error) { closeSync(handle.fd); throw error; }
}

const report = (operation, manifest) => Object.freeze({ ok: true, operation, formatVersion: FORMAT,
  schemaVersion: manifest.schemaVersion, bytes: manifest.bytes, sha256: manifest.sha256 });

export async function createBackup({ databasePath, outputDirectory, pagesPerStep = 100 } = {}) {
  if (!Number.isSafeInteger(pagesPerStep) || pagesPerStep < 1 || pagesPerStep > 1000) fail('INVALID_BACKUP_RATE');
  const source = absolute(databasePath), sourceTree = captureTree(source);
  companions(source, true);
  const target = destination(outputDirectory, path.dirname(source));
  validateDatabase(source);
  let db, held, manifestFile, success = false;
  const files = [];
  try {
    allocate(target);
    held = reserve(target, DATABASE); files.push(held);
    db = new DatabaseSync(source, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000');
    assertTree(sourceTree); assertTree(target.tree); assertHeld(held);
    await backup(db, held.file, { rate: pagesPerStep });
    db.close(); db = undefined;
    assertTree(sourceTree); companions(source, true); assertTree(target.tree); assertHeld(held);
    const normalized = new DatabaseSync(held.file);
    try { normalized.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL'); }
    finally { normalized.close(); }
    fsyncSync(held.fd); closeSync(held.fd); held.fd = undefined;
    const schemaVersion = validateDatabase(held.file, { standalone: true });
    const reader = openRead(held.file);
    let hashed;
    try { hashed = hashHandle(reader); } finally { closeSync(reader.fd); }
    const manifest = { formatVersion: FORMAT, database: DATABASE, createdAt: new Date().toISOString(), schemaVersion, ...hashed };
    assertTree(target.tree); assertHeld(held);
    manifestFile = reserve(target, MANIFEST); files.push(manifestFile);
    writeAll(manifestFile.fd, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')); fsyncSync(manifestFile.fd);
    closeSync(manifestFile.fd); manifestFile.fd = undefined;
    assertTree(target.tree); assertHeld(held); assertHeld(manifestFile); syncDirectory(target.directory);
    const completed = verifiedInput(target.directory);
    try { if (!isDeepStrictEqual(completed.manifest, manifest)) fail('INVALID_MANIFEST'); }
    finally { closeSync(completed.handle.fd); }
    success = true;
    return report('backup', manifest);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('BACKUP_IO_FAILED');
  } finally {
    db?.close();
    for (const file of files) if (file.fd !== undefined) closeSync(file.fd);
    if (!success) cleanup(target, files);
  }
}

export async function verifyBackup({ backupDirectory } = {}) {
  const input = verifiedInput(backupDirectory);
  try { return report('verify', input.manifest); } finally { closeSync(input.handle.fd); }
}

export async function restoreBackup({ backupDirectory, outputDirectory } = {}) {
  const sourceDirectory = absolute(backupDirectory);
  const target = destination(outputDirectory, sourceDirectory);
  const input = verifiedInput(sourceDirectory);
  let held, success = false;
  const files = [];
  try {
    allocate(target); held = reserve(target, DATABASE); files.push(held);
    const buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    let position = 0, bytes;
    while ((bytes = readSync(input.handle.fd, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      writeAll(held.fd, buffer.subarray(0, bytes), position);
      position += bytes;
    }
    if (position !== input.manifest.bytes || hash.digest('hex') !== input.manifest.sha256) fail('HASH_MISMATCH');
    fsyncSync(held.fd); closeSync(held.fd); held.fd = undefined;
    assertTree(input.tree); assertTree(input.handle.tree); assertTree(target.tree); assertHeld(held);
    const schemaVersion = validateDatabase(held.file, { standalone: true });
    if (schemaVersion !== input.manifest.schemaVersion) fail('SCHEMA_MISMATCH');
    // A backup predates later logouts/revocations. Never resurrect its bearer
    // sessions or outstanding destructive-action confirmation credentials.
    const restored = new DatabaseSync(held.file);
    try {
      restored.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; DELETE FROM sessions');
      if (schemaVersion >= 3) restored.exec('DELETE FROM deletion_confirmations');
      if (schemaVersion >= 8) restorePlantingAuthorization(restored);
      const now = restored.prepare('SELECT last_time FROM server_clock WHERE singleton=1').get().last_time;
      if (schemaVersion >= 10) restoreEggsDatabase(restored, now);
      if (schemaVersion >= 9) restoreRecoveryDatabase(restored, now, { allowEggs: schemaVersion >= 10 });
      restored.exec('COMMIT');
    } finally { restored.close(); }
    validateDatabase(held.file, { standalone: true });
    const final = openRead(held.file);
    let hashed;
    // SQLite's FULL-synchronous commit above flushes the sanitizing writes.
    // Windows disallows fsync on the read-only verification descriptor.
    try { hashed = hashHandle(final); } finally { closeSync(final.fd); }
    assertHeld(held); syncDirectory(target.directory);
    success = true;
    return Object.freeze({ ...report('restore', { ...input.manifest, ...hashed }),
      sourceSha256: input.manifest.sha256, sessionsInvalidated: true });
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('RESTORE_IO_FAILED');
  } finally {
    closeSync(input.handle.fd);
    for (const file of files) if (file.fd !== undefined) closeSync(file.fd);
    if (!success) cleanup(target, files);
  }
}
