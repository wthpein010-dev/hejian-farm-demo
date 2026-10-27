import { createHash, randomBytes } from 'node:crypto';
import { isFriendCommand, isFriendsView, isFriendCommandReceipt, isFriendPeerId, isFriendCode } from '../../../shared/friends.mjs';

export const FRIENDS_TABLE_SQL = Object.freeze({
  friends_profiles: `CREATE TABLE IF NOT EXISTS friends_profiles (
    owner_id TEXT PRIMARY KEY REFERENCES users(id), environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
    peer_id TEXT NOT NULL UNIQUE, code TEXT UNIQUE, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL CHECK (version >= 1), allowance_day TEXT NOT NULL, allowance_count INTEGER NOT NULL CHECK (allowance_count BETWEEN 0 AND 20),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((enabled = 1 AND code IS NOT NULL) OR (enabled = 0 AND code IS NULL)))`,
  friends_relations: `CREATE TABLE IF NOT EXISTS friends_relations (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), left_id TEXT NOT NULL REFERENCES users(id),
    right_id TEXT NOT NULL REFERENCES users(id), sender_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (environment, left_id, right_id),
    CHECK (left_id < right_id), CHECK (sender_id = left_id OR sender_id = right_id))`,
  friends_blocks: `CREATE TABLE IF NOT EXISTS friends_blocks (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), owner_id TEXT NOT NULL REFERENCES users(id),
    peer_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, PRIMARY KEY (environment, owner_id, peer_id), CHECK (owner_id != peer_id))`,
  friends_commands: `CREATE TABLE IF NOT EXISTS friends_commands (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), owner_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (environment, owner_id, key))`,
});
export const FRIENDS_INDEX_SQL = Object.freeze({
  friends_relations_left: 'CREATE INDEX IF NOT EXISTS friends_relations_left ON friends_relations(left_id, environment)',
  friends_relations_right: 'CREATE INDEX IF NOT EXISTS friends_relations_right ON friends_relations(right_id, environment)',
  friends_blocks_peer: 'CREATE INDEX IF NOT EXISTS friends_blocks_peer ON friends_blocks(peer_id, environment)',
});
export const FRIENDS_SQL = [...Object.values(FRIENDS_TABLE_SQL), ...Object.values(FRIENDS_INDEX_SQL)].join(';\n') + ';';
const digest = text => createHash('sha256').update(text).digest('hex');
const day = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const randomId = () => randomBytes(16).toString('hex');
const sortedPair = (a, b) => a < b ? [a, b] : [b, a];
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;

// Store owns the surrounding IMMEDIATE transaction and provides fixed-SQL prepared statements.
export function createFriends({ prepare, environment }) {
  const profile = id => prepare('SELECT * FROM friends_profiles WHERE owner_id = ? AND environment = ?').get(id, environment);
  const bump = (ids, now) => {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const p = profile(id);
      if (!p || !Number.isSafeInteger(p.version) || p.version < 1 || p.version >= Number.MAX_SAFE_INTEGER) throw new Error('Friends version unavailable');
    }
    for (const id of unique) prepare('UPDATE friends_profiles SET version = version + 1, updated_at = ? WHERE owner_id = ? AND environment = ?').run(now, id, environment);
  };
  const count = id => prepare('SELECT COUNT(*) AS n FROM friends_relations WHERE environment = ? AND (left_id = ? OR right_id = ?)').get(environment, id, id).n;
  const blocked = (a, b) => prepare('SELECT 1 FROM friends_blocks WHERE environment = ? AND ((owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?))').get(environment, a, b, b, a);
  const relation = (a, b) => prepare('SELECT * FROM friends_relations WHERE environment = ? AND left_id = ? AND right_id = ?').get(environment, ...sortedPair(a, b));
  const deleteRelation = (a, b) => prepare('DELETE FROM friends_relations WHERE environment = ? AND left_id = ? AND right_id = ?').run(environment, ...sortedPair(a, b));
  function clearRelations(id, now) {
    const rows = prepare('SELECT left_id, right_id FROM friends_relations WHERE environment = ? AND (left_id = ? OR right_id = ?)').all(environment, id, id);
    prepare('DELETE FROM friends_relations WHERE environment = ? AND (left_id = ? OR right_id = ?)').run(environment, id, id);
    bump(rows.map(row => row.left_id === id ? row.right_id : row.left_id), now);
  }
  function view(user, now) {
    const available = user.environment === 'development' && user.identity_provider === 'development', p = available ? profile(user.id) : null;
    const output = { friendsFormat: 1, ownerId: user.id, environment, serverTime: now, version: p?.version ?? 0,
      available, enabled: !!p?.enabled, profile: p?.enabled ? { code: p.code, alias: '农友' + p.peer_id.slice(0, 8) } : null,
      friends: [], incoming: [], outgoing: [], blocked: [] };
    if (p?.enabled) {
      for (const row of prepare(`SELECT r.*, p.peer_id FROM friends_relations r JOIN friends_profiles p ON p.owner_id = CASE WHEN r.left_id = ? THEN r.right_id ELSE r.left_id END
        WHERE r.environment = ? AND p.environment = ? AND (r.left_id = ? OR r.right_id = ?) ORDER BY p.peer_id`).all(user.id, environment, environment, user.id, user.id)) {
        output[row.state === 'accepted' ? 'friends' : row.sender_id === user.id ? 'outgoing' : 'incoming'].push({ peerId: row.peer_id, alias: '农友' + row.peer_id.slice(0, 8), createdAt: row.created_at });
      }
      for (const row of prepare(`SELECT b.created_at, p.peer_id FROM friends_blocks b JOIN friends_profiles p ON p.owner_id = b.peer_id
        WHERE b.environment = ? AND p.environment = ? AND b.owner_id = ? ORDER BY p.peer_id`).all(environment, environment, user.id)) {
        output.blocked.push({ peerId: row.peer_id, alias: '农友' + row.peer_id.slice(0, 8), createdAt: row.created_at });
      }
    }
    if (!isFriendsView(output, user.id, environment)) throw new Error('Friends data unavailable');
    return output;
  }
  function command(user, key, input, now) {
    if (!isFriendCommand(input)) throw new TypeError('Invalid friend command');
    const fingerprint = digest(JSON.stringify({ action: input.action, expectedVersion: input.expectedVersion,
      ...(input.action === 'request' ? { code: input.code } : Object.hasOwn(input, 'peerId') ? { peerId: input.peerId } : {}) }));
    const receipt = (code = 'OK') => ({ friendsFormat: 1, ownerId: user.id, environment, operationKey: key, action: input.action,
      outcome: code === 'OK' ? 'applied' : 'refused', code, completedAt: now });
    const previous = prepare('SELECT fingerprint, result_json FROM friends_commands WHERE environment = ? AND owner_id = ? AND key = ?').get(environment, user.id, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return receipt('IDEMPOTENCY_CONFLICT');
      const result = JSON.parse(previous.result_json);
      if (!isFriendCommandReceipt(result, user.id, environment, key, input.action) ||
        ((environment !== 'development' || user.identity_provider !== 'development') && (result.outcome !== 'refused' || result.code !== 'FRIENDS_UNAVAILABLE'))) throw new Error('Friends receipt unavailable');
      return result;
    }
    const apply = () => {
      if (environment !== 'development' || user.identity_provider !== 'development') return 'FRIENDS_UNAVAILABLE';
      let p = profile(user.id);
      if (input.expectedVersion !== (p?.version ?? 0)) return 'FRIENDS_CHANGED';
      if (input.action === 'enable') {
        if (!p) prepare('INSERT INTO friends_profiles (owner_id, environment, peer_id, code, enabled, version, allowance_day, allowance_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, 0, ?, ?)')
          .run(user.id, environment, randomId(), randomId(), day(now), now, now);
        else if (!p.enabled) {
          bump([user.id], now);
          prepare('UPDATE friends_profiles SET enabled = 1, code = ? WHERE owner_id = ? AND environment = ?').run(randomId(), user.id, environment);
        }
        return 'OK';
      }
      if (!p?.enabled) return 'FRIENDS_DISABLED';
      if (input.action === 'disable') {
        clearRelations(user.id, now);
        const peers = prepare('SELECT peer_id FROM friends_blocks WHERE environment = ? AND owner_id = ?').all(environment, user.id);
        prepare('DELETE FROM friends_blocks WHERE environment = ? AND owner_id = ?').run(environment, user.id);
        bump([user.id], now);
        prepare('UPDATE friends_profiles SET enabled = 0, code = NULL WHERE owner_id = ? AND environment = ?').run(user.id, environment);
        bump(peers.map(row => row.peer_id), now); return 'OK';
      }
      const other = input.action === 'request'
        ? prepare('SELECT p.* FROM friends_profiles p JOIN users u ON u.id = p.owner_id WHERE p.environment = ? AND p.code = ? AND p.enabled = 1 AND u.identity_provider = ? AND u.environment = ?').get(environment, input.code, 'development', environment)
        : prepare('SELECT * FROM friends_profiles WHERE environment = ? AND peer_id = ?').get(environment, input.peerId);
      const r = other && other.owner_id !== user.id ? relation(user.id, other.owner_id) : null;
      if (input.action === 'request') {
        if (!other || other.owner_id === user.id || blocked(user.id, other.owner_id)) return 'PEER_UNAVAILABLE';
        if (r) return r.state === 'accepted' ? 'ALREADY_FRIENDS' : 'ALREADY_PENDING';
        if (count(user.id) >= 200 || count(other.owner_id) >= 200) return 'FRIEND_LIMIT';
        if (p.allowance_day === day(now) && p.allowance_count >= 20) return 'DAILY_REQUEST_LIMIT';
        prepare('UPDATE friends_profiles SET allowance_day = ?, allowance_count = CASE WHEN allowance_day = ? THEN allowance_count + 1 ELSE 1 END WHERE owner_id = ? AND environment = ?')
          .run(day(now), day(now), user.id, environment);
        prepare('INSERT INTO friends_relations (environment, left_id, right_id, sender_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(environment, ...sortedPair(user.id, other.owner_id), user.id, 'pending', now, now);
        bump([user.id, other.owner_id], now); return 'OK';
      }
      if (input.action === 'unblock') {
        if (!other || !prepare('SELECT 1 FROM friends_blocks WHERE environment = ? AND owner_id = ? AND peer_id = ?').get(environment, user.id, other.owner_id)) return 'BLOCK_NOT_FOUND';
        prepare('DELETE FROM friends_blocks WHERE environment = ? AND owner_id = ? AND peer_id = ?').run(environment, user.id, other.owner_id);
        bump([user.id, other.owner_id], now); return 'OK';
      }
      if (input.action === 'block') {
        if (!r) return 'RELATION_NOT_FOUND';
        if (prepare('SELECT COUNT(*) AS n FROM friends_blocks WHERE environment = ? AND owner_id = ?').get(environment, user.id).n >= 200) return 'BLOCK_LIMIT';
        deleteRelation(user.id, other.owner_id);
        prepare('INSERT INTO friends_blocks (environment, owner_id, peer_id, created_at) VALUES (?, ?, ?, ?)').run(environment, user.id, other.owner_id, now);
        bump([user.id, other.owner_id], now); return 'OK';
      }
      if (input.action === 'remove') {
        if (r?.state !== 'accepted') return 'RELATION_NOT_FOUND';
      } else if (!r || r.state !== 'pending' || (input.action === 'cancel' ? r.sender_id !== user.id : r.sender_id === user.id)) return 'REQUEST_NOT_FOUND';
      if (input.action === 'accept') prepare('UPDATE friends_relations SET state = ?, updated_at = ? WHERE environment = ? AND left_id = ? AND right_id = ?').run('accepted', now, environment, ...sortedPair(user.id, other.owner_id));
      else deleteRelation(user.id, other.owner_id);
      bump([user.id, other.owner_id], now); return 'OK';
    };
    const result = receipt(apply());
    prepare('INSERT INTO friends_commands (environment, owner_id, key, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(environment, user.id, key, fingerprint, JSON.stringify(result), now);
    return result;
  }
  function deleteOwner(id, now) {
    clearRelations(id, now);
    const affected = prepare('SELECT owner_id, peer_id FROM friends_blocks WHERE environment = ? AND (owner_id = ? OR peer_id = ?)').all(environment, id, id);
    prepare('DELETE FROM friends_blocks WHERE environment = ? AND (owner_id = ? OR peer_id = ?)').run(environment, id, id);
    bump(affected.map(row => row.owner_id === id ? row.peer_id : row.owner_id), now);
    prepare('DELETE FROM friends_commands WHERE environment = ? AND owner_id = ?').run(environment, id);
    prepare('DELETE FROM friends_profiles WHERE environment = ? AND owner_id = ?').run(environment, id);
  }
  // Only the forum's verified, currently visible content path calls this seam.
  // It accepts internal owners, never an arbitrary public author supplied by HTTP.
  function blockFromForum(ownerId, peerOwnerId, now) {
    const a = profile(ownerId), b = profile(peerOwnerId);
    if (!a?.enabled || !b || ownerId === peerOwnerId) throw new Error('Forum block target unavailable');
    if (prepare('SELECT 1 FROM friends_blocks WHERE environment = ? AND owner_id = ? AND peer_id = ?').get(environment, ownerId, peerOwnerId)) return 'OK';
    if (prepare('SELECT COUNT(*) AS n FROM friends_blocks WHERE environment = ? AND owner_id = ?').get(environment, ownerId).n >= 200) return 'BLOCK_LIMIT';
    deleteRelation(ownerId, peerOwnerId);
    prepare('INSERT INTO friends_blocks (environment, owner_id, peer_id, created_at) VALUES (?, ?, ?, ?)').run(environment, ownerId, peerOwnerId, now);
    bump([ownerId, peerOwnerId], now); return 'OK';
  }
  return { view, command, deleteOwner, blockFromForum };
}

export function validateFriendsDatabase(db, now) {
  const invalid = () => { throw new Error('Invalid friends data'); };
  const users = new Map(db.prepare('SELECT id, environment, identity_provider, created_at FROM users').all().map(row => [row.id, row]));
  const profiles = new Map();
  for (const p of db.prepare('SELECT * FROM friends_profiles').all()) {
    const u = users.get(p.owner_id);
    if (!u || u.environment !== p.environment || p.environment !== 'development' || u.identity_provider !== 'development' || !isFriendPeerId(p.peer_id) ||
      ![0, 1].includes(p.enabled) || (p.enabled ? !isFriendCode(p.code) : p.code !== null) || !Number.isSafeInteger(p.version) || p.version < 1 ||
      !validTime(p.created_at) || p.created_at < u.created_at || !validTime(p.updated_at) || p.updated_at < p.created_at || p.updated_at > now ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.allowance_day) || Number.isNaN(Date.parse(p.allowance_day)) || new Date(p.allowance_day).toISOString().slice(0, 10) !== p.allowance_day || p.allowance_day > day(now) ||
      !Number.isSafeInteger(p.allowance_count) || p.allowance_count < 0 || p.allowance_count > 20) invalid();
    profiles.set(p.owner_id, p);
  }
  const active = new Map(), blocks = new Map(), blockedPairs = new Set();
  for (const b of db.prepare('SELECT * FROM friends_blocks').all()) {
    const a = profiles.get(b.owner_id), p = profiles.get(b.peer_id);
    if (!a?.enabled || !p || b.owner_id === b.peer_id || a.environment !== b.environment || p.environment !== b.environment ||
      !validTime(b.created_at) || b.created_at < Math.max(a.created_at, p.created_at) || b.created_at > Math.min(a.updated_at, p.updated_at, now)) invalid();
    const n = (blocks.get(b.owner_id) ?? 0) + 1; if (n > 200) invalid(); blocks.set(b.owner_id, n);
    blockedPairs.add(JSON.stringify([b.environment, ...sortedPair(b.owner_id, b.peer_id)]));
  }
  for (const r of db.prepare('SELECT * FROM friends_relations').all()) {
    const a = profiles.get(r.left_id), b = profiles.get(r.right_id);
    if (!a?.enabled || !b?.enabled || a.environment !== r.environment || b.environment !== r.environment || !(r.left_id < r.right_id) ||
      ![r.left_id, r.right_id].includes(r.sender_id) || !['pending', 'accepted'].includes(r.state) || !validTime(r.created_at) ||
      r.created_at < Math.max(a.created_at, b.created_at) || !validTime(r.updated_at) || r.updated_at < r.created_at || r.updated_at > Math.min(a.updated_at, b.updated_at, now) ||
      blockedPairs.has(JSON.stringify([r.environment, r.left_id, r.right_id]))) invalid();
    for (const id of [r.left_id, r.right_id]) { const n = (active.get(id) ?? 0) + 1; if (n > 200) invalid(); active.set(id, n); }
  }
  for (const row of db.prepare('SELECT * FROM friends_commands').all()) {
    const u = users.get(row.owner_id); let receipt;
    try { receipt = JSON.parse(row.result_json); } catch { invalid(); }
    if (!u || u.environment !== row.environment || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      !isFriendCommandReceipt(receipt, row.owner_id, row.environment, row.key, receipt?.action) ||
      ((row.environment !== 'development' || u.identity_provider !== 'development') && (receipt.outcome !== 'refused' || receipt.code !== 'FRIENDS_UNAVAILABLE')) ||
      receipt.completedAt !== row.created_at || row.created_at < u.created_at || row.created_at > now || JSON.stringify(receipt) !== row.result_json) invalid();
  }
}
