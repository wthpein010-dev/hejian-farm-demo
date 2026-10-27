import { createHash } from 'node:crypto';
import { FARM_PAGE_SIZE, normalizeFarmRecord, normalizeFarmBatch, isFarmRecord, isFarmPage,
  isFarmDetail, validateFarmRecordTransition } from '../../../shared/farm-records.mjs';

// These objects also supply the backup verifier's single source of schema DDL.
export const FARM_REGISTRY_TABLE_SQL = Object.freeze({
  farm_records: `CREATE TABLE IF NOT EXISTS farm_records (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    data_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (environment, id)
  )`,
  farm_record_events: `CREATE TABLE IF NOT EXISTS farm_record_events (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
    record_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    data_json TEXT NOT NULL,
    source TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (environment, record_id, version),
    FOREIGN KEY (environment, record_id) REFERENCES farm_records(environment, id)
  )`,
  farm_imports: `CREATE TABLE IF NOT EXISTS farm_imports (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
    batch_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (environment, batch_id)
  )`,
});
export const FARM_REGISTRY_INDEX_SQL = Object.freeze({
  farm_records_owner: 'CREATE INDEX IF NOT EXISTS farm_records_owner ON farm_records(owner_id, environment, id)',
});
export const FARM_REGISTRY_SQL = [...Object.values(FARM_REGISTRY_TABLE_SQL), ...Object.values(FARM_REGISTRY_INDEX_SQL)].join(';\n') + ';';

const RECORD_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const SOURCE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const validEnvironment = value => value === 'development' || value === 'production';
const positive = value => Number.isSafeInteger(value) && value >= 1;
const errorMessages = Object.freeze({
  INVALID_FARM_DATA: '农场资料未能通过校验', OWNER_UNAVAILABLE: '农场资料归属账户不可用',
  IMPORT_CONFLICT: '此导入编号已用于其他资料', VERSION_CONFLICT: '农场资料版本已有变化',
  RECORD_CONFLICT: '农场资料更新不符合记录规则', NOT_FOUND: '未找到此农场档案',
});
export class FarmRegistryError extends Error {
  constructor(code = 'INVALID_FARM_DATA') {
    super(errorMessages[code] ?? errorMessages.INVALID_FARM_DATA);
    this.name = 'FarmRegistryError'; this.code = Object.hasOwn(errorMessages, code) ? code : 'INVALID_FARM_DATA';
  }
}
const invalid = () => { throw new FarmRegistryError(); };

function canonicalRecord(value, environment, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.environment !== environment) invalid();
  const { environment: ignored, ...raw } = value;
  let canonical;
  try { canonical = normalizeFarmRecord(raw, { environment, now }); } catch { invalid(); }
  if (JSON.stringify(canonical) !== JSON.stringify(value)) invalid();
  return canonical;
}

function currentRecord(row, environment, now) {
  if (!row || row.environment !== environment || !positive(row.version) || !validTime(row.created_at) ||
      !validTime(row.updated_at) || row.created_at > row.updated_at || row.updated_at > now || typeof row.data_json !== 'string') invalid();
  let data; try { data = JSON.parse(row.data_json); } catch { invalid(); }
  const canonical = canonicalRecord(data, environment, now);
  if (JSON.stringify(canonical) !== row.data_json || canonical.id !== row.id || canonical.ownerId !== row.owner_id) invalid();
  const record = { ...canonical, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  if (!isFarmRecord(record, row.owner_id, environment)) invalid();
  return record;
}

function eventRecord(row, current, now) {
  let record; try { record = JSON.parse(row.data_json); } catch { invalid(); }
  if (!isFarmRecord(record, current.ownerId, current.environment) || record.id !== current.id ||
      record.kind !== current.kind || record.cycleRef !== current.cycleRef || record.version !== row.version ||
      row.environment !== current.environment || row.record_id !== current.id || !SOURCE.test(row.source) ||
      !validTime(row.recorded_at) || row.recorded_at > now || record.updatedAt !== row.recorded_at ||
      record.createdAt !== current.createdAt || record.version > current.version) invalid();
  const { version, createdAt, updatedAt, ...base } = record;
  const canonical = canonicalRecord(base, current.environment, now);
  if (JSON.stringify({ ...canonical, version, createdAt, updatedAt }) !== row.data_json) invalid();
  return { version, recordedAt: row.recorded_at, source: row.source, record };
}

function importResult(serialized) {
  let value; try { value = JSON.parse(serialized); } catch { invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'created,ok,operation,replayed,updated' ||
      value.ok !== true || value.operation !== 'farm-import' || value.replayed !== false ||
      !Number.isSafeInteger(value.created) || value.created < 0 || !Number.isSafeInteger(value.updated) ||
      value.updated < 0 || value.created + value.updated < 1 || value.created + value.updated > 100) invalid();
  return value;
}

export function createFarmRegistry({ prepare, environment }) {
  if (typeof prepare !== 'function' || !validEnvironment(environment)) invalid();
  const getRecord = (id, now) => {
    const row = prepare('SELECT * FROM farm_records WHERE environment = ? AND id = ?').get(environment, id);
    return row ? currentRecord(row, environment, now) : null;
  };
  const registry = {
    page(ownerId, kind, cursor = 'start', now) {
      if (!validTime(now) || !['plots', 'animals'].includes(kind) ||
          !(cursor === 'start' || cursor === null || (typeof cursor === 'string' && RECORD_ID.test(cursor)))) invalid();
      const rows = prepare(`SELECT * FROM farm_records WHERE owner_id = ? AND environment = ?
        AND json_extract(data_json, '$.kind') = ? AND id > ? ORDER BY id LIMIT ?`)
        .all(ownerId, environment, kind === 'plots' ? 'plot' : 'animal', cursor === 'start' || cursor === null ? '' : cursor, FARM_PAGE_SIZE + 1);
      const items = rows.slice(0, FARM_PAGE_SIZE).map(row => currentRecord(row, environment, now));
      const page = { recordFormat: 1, ownerId, environment, kind, items,
        nextCursor: rows.length > FARM_PAGE_SIZE ? items.at(-1).id : null, serverTime: now };
      if (!isFarmPage(page, ownerId, kind, environment)) invalid();
      return page;
    },
    detail(ownerId, id, beforeVersion = 0, now) {
      if (!validTime(now) || typeof id !== 'string' || !RECORD_ID.test(id) ||
          !Number.isSafeInteger(beforeVersion) || beforeVersion < 0) invalid();
      const record = getRecord(id, now);
      if (!record || record.ownerId !== ownerId) throw new FarmRegistryError('NOT_FOUND');
      const rows = prepare(`SELECT * FROM farm_record_events WHERE environment = ? AND record_id = ?
        AND (? = 0 OR version < ?) ORDER BY version DESC LIMIT ?`)
        .all(environment, id, beforeVersion, beforeVersion, FARM_PAGE_SIZE + 1);
      const events = rows.slice(0, FARM_PAGE_SIZE).map(row => eventRecord(row, record, now));
      const detail = { recordFormat: 1, ownerId, environment, record, events,
        nextBeforeVersion: rows.length > FARM_PAGE_SIZE ? events.at(-1).version : null, serverTime: now };
      if (!isFarmDetail(detail, ownerId, id, environment)) invalid();
      return detail;
    },
    // The Store owns BEGIN IMMEDIATE, including all prechecks and this receipt.
    applyBatch(batch, now) {
      if (!validTime(now)) invalid();
      let normalized;
      try {
        normalized = normalizeFarmBatch({ ...batch, entries: batch.entries.map(entry => {
          if (entry.record.environment !== environment) invalid();
          const { environment: ignored, ...raw } = entry.record;
          return { expectedVersion: entry.expectedVersion, record: raw };
        }) }, { environment, now });
      } catch { invalid(); }
      if (JSON.stringify(normalized) !== JSON.stringify(batch)) invalid();
      const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      const previous = prepare('SELECT fingerprint, result_json FROM farm_imports WHERE environment = ? AND batch_id = ?').get(environment, batch.batchId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new FarmRegistryError('IMPORT_CONFLICT');
        return { ...importResult(previous.result_json), replayed: true };
      }
      const pending = []; let created = 0, updated = 0;
      for (const entry of normalized.entries) {
        const owner = prepare('SELECT environment FROM users WHERE id = ?').get(entry.record.ownerId);
        if (!owner || owner.environment !== environment) throw new FarmRegistryError('OWNER_UNAVAILABLE');
        const existing = getRecord(entry.record.id, now);
        if ((existing?.version ?? 0) !== entry.expectedVersion) throw new FarmRegistryError('VERSION_CONFLICT');
        if (existing) {
          if (existing.version === Number.MAX_SAFE_INTEGER || now < existing.updatedAt) throw new FarmRegistryError('RECORD_CONFLICT');
          try { validateFarmRecordTransition(existing, entry.record, { environment, now }); }
          catch { throw new FarmRegistryError('RECORD_CONFLICT'); }
          updated++;
        } else created++;
        const record = { ...entry.record, version: existing ? existing.version + 1 : 1,
          createdAt: existing?.createdAt ?? now, updatedAt: now };
        pending.push({ record, data: JSON.stringify(entry.record), existing });
      }
      for (const { record, data, existing } of pending) {
        if (existing) prepare('UPDATE farm_records SET data_json = ?, version = ?, updated_at = ? WHERE environment = ? AND id = ?')
          .run(data, record.version, now, environment, record.id);
        else prepare('INSERT INTO farm_records (environment, id, owner_id, data_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(environment, record.id, record.ownerId, data, 1, now, now);
        prepare('INSERT INTO farm_record_events (environment, record_id, version, data_json, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(environment, record.id, record.version, JSON.stringify(record), normalized.source, now);
        prepare('UPDATE users SET updated_at = MAX(updated_at, ?) WHERE id = ? AND environment = ?').run(now, record.ownerId, environment);
      }
      const result = { ok: true, operation: 'farm-import', created, updated, replayed: false };
      prepare('INSERT INTO farm_imports (environment, batch_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(environment, normalized.batchId, fingerprint, JSON.stringify(result), now);
      return result;
    },
    deleteOwner(ownerId) {
      prepare(`DELETE FROM farm_record_events WHERE environment = ? AND record_id IN
        (SELECT id FROM farm_records WHERE owner_id = ? AND environment = ?)`).run(environment, ownerId, environment);
      prepare('DELETE FROM farm_records WHERE owner_id = ? AND environment = ?').run(ownerId, environment);
    },
  };
  return Object.freeze(Object.fromEntries(Object.entries(registry).map(([name, method]) => [name, (...args) => {
    try { return method(...args); }
    catch (error) { if (error instanceof FarmRegistryError) throw error; invalid(); }
  }])));
}

// The backup layer checks fixed schema/columns/foreign keys before calling this
// content verifier. Never include database values or SQLite errors in failures.
export function validateFarmRegistryDatabase(db, latestTime) {
  try {
    if (!validTime(latestTime)) invalid();
    const records = new Map();
    for (const row of db.prepare('SELECT * FROM farm_records ORDER BY environment, id').iterate()) {
      if (!validEnvironment(row.environment)) invalid();
      const owner = db.prepare('SELECT environment FROM users WHERE id = ?').get(row.owner_id);
      if (!owner || owner.environment !== row.environment) invalid();
      const record = currentRecord(row, row.environment, latestTime);
      records.set(row.environment + '\0' + row.id, { record, previous: null, count: 0 });
    }
    for (const row of db.prepare('SELECT * FROM farm_record_events ORDER BY environment, record_id, version').iterate()) {
      const state = records.get(row.environment + '\0' + row.record_id);
      if (!state) invalid();
      const event = eventRecord(row, state.record, latestTime);
      if (event.version !== state.count + 1 || event.recordedAt < state.record.createdAt) invalid();
      if (!state.previous && event.recordedAt !== state.record.createdAt) invalid();
      if (state.previous) {
        if (event.recordedAt < state.previous.recordedAt) invalid();
        validateFarmRecordTransition(state.previous.record, event.record, { environment: row.environment, now: latestTime });
      }
      state.previous = event; state.count++;
    }
    for (const { record, previous, count } of records.values()) {
      if (count !== record.version || !previous || JSON.stringify(previous.record) !== JSON.stringify(record)) invalid();
    }
    for (const row of db.prepare('SELECT * FROM farm_imports').iterate()) {
      if (!validEnvironment(row.environment) || typeof row.batch_id !== 'string' || !RECORD_ID.test(row.batch_id) ||
          typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
          !validTime(row.created_at) || row.created_at > latestTime || typeof row.result_json !== 'string') invalid();
      importResult(row.result_json);
    }
    return true;
  } catch { throw new FarmRegistryError('INVALID_FARM_DATA'); }
}
