import { createHash, randomBytes } from 'node:crypto';
import { isEggsCommand, isEggsReceipt, isEggsRecord, isEggsRecordsPage, isEggsPage, isEggsDetail, isEggsId, normalizeEggsProvision } from '../../../shared/eggs.mjs';

// Store owns BEGIN IMMEDIATE; backup consumes these exact definitions.
export const EGGS_TABLE_SQL = Object.freeze({
  eggs_profiles: `CREATE TABLE IF NOT EXISTS eggs_profiles (
    environment TEXT NOT NULL CHECK(environment IN ('development','production')), record_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL CHECK(version >= 1), record_version INTEGER NOT NULL CHECK(record_version >= 1),
    cycle_ref TEXT NOT NULL, profile TEXT NOT NULL CHECK(profile = 'chicken-eggs'), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    max_daily_quantity INTEGER NOT NULL CHECK(max_daily_quantity BETWEEN 1 AND 10000), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(environment,record_id), FOREIGN KEY(environment,record_id) REFERENCES farm_records(environment,id))`,
  eggs_grants: `CREATE TABLE IF NOT EXISTS eggs_grants (
    environment TEXT NOT NULL CHECK(environment IN ('development','production')), record_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role = 'record'), active INTEGER NOT NULL CHECK(active IN (0,1)),
    version INTEGER NOT NULL CHECK(version >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(environment,record_id,account_id,role), FOREIGN KEY(environment,record_id) REFERENCES eggs_profiles(environment,record_id))`,
  eggs_batches: `CREATE TABLE IF NOT EXISTS eggs_batches (
    environment TEXT NOT NULL CHECK(environment IN ('development','production')), id TEXT NOT NULL,
    record_id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), recorded_by TEXT REFERENCES users(id), withdrawn_by TEXT REFERENCES users(id),
    record_version INTEGER NOT NULL CHECK(record_version >= 1), cycle_ref TEXT NOT NULL, day TEXT NOT NULL, source_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('available','collected','withdrawn')), version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2),
    data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(environment,id), FOREIGN KEY(environment,record_id) REFERENCES eggs_profiles(environment,record_id))`,
  eggs_commands: `CREATE TABLE IF NOT EXISTS eggs_commands (
    environment TEXT NOT NULL CHECK(environment IN ('development','production')), owner_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, target_owner_id TEXT, target_record_id TEXT, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    CHECK((target_owner_id IS NULL AND target_record_id IS NULL) OR (target_owner_id IS NOT NULL AND target_record_id IS NOT NULL)),
    PRIMARY KEY(environment,owner_id,key))`,
});
export const EGGS_INDEX_SQL = Object.freeze({
  eggs_one_daily_batch: `CREATE UNIQUE INDEX IF NOT EXISTS eggs_one_daily_batch ON eggs_batches(environment,record_id,cycle_ref,day) WHERE status != 'withdrawn'`,
  eggs_unique_source: `CREATE UNIQUE INDEX IF NOT EXISTS eggs_unique_source ON eggs_batches(environment,source_ref)`,
  eggs_batches_owner: `CREATE INDEX IF NOT EXISTS eggs_batches_owner ON eggs_batches(owner_id,environment,id)`,
  eggs_grants_account: `CREATE INDEX IF NOT EXISTS eggs_grants_account ON eggs_grants(account_id,environment,active,record_id)`,
});
export const EGGS_SQL = [...Object.values(EGGS_TABLE_SQL), ...Object.values(EGGS_INDEX_SQL)].join(';\n') + ';';
export class EggsError extends Error {
  constructor(code = 'INVALID_EGGS_DATA') {
    super('收蛋记录暂不可用'); this.name = 'EggsError'; this.code = ['INVALID_EGGS_DATA', 'NOT_FOUND', 'EGGS_UNAVAILABLE', 'PROFILE_CHANGED', 'RECORD_CHANGED', 'ACCOUNT_UNAVAILABLE', 'RESERVED_OPERATION_KEY'].includes(code) ? code : 'INVALID_EGGS_DATA';
  }
}
const invalid = () => { throw new EggsError(); };
const integer = (x, min = 0) => Number.isSafeInteger(x) && x >= min;
const time = x => integer(x) && x <= 8.64e15;
const exact = (x, re) => typeof x === 'string' && re.test(x) && !/[\r\n]/u.test(x);
const safe = x => exact(x, /^[A-Za-z0-9_-]{1,128}$/u);
const recordId = x => exact(x, /^[a-z0-9][a-z0-9-]{7,63}$/u);
const operationKey = x => exact(x, /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/u);
const available = (u, env) => env === 'development' && u?.environment === env && u.identity_provider === 'development';
const random = () => randomBytes(16).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const day = now => new Date(now + 28800000).toISOString().slice(0, 10);
const canonical = x => Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]));
const increment = x => { if (!integer(x) || x >= Number.MAX_SAFE_INTEGER) invalid(); return x + 1; };

export function createEggs({ prepare, environment, farmRegistry, beforeNewCommand, harvest }) {
  if (typeof prepare !== 'function' || !['development', 'production'].includes(environment) || !farmRegistry?.detail || typeof harvest !== 'function') invalid();
  const account = id => prepare('SELECT id,environment,identity_provider FROM users WHERE id = ?').get(id);
  const profile = id => prepare('SELECT * FROM eggs_profiles WHERE environment = ? AND record_id = ?').get(environment, id);
  const grants = id => prepare('SELECT * FROM eggs_grants WHERE environment = ? AND record_id = ? ORDER BY account_id').all(environment, id);
  const grant = (id, who) => available(account(who), environment) ? prepare("SELECT * FROM eggs_grants WHERE environment = ? AND record_id = ? AND account_id = ? AND role = 'record' AND active = 1").get(environment, id, who) : null;
  const row = id => prepare('SELECT * FROM eggs_batches WHERE environment = ? AND id = ?').get(environment, id);
  const stamp = (u, now) => ({ eggFormat: 1, ownerId: u.id, environment, serverTime: now });
  const revoke = ids => { for (const id of new Set(ids.filter(Boolean))) prepare('DELETE FROM deletion_confirmations WHERE user_id = ?').run(id); };
  const assertRead = (u, now) => { if (!safe(u?.id) || !time(now)) invalid(); if (!available(u, environment)) throw new EggsError('EGGS_UNAVAILABLE'); };
  const archive = (owner, id, now) => { try { return farmRegistry.detail(owner, id, 0, now).record; } catch (e) { if (e.code === 'NOT_FOUND') return null; throw e; } };
  const current = (id, cycle, now) => prepare("SELECT id FROM eggs_batches WHERE environment = ? AND record_id = ? AND cycle_ref = ? AND day = ? AND status != 'withdrawn'").get(environment, id, cycle, day(now))?.id ?? null;
  const eligible = (r, p) => !!(r && p?.enabled === 1 && p.profile === 'chicken-eggs' && r.kind === 'animal' && ['growing', 'ready'].includes(r.status) && r.ownerId === p.owner_id && r.cycleRef === p.cycle_ref);
  function parse(r) {
    const b = JSON.parse(r.data_json);
    if (b.id !== r.id || b.recordId !== r.record_id || b.cycleRef !== r.cycle_ref || b.day !== r.day || b.sourceRef !== r.source_ref || b.status !== r.status || b.version !== r.version || b.createdAt !== r.created_at || b.updatedAt !== r.updated_at || JSON.stringify(b) !== r.data_json) invalid();
    return b;
  }
  const authorized = (u, audience, r) => audience === 'customer' ? r.owner_id === u.id : !!grant(r.record_id, u.id);
  function recordView(u, audience, id, now) {
    const p = profile(id), rr = prepare('SELECT owner_id FROM farm_records WHERE environment = ? AND id = ?').get(environment, id);
    if (!rr || (audience === 'customer' ? rr.owner_id !== u.id : !grant(id, u.id))) throw new EggsError('NOT_FOUND');
    const r = archive(rr.owner_id, id, now), enabled = eligible(r, p), currentBatchId = current(id, r.cycleRef, now);
    return { recordId: id, recordVersion: r.version, profileVersion: p?.version ?? 0, cycleRef: r.cycleRef, name: r.name, unitLabel: r.unitLabel, enabled, maxDailyQuantity: p?.max_daily_quantity ?? null, currentBatchId, permissions: { canRegister: audience === 'staff' && enabled && currentBatchId === null } };
  }
  function permissions(u, audience, r, now) {
    const eligibleNow = eligible(archive(r.owner_id, r.record_id, now), profile(r.record_id)) && r.cycle_ref === profile(r.record_id)?.cycle_ref;
    return { canCollect: audience === 'customer' && r.owner_id === u.id && r.status === 'available' && eligibleNow, canWithdraw: audience === 'staff' && !!grant(r.record_id, u.id) && r.status === 'available' };
  }
  function command(u, audience, key, input, now, intentId = null) {
    if (!safe(u?.id) || !operationKey(key) || !time(now) || !isEggsCommand(input, audience)) invalid();
    const fingerprint = digest(JSON.stringify({ audience, command: canonical(input) }));
    let id = null, quantity = 0, appliedRevision = null;
    const receipt = code => ({ eggFormat: 1, ownerId: u.id, environment, operationKey: key, action: input.action, outcome: code === 'OK' ? 'applied' : 'refused', code, batchId: id, completedAt: now, quantity, appliedRevision });
    const old = prepare('SELECT * FROM eggs_commands WHERE environment = ? AND owner_id = ? AND key = ?').get(environment, u.id, key);
    if (old) { if (old.fingerprint !== fingerprint) return receipt('IDEMPOTENCY_CONFLICT'); const result = JSON.parse(old.result_json); if (!isEggsReceipt(result, u.id, environment, key, input.action)) invalid(); return result; }
    const apply = () => {
      // The original ledger above wins over revocations and recovery slot changes.
      const blocked = beforeNewCommand?.(u, audience, key, input, now, intentId); if (blocked) return blocked;
      if (!available(u, environment) || !available(account(u.id), environment)) return 'EGGS_UNAVAILABLE';
      if (input.action === 'register') {
        const p = profile(input.recordId); if (!p || !grant(input.recordId, u.id)) return 'NOT_FOUND';
        const r = archive(p.owner_id, input.recordId, now);
        if (!p.enabled) return 'PROFILE_DISABLED';
        if (p.version !== input.expectedProfileVersion) return 'PROFILE_CHANGED';
        if (!eligible(r, p)) return 'RECORD_CHANGED';
        if (input.quantity > p.max_daily_quantity) return 'QUANTITY_LIMIT';
        if (prepare('SELECT 1 FROM eggs_batches WHERE environment = ? AND source_ref = ?').get(environment, input.sourceRef)) return 'SOURCE_EXISTS';
        if (current(r.id, r.cycleRef, now)) return 'DAILY_BATCH_EXISTS';
        id = random();
        const b = { id, recordId: r.id, cycleRef: r.cycleRef, name: r.name, unitLabel: r.unitLabel, day: day(now), sourceRef: input.sourceRef, quantity: input.quantity, status: 'available', version: 1, createdAt: now, updatedAt: now, collectedAt: null, withdrawnAt: null };
        prepare('INSERT INTO eggs_batches (environment,id,record_id,owner_id,recorded_by,withdrawn_by,record_version,cycle_ref,day,source_ref,status,version,data_json,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,1,?,?,?)').run(environment, id, r.id, r.ownerId, u.id, r.version, r.cycleRef, b.day, b.sourceRef, b.status, JSON.stringify(b), now, now);
        revoke([r.ownerId, u.id]); return 'OK';
      }
      const r = row(input.batchId); if (!r || !authorized(u, audience, r)) return 'NOT_FOUND';
      id = r.id; const b = parse(r), p = profile(r.record_id);
      if (input.expectedBatchVersion !== r.version) return 'BATCH_CHANGED';
      if (r.status !== 'available') return 'INVALID_STATE';
      if (now < r.updated_at) invalid();
      if (input.action === 'collect') {
        if (!p?.enabled) return 'PROFILE_DISABLED';
        if (!eligible(archive(r.owner_id, r.record_id, now), p) || r.cycle_ref !== p.cycle_ref) return 'RECORD_CHANGED';
        const result = harvest(r.owner_id, input.expectedRevision, b.quantity, 'eggs-' + b.id, now);
        if (result?.code !== 'OK') return result?.code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : 'ASSET_LIMIT';
        if (!integer(result.appliedRevision, 1)) invalid();
        quantity = b.quantity; appliedRevision = result.appliedRevision; b.status = 'collected'; b.collectedAt = now;
      } else { b.status = 'withdrawn'; b.withdrawnAt = now; }
      b.version = 2; b.updatedAt = now;
      prepare('UPDATE eggs_batches SET withdrawn_by = ?, status = ?, version = 2, data_json = ?, updated_at = ? WHERE environment = ? AND id = ?').run(input.action === 'withdraw' ? u.id : null, b.status, JSON.stringify(b), now, environment, id);
      revoke([r.owner_id, r.recorded_by, u.id]); return 'OK';
    };
    const code = apply(), result = receipt(code);
    if (!isEggsReceipt(result, u.id, environment, key, input.action)) invalid();
    // Immutable non-FK target metadata distinguishes deleted customers from a
    // missing production batch even after its registering employee was deleted.
    const target = code === 'OK' ? row(id) : null;
    if (code === 'OK' && !target) invalid();
    prepare('INSERT INTO eggs_commands (environment,owner_id,key,fingerprint,target_owner_id,target_record_id,result_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(environment, u.id, key, fingerprint, target?.owner_id ?? null, target?.record_id ?? null, JSON.stringify(result), now);
    return result;
  }
  function provision(input, now) {
    if (!time(now) || environment !== 'development') throw new EggsError('EGGS_UNAVAILABLE');
    let x; try { x = normalizeEggsProvision(input); } catch { invalid(); }
    const rr = prepare('SELECT owner_id FROM farm_records WHERE environment = ? AND id = ?').get(environment, x.recordId);
    if (!rr) throw new EggsError('NOT_FOUND');
    const r = archive(rr.owner_id, x.recordId, now), p = profile(x.recordId);
    if ((p?.version ?? 0) !== x.expectedProfileVersion) throw new EggsError('PROFILE_CHANGED');
    if (r.version !== x.recordVersion || r.kind !== 'animal' || (p && p.owner_id !== r.ownerId) || (x.enabled && !['growing', 'ready'].includes(r.status))) throw new EggsError('RECORD_CHANGED');
    if (!available(account(r.ownerId), environment) || x.staff.some(s => !available(account(s.accountId), environment))) throw new EggsError('ACCOUNT_UNAVAILABLE');
    const version = increment(p?.version ?? 0), old = grants(r.id);
    if (p && now < p.updated_at) invalid();
    if (p) prepare('UPDATE eggs_profiles SET version = ?, record_version = ?, cycle_ref = ?, profile = ?, enabled = ?, max_daily_quantity = ?, updated_at = ? WHERE environment = ? AND record_id = ?').run(version, r.version, r.cycleRef, x.profile, +x.enabled, x.maxDailyQuantity, now, environment, r.id);
    else prepare('INSERT INTO eggs_profiles (environment,record_id,owner_id,version,record_version,cycle_ref,profile,enabled,max_daily_quantity,created_at,updated_at) VALUES (?,?,?,1,?,?,?,?,?,?,?)').run(environment, r.id, r.ownerId, r.version, r.cycleRef, x.profile, +x.enabled, x.maxDailyQuantity, now, now);
    for (const g of old) prepare('UPDATE eggs_grants SET active = 0, version = ?, updated_at = ? WHERE environment = ? AND record_id = ? AND account_id = ?').run(increment(g.version), now, environment, r.id, g.account_id);
    for (const s of x.staff) {
      if (old.some(g => g.account_id === s.accountId)) prepare('UPDATE eggs_grants SET active = 1 WHERE environment = ? AND record_id = ? AND account_id = ?').run(environment, r.id, s.accountId);
      else prepare("INSERT INTO eggs_grants (environment,record_id,account_id,role,active,version,created_at,updated_at) VALUES (?,?,?,'record',1,1,?,?)").run(environment, r.id, s.accountId, now, now);
    }
    revoke([r.ownerId, ...old.map(g => g.account_id), ...x.staff.map(s => s.accountId)]);
    return { ok: true, operation: 'eggs-provision', version, grants: x.staff.length };
  }
  const api = {
    status(u, now) { if (!safe(u?.id) || !time(now)) invalid(); const a = available(u, environment); return { ...stamp(u, now), available: a, hasStaffAccess: a && !!prepare('SELECT 1 FROM eggs_grants WHERE environment = ? AND account_id = ? AND active = 1 LIMIT 1').get(environment, u.id) }; },
    record(u, audience, id, now) { assertRead(u, now); if (!['customer', 'staff'].includes(audience) || !recordId(id)) invalid(); const out = { ...stamp(u, now), ...recordView(u, audience, id, now) }; if (!isEggsRecord(out, u.id, environment, id)) invalid(); return out; },
    records(u, cursor = 'start', now) { assertRead(u, now); if (!(cursor === 'start' || recordId(cursor))) invalid(); const rows = prepare('SELECT record_id FROM eggs_grants WHERE environment = ? AND account_id = ? AND active = 1 AND record_id > ? ORDER BY record_id LIMIT 21').all(environment, u.id, cursor === 'start' ? '' : cursor), items = rows.slice(0, 20).map(r => recordView(u, 'staff', r.record_id, now)); const out = { ...stamp(u, now), items, nextCursor: rows.length > 20 ? items.at(-1).recordId : null }; if (!isEggsRecordsPage(out, u.id, environment)) invalid(); return out; },
    page(u, audience, cursor = 'start', now) { assertRead(u, now); if (!['customer', 'staff'].includes(audience) || !(cursor === 'start' || isEggsId(cursor))) invalid(); const after = cursor === 'start' ? '' : cursor;
      const rows = audience === 'customer' ? prepare('SELECT * FROM eggs_batches WHERE environment = ? AND owner_id = ? AND id > ? ORDER BY id LIMIT 21').all(environment, u.id, after) : prepare('SELECT b.* FROM eggs_batches b WHERE b.environment = ? AND b.id > ? AND EXISTS (SELECT 1 FROM eggs_grants g WHERE g.environment = b.environment AND g.record_id = b.record_id AND g.account_id = ? AND g.active = 1) ORDER BY b.id LIMIT 21').all(environment, after, u.id);
      const items = rows.slice(0, 20).map(parse), out = { ...stamp(u, now), items, nextCursor: rows.length > 20 ? items.at(-1).id : null }; if (!isEggsPage(out, u.id, environment)) invalid(); return out; },
    detail(u, audience, id, now) { assertRead(u, now); if (!['customer', 'staff'].includes(audience) || !isEggsId(id)) invalid(); const r = row(id); if (!r || !authorized(u, audience, r)) throw new EggsError('NOT_FOUND'); const out = { ...stamp(u, now), batch: parse(r), permissions: permissions(u, audience, r, now) }; if (!isEggsDetail(out, u.id, environment, id)) invalid(); return out; },
    command, provision,
    deleteOwner(id, now) {
      if (!safe(id) || !time(now)) invalid();
      const affected = prepare('SELECT DISTINCT record_id FROM eggs_grants WHERE environment = ? AND account_id = ?').all(environment, id);
      for (const a of affected) { const p = profile(a.record_id); prepare('UPDATE eggs_profiles SET version = ?, updated_at = ? WHERE environment = ? AND record_id = ?').run(increment(p.version), now, environment, a.record_id); revoke([p.owner_id, ...grants(a.record_id).map(g => g.account_id)]); }
      for (const p of prepare('SELECT record_id FROM eggs_profiles WHERE environment = ? AND owner_id = ?').all(environment, id)) revoke(grants(p.record_id).map(g => g.account_id));
      prepare('UPDATE eggs_batches SET recorded_by = NULL WHERE environment = ? AND recorded_by = ?').run(environment, id);
      prepare('UPDATE eggs_batches SET withdrawn_by = NULL WHERE environment = ? AND withdrawn_by = ?').run(environment, id);
      prepare('DELETE FROM eggs_batches WHERE environment = ? AND owner_id = ?').run(environment, id);
      prepare('DELETE FROM eggs_grants WHERE environment = ? AND (account_id = ? OR record_id IN (SELECT record_id FROM eggs_profiles WHERE environment = ? AND owner_id = ?))').run(environment, id, environment, id);
      prepare('DELETE FROM eggs_profiles WHERE environment = ? AND owner_id = ?').run(environment, id);
      prepare('DELETE FROM eggs_commands WHERE environment = ? AND owner_id = ?').run(environment, id);
    },
  };
  return Object.freeze(Object.fromEntries(Object.entries(api).map(([name, method]) => [name, (...args) => { try { return method(...args); } catch (e) { if (e instanceof EggsError || e?.name === 'RecoveryError') throw e; invalid(); } }])));
}

// Restore only revokes powers; original command JSON is never rewritten.
export function restoreEggsDatabase(db, now) {
  try {
    if (!time(now)) invalid();
    if (db.prepare('SELECT 1 FROM eggs_profiles WHERE version >= ? OR updated_at > ? LIMIT 1').get(Number.MAX_SAFE_INTEGER, now) || db.prepare('SELECT 1 FROM eggs_grants WHERE version >= ? OR updated_at > ? LIMIT 1').get(Number.MAX_SAFE_INTEGER, now)) invalid();
    db.prepare('UPDATE eggs_profiles SET enabled = 0, version = version + 1, updated_at = ?').run(now);
    db.prepare('UPDATE eggs_grants SET active = 0, version = version + 1, updated_at = ?').run(now);
  } catch { invalid(); }
}

export function validateEggsDatabase(db, now) {
  try {
    if (!time(now)) invalid();
    const users = new Map(db.prepare('SELECT id,environment,identity_provider,created_at,revision,state_json FROM users').all().map(u => [u.id, u]));
    const profiles = new Map(), batches = new Map(), grants = new Map(), counts = new Map(), sourceRefs = new Set(), daily = new Set();
    const scope = (env, id) => env + '\0' + id;
    const stamp = (r, owner) => { const u = users.get(owner); if (!u || !available(u, r.environment) || !time(r.created_at) || !time(r.updated_at) || r.created_at < u.created_at || r.updated_at < r.created_at || r.updated_at > now) invalid(); };
    for (const p of db.prepare('SELECT * FROM eggs_profiles').all()) {
      stamp(p, p.owner_id);
      if (!recordId(p.record_id) || !integer(p.version, 1) || !integer(p.record_version, 1) || p.profile !== 'chicken-eggs' || ![0, 1].includes(p.enabled) || !integer(p.max_daily_quantity, 1) || p.max_daily_quantity > 10000) invalid();
      const rr = db.prepare('SELECT owner_id,version,data_json FROM farm_records WHERE environment = ? AND id = ?').get(p.environment, p.record_id);
      const old = db.prepare('SELECT data_json FROM farm_record_events WHERE environment = ? AND record_id = ? AND version = ?').get(p.environment, p.record_id, p.record_version);
      if (!rr || !old || rr.owner_id !== p.owner_id || p.record_version > rr.version) invalid();
      const r = JSON.parse(old.data_json); if (r.kind !== 'animal' || r.ownerId !== p.owner_id || r.cycleRef !== p.cycle_ref || r.updatedAt > p.updated_at || (p.enabled && !['growing', 'ready'].includes(r.status))) invalid();
      profiles.set(scope(p.environment, p.record_id), p);
    }
    for (const g of db.prepare('SELECT * FROM eggs_grants').all()) {
      stamp(g, g.account_id); const p = profiles.get(scope(g.environment, g.record_id));
      if (!p || g.role !== 'record' || !integer(g.version, 1) || ![0, 1].includes(g.active) || g.created_at < p.created_at || g.updated_at > p.updated_at || (g.active && !p.enabled)) invalid();
      const k = scope(g.environment, g.record_id); if (g.active) { const n = (counts.get(k) ?? 0) + 1; if (n > 40) invalid(); counts.set(k, n); }
      grants.set(k + '\0' + g.account_id, g);
    }
    for (const r of db.prepare('SELECT * FROM eggs_batches').all()) {
      stamp(r, r.owner_id); const p = profiles.get(scope(r.environment, r.record_id)), b = JSON.parse(r.data_json);
      if (!p || p.owner_id !== r.owner_id || !integer(r.record_version, 1) || !isEggsDetail({ eggFormat: 1, ownerId: r.owner_id, environment: r.environment, serverTime: now, batch: b, permissions: { canCollect: false, canWithdraw: false } }, r.owner_id, r.environment, r.id) || JSON.stringify(b) !== r.data_json || b.id !== r.id || b.recordId !== r.record_id || b.cycleRef !== r.cycle_ref || b.day !== r.day || b.sourceRef !== r.source_ref || b.status !== r.status || b.version !== r.version || b.createdAt !== r.created_at || b.updatedAt !== r.updated_at || r.created_at < p.created_at) invalid();
      const old = db.prepare('SELECT data_json FROM farm_record_events WHERE environment = ? AND record_id = ? AND version = ?').get(r.environment, r.record_id, r.record_version); if (!old) invalid();
      const a = JSON.parse(old.data_json); if (a.kind !== 'animal' || a.ownerId !== r.owner_id || a.cycleRef !== b.cycleRef || a.name !== b.name || a.unitLabel !== b.unitLabel || !['growing', 'ready'].includes(a.status) || a.updatedAt > r.created_at) invalid();
      for (const actor of [r.recorded_by, r.withdrawn_by]) if (actor !== null) { const u = users.get(actor); if (!u || !available(u, r.environment) || !grants.has(scope(r.environment, r.record_id) + '\0' + actor) || u.created_at > r.updated_at) invalid(); }
      if (b.status !== 'withdrawn' && r.withdrawn_by !== null) invalid();
      const s = scope(r.environment, r.source_ref); if (sourceRefs.has(s)) invalid(); sourceRefs.add(s);
      if (r.status !== 'withdrawn') { const d = scope(r.environment, r.record_id) + '\0' + r.cycle_ref + '\0' + r.day; if (daily.has(d)) invalid(); daily.add(d); }
      batches.set(scope(r.environment, r.id), r);
    }
    const applied = new Set(), assetRevisions = new Set(), collected = new Map(), targets = new Map();
    for (const r of db.prepare('SELECT * FROM eggs_commands').all()) {
      const u = users.get(r.owner_id), c = JSON.parse(r.result_json);
      if (!u || u.environment !== r.environment || !operationKey(r.key) || !exact(r.fingerprint, /^[a-f0-9]{64}$/u) || !isEggsReceipt(c, r.owner_id, r.environment, r.key, c.action) || JSON.stringify(c) !== r.result_json || c.completedAt !== r.created_at || r.created_at < u.created_at || r.created_at > now || (!available(u, r.environment) && c.code !== 'EGGS_UNAVAILABLE')) invalid();
      if (c.code !== 'OK') { if (r.target_owner_id !== null || r.target_record_id !== null) invalid(); continue; }
      if (!safe(r.target_owner_id) || !recordId(r.target_record_id)) invalid();
      const b = batches.get(scope(r.environment, c.batchId));
      const batchKey = scope(r.environment, c.batchId), target = targets.get(batchKey);
      if (target && (target.owner !== r.target_owner_id || target.record !== r.target_record_id)) invalid();
      targets.set(batchKey, { owner: r.target_owner_id, record: r.target_record_id });
      // All new eggs actions enter through one typed recovery intent. Bind the
      // retained target facts before considering the deleted-customer exception.
      const intent = db.prepare('SELECT audience,command_json,created_at FROM planting_intents WHERE environment = ? AND owner_id = ? AND operation_key = ?').get(r.environment, r.owner_id, r.key);
      if (!intent) invalid();
      const original = JSON.parse(intent.command_json);
      if (!isEggsCommand(original, intent.audience) || original.action !== c.action || digest(JSON.stringify({ audience: intent.audience, command: canonical(original) })) !== r.fingerprint || intent.created_at > r.created_at) invalid();
      if (c.action === 'register' ? intent.audience !== 'staff' || original.recordId !== r.target_record_id : original.batchId !== c.batchId || original.expectedBatchVersion !== 1 || intent.audience !== (c.action === 'collect' ? 'customer' : 'staff')) invalid();
      const k = batchKey + '\0' + c.action;
      if (applied.has(k)) invalid(); applied.add(k);
      if (!b) {
        // A missing batch is valid only after its original customer and record
        // have both gone. A living customer must retain even withdrawn history.
        if (c.action === 'collect' || users.has(r.target_owner_id) || db.prepare('SELECT 1 FROM farm_records WHERE environment = ? AND id = ?').get(r.environment, r.target_record_id)) invalid();
        continue;
      }
      if (b.owner_id !== r.target_owner_id || b.record_id !== r.target_record_id) invalid();
      const value = JSON.parse(b.data_json);
      if (c.action === 'register' && (intent.audience !== 'staff' || original.recordId !== b.record_id || original.quantity !== value.quantity || original.sourceRef !== value.sourceRef || original.expectedProfileVersion > profiles.get(scope(r.environment, b.record_id)).version || b.recorded_by !== r.owner_id || b.created_at !== r.created_at || b.day !== day(r.created_at))) invalid();
      if (c.action === 'withdraw' && (intent.audience !== 'staff' || original.batchId !== b.id || original.expectedBatchVersion !== 1 || b.withdrawn_by !== r.owner_id || b.status !== 'withdrawn' || b.updated_at !== r.created_at)) invalid();
      if (c.action === 'collect') {
        if (intent.audience !== 'customer' || original.batchId !== b.id || original.expectedBatchVersion !== 1 || original.expectedRevision + 1 !== c.appliedRevision || b.owner_id !== r.owner_id || b.status !== 'collected' || b.updated_at !== r.created_at || c.quantity !== value.quantity || c.appliedRevision > u.revision) invalid();
        const revisionKey = scope(r.environment, r.owner_id) + '\0' + c.appliedRevision; if (assetRevisions.has(revisionKey)) invalid(); assetRevisions.add(revisionKey);
        const state = JSON.parse(u.state_json), eventId = 'eggs-' + b.id;
        if (!Array.isArray(state.system.eventIds) || state.system.eventIds.filter(id => id === eventId).length !== 1) invalid();
        const totals = collected.get(u.id) ?? { quantity: 0, count: 0 }; totals.quantity += c.quantity; totals.count++;
        if (!integer(totals.quantity) || !integer(totals.count)) invalid(); collected.set(u.id, totals);
      }
    }
    // Every live actor's successful state change must still have its original ledger.
    for (const b of batches.values()) {
      const k = scope(b.environment, b.id);
      if ((b.recorded_by !== null && !applied.has(k + '\0register')) || (b.withdrawn_by !== null && !applied.has(k + '\0withdraw')) || (b.status === 'collected' && !applied.has(k + '\0collect'))) invalid();
    }
    for (const [owner, total] of collected) {
      const state = JSON.parse(users.get(owner).state_json);
      if (!integer(state.system.inventory.eggs) || state.system.inventory.eggs < total.quantity || !integer(state.system.stats.harvest) || state.system.stats.harvest < total.count || !integer(state.system.xp) || state.system.xp < total.count * 8) invalid();
    }
    return true;
  } catch { invalid(); }
}
