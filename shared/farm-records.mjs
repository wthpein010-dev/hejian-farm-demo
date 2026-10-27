// Pure JSON boundary shared by private imports, API reads and backup validation.
export const FARM_PAGE_SIZE = 20;
const MAX_DATE = 8_640_000_000_000_000;
const RECORD_FIELDS = ['id', 'ownerId', 'kind', 'name', 'unitLabel', 'cycleRef', 'status',
  'startedAt', 'expectedHarvestAt', 'observedAt', 'measurements'];
const CANONICAL_FIELDS = [...RECORD_FIELDS, 'environment'];
const PUBLIC_FIELDS = [...CANONICAL_FIELDS, 'version', 'createdAt', 'updatedAt'];
const STATUSES = ['planned', 'growing', 'ready', 'archived'];
const RECORD_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;

export class FarmRecordValidationError extends Error {
  constructor() { super('农场档案数据无效'); this.name = 'FarmRecordValidationError'; }
}

function ensure(condition) { if (!condition) throw new FarmRecordValidationError(); }
function guarded(work) {
  try { return work(); }
  catch { throw new FarmRecordValidationError(); }
}
function fields(value, required, optional = []) {
  ensure(value !== null && typeof value === 'object');
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  ensure(keys.length >= required.length && keys.length <= required.length + optional.length);
  const allowed = new Set([...required, ...optional]);
  const data = {};
  for (const key of keys) {
    ensure(typeof key === 'string' && allowed.has(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    data[key] = descriptor.value;
  }
  for (const key of required) ensure(Object.hasOwn(value, key));
  return data;
}
function array(value, maximum, minimum = 0) {
  ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  ensure(integer(length, minimum) && length <= maximum && Reflect.ownKeys(value).length === length + 1);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    ensure(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    result.push(descriptor.value);
  }
  return result;
}
function exactMatch(value, expression) {
  if (typeof value !== 'string') return false;
  const match = expression.exec(value);
  return match !== null && match[0] === value;
}
function safeId(value, maximum) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && exactMatch(value, SAFE_ID);
}
function displayText(value) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= 64 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function environment(value) { return value === 'development' || value === 'production'; }
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE; }
function nullableTimestamp(value) { return value === null || timestamp(value); }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function number(value) { return Object.is(value, -0) ? 0 : value; }
function context(options) {
  options = fields(options, ['environment', 'now']);
  ensure(environment(options.environment) && timestamp(options.now));
  return options;
}
function canonical(raw, suppliedEnvironment, now) {
  ensure(exactMatch(raw.id, RECORD_ID) && safeId(raw.ownerId, 128));
  ensure(raw.kind === 'plot' || raw.kind === 'animal');
  ensure(displayText(raw.name) && displayText(raw.unitLabel) && safeId(raw.cycleRef, 64));
  ensure(STATUSES.includes(raw.status));
  ensure(nullableTimestamp(raw.startedAt) && nullableTimestamp(raw.expectedHarvestAt) && timestamp(raw.observedAt));
  ensure(raw.observedAt <= now && (raw.startedAt === null || raw.startedAt <= raw.observedAt));
  ensure(raw.startedAt === null || raw.expectedHarvestAt === null || raw.expectedHarvestAt >= raw.startedAt);
  const keys = raw.kind === 'plot' ? ['areaM2', 'moisturePercent'] : ['weightKg', 'headCount'];
  const values = fields(raw.measurements, [], keys);
  const measurements = {};
  for (const key of keys) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    ensure(finite(value));
    if (key === 'areaM2') ensure(value > 0);
    if (key === 'moisturePercent') ensure(value >= 0 && value <= 100);
    if (key === 'weightKg') ensure(value >= 0);
    if (key === 'headCount') ensure(integer(value));
    measurements[key] = number(value);
  }
  return {
    id: raw.id, ownerId: raw.ownerId, kind: raw.kind, name: raw.name, unitLabel: raw.unitLabel,
    cycleRef: raw.cycleRef, status: raw.status, startedAt: number(raw.startedAt),
    expectedHarvestAt: number(raw.expectedHarvestAt), observedAt: number(raw.observedAt),
    measurements, environment: suppliedEnvironment,
  };
}

export function normalizeFarmRecord(raw, options) {
  return guarded(() => {
    const { environment: suppliedEnvironment, now } = context(options);
    return canonical(fields(raw, RECORD_FIELDS), suppliedEnvironment, now);
  });
}

export function normalizeFarmBatch(raw, options) {
  return guarded(() => {
    const { environment: suppliedEnvironment, now } = context(options);
    const input = fields(raw, ['formatVersion', 'batchId', 'source', 'entries']);
    ensure(input.formatVersion === 1 && exactMatch(input.batchId, RECORD_ID) && exactMatch(input.source, SOURCE_ID));
    const seen = new Set();
    const entries = array(input.entries, 100, 1).map(value => {
      const entry = fields(value, ['expectedVersion', 'record']);
      ensure(integer(entry.expectedVersion));
      const record = canonical(fields(entry.record, RECORD_FIELDS), suppliedEnvironment, now);
      ensure(!seen.has(record.id)); seen.add(record.id);
      return { expectedVersion: number(entry.expectedVersion), record };
    });
    return { formatVersion: 1, batchId: input.batchId, source: input.source, entries };
  });
}

function publicRecord(value, ownerId, suppliedEnvironment, now) {
  const input = fields(value, PUBLIC_FIELDS);
  ensure(safeId(ownerId, 128) && input.ownerId === ownerId);
  ensure(environment(suppliedEnvironment) && input.environment === suppliedEnvironment);
  ensure(integer(input.version, 1) && timestamp(input.createdAt) && timestamp(input.updatedAt));
  ensure(input.createdAt <= input.updatedAt && input.updatedAt <= now && input.observedAt <= input.updatedAt);
  return { ...canonical(input, suppliedEnvironment, now), version: input.version,
    createdAt: number(input.createdAt), updatedAt: number(input.updatedAt) };
}
function boolean(work) {
  try { work(); return true; } catch { return false; }
}

// This standalone predicate checks internal chronology. API envelopes supply the
// authoritative serverTime below; a client machine's wall clock is irrelevant.
export function isFarmRecord(value, ownerId, suppliedEnvironment) {
  return boolean(() => publicRecord(value, ownerId, suppliedEnvironment, MAX_DATE));
}

function normalizedRecord(value, suppliedEnvironment, now) {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'version')) {
    const input = fields(value, PUBLIC_FIELDS);
    return publicRecord(input, input.ownerId, suppliedEnvironment, now);
  }
  const input = fields(value, CANONICAL_FIELDS);
  ensure(input.environment === suppliedEnvironment);
  return canonical(input, suppliedEnvironment, now);
}
function transition(previous, next) {
  for (const field of ['id', 'ownerId', 'kind', 'cycleRef', 'environment']) ensure(previous[field] === next[field]);
  ensure(STATUSES.indexOf(next.status) >= STATUSES.indexOf(previous.status));
  ensure(previous.startedAt === null || previous.startedAt === next.startedAt);
  ensure(previous.observedAt <= next.observedAt);
  if (Object.hasOwn(previous, 'version') && Object.hasOwn(next, 'version')) {
    ensure(previous.version < next.version && previous.createdAt === next.createdAt && previous.updatedAt <= next.updatedAt);
  }
}

// The registry can validate a current PublicRecord against a newly normalized
// import. Backup/history validation can pass two PublicRecords in time order.
export function validateFarmRecordTransition(previous, next, options) {
  return guarded(() => {
    const { environment: suppliedEnvironment, now } = context(options);
    const before = normalizedRecord(previous, suppliedEnvironment, now);
    const after = normalizedRecord(next, suppliedEnvironment, now);
    transition(before, after);
    return canonical(after, suppliedEnvironment, now);
  });
}

function envelope(input, ownerId, suppliedEnvironment) {
  ensure(input.recordFormat === 1 && safeId(ownerId, 128) && input.ownerId === ownerId);
  ensure(environment(input.environment) && (suppliedEnvironment === undefined || suppliedEnvironment === input.environment));
  ensure(timestamp(input.serverTime));
}

export function isFarmPage(value, ownerId, kind, suppliedEnvironment) {
  return boolean(() => {
    const input = fields(value, ['recordFormat', 'ownerId', 'environment', 'kind', 'items', 'nextCursor', 'serverTime']);
    envelope(input, ownerId, suppliedEnvironment);
    ensure((kind === 'plots' || kind === 'animals') && input.kind === kind);
    const items = array(input.items, FARM_PAGE_SIZE);
    let previousId = null;
    for (const value of items) {
      const record = publicRecord(value, ownerId, input.environment, input.serverTime);
      ensure(record.kind === (kind === 'plots' ? 'plot' : 'animal'));
      ensure(previousId === null || previousId < record.id);
      previousId = record.id;
    }
    ensure(input.nextCursor === null || (items.length > 0 && input.nextCursor === previousId));
  });
}

export function isFarmDetail(value, ownerId, recordId, suppliedEnvironment) {
  return boolean(() => {
    const input = fields(value, ['recordFormat', 'ownerId', 'environment', 'record', 'events', 'nextBeforeVersion', 'serverTime']);
    envelope(input, ownerId, suppliedEnvironment);
    ensure(exactMatch(recordId, RECORD_ID));
    const current = publicRecord(input.record, ownerId, input.environment, input.serverTime);
    ensure(current.id === recordId);
    const events = array(input.events, FARM_PAGE_SIZE);
    let previousVersion = null;
    let newerRecord = current;
    for (const value of events) {
      const event = fields(value, ['version', 'recordedAt', 'source', 'record']);
      ensure(integer(event.version, 1) && event.version <= current.version && exactMatch(event.source, SOURCE_ID));
      ensure(timestamp(event.recordedAt) && event.recordedAt <= input.serverTime);
      ensure(previousVersion === null || event.version < previousVersion);
      const record = publicRecord(event.record, ownerId, input.environment, input.serverTime);
      ensure(record.version === event.version && record.updatedAt === event.recordedAt);
      if (event.version === current.version) ensure(JSON.stringify(record) === JSON.stringify(current));
      else transition(record, newerRecord);
      previousVersion = event.version;
      newerRecord = record;
    }
    ensure(input.nextBeforeVersion === null ||
      (events.length > 0 && integer(input.nextBeforeVersion, 1) && input.nextBeforeVersion === previousVersion));
  });
}
