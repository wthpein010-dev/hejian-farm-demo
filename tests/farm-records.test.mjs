import test from 'node:test';
import assert from 'node:assert/strict';

const contract = await import('../shared/farm-records.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const NOW = 1_800_000_000_000;
const ENVIRONMENT = 'development';
const OWNER = 'account_A-1';
const options = { environment: ENVIRONMENT, now: NOW };
const rawRecord = (overrides = {}) => ({
  id: 'plot-001', ownerId: OWNER, kind: 'plot', name: '秋季番茄', unitLabel: '东田一号',
  cycleRef: 'season_2026-1', status: 'growing', startedAt: NOW - 5000,
  expectedHarvestAt: NOW + 86_400_000, observedAt: NOW - 1000,
  measurements: { areaM2: 12.5, moisturePercent: 40 }, ...overrides,
});
function required(name) {
  assert.equal(typeof contract[name], 'function', `Missing contract export: ${name}`);
  return contract[name];
}
function rejectsRecord(value, suppliedOptions = options) {
  const normalize = required('normalizeFarmRecord');
  const ValidationError = required('FarmRecordValidationError');
  assert.throws(() => normalize(value, suppliedOptions), error =>
    error instanceof ValidationError && error.message === '农场档案数据无效');
}

test('normalization rebuilds an isolated canonical record with server-owned environment', () => {
  const input = rawRecord();
  const result = required('normalizeFarmRecord')(input, options);
  assert.deepEqual(result, {
    id: 'plot-001', ownerId: 'account_A-1', kind: 'plot', name: '秋季番茄', unitLabel: '东田一号',
    cycleRef: 'season_2026-1', status: 'growing', startedAt: NOW - 5000,
    expectedHarvestAt: NOW + 86_400_000, observedAt: NOW - 1000,
    measurements: { areaM2: 12.5, moisturePercent: 40 }, environment: 'development',
  });
  assert.equal(JSON.stringify(result).indexOf('"id"'), 1);
  input.measurements.moisturePercent = 99;
  assert.equal(result.measurements.moisturePercent, 40);
});

test('unknown or accessor input fields are rejected without evaluating getters', () => {
  for (const extra of [{ environment: 'production' }, { address: 'private' }, { version: 1 }]) {
    rejectsRecord(rawRecord(extra));
  }
  let reads = 0;
  const input = rawRecord();
  Object.defineProperty(input, 'name', { enumerable: true, get() { reads++; return 'secret'; } });
  rejectsRecord(input);
  const measurements = {};
  Object.defineProperty(measurements, 'areaM2', { enumerable: true, get() { reads++; return 10; } });
  rejectsRecord(rawRecord({ measurements }));
  assert.equal(reads, 0);
});

test('nonplain, hidden, symbol and missing data fields cannot cross the record boundary', () => {
  rejectsRecord(Object.assign(Object.create({ private: true }), rawRecord()));
  rejectsRecord(new Map(Object.entries(rawRecord())));
  const hidden = rawRecord();
  Object.defineProperty(hidden, 'secret', { value: 'private' });
  rejectsRecord(hidden);
  rejectsRecord({ ...rawRecord(), [Symbol('secret')]: 1 });
  const missing = rawRecord(); delete missing.expectedHarvestAt;
  rejectsRecord(missing);
});

test('safe IDs and Unicode display fields enforce their lengths without accepting line endings', () => {
  const normalize = required('normalizeFarmRecord');
  assert.equal(normalize(rawRecord({ ownerId: 'A'.repeat(128), cycleRef: 'x'.repeat(64),
    name: '田'.repeat(64), unitLabel: '🌾'.repeat(64) }), options).name.length, 64);
  for (const override of [
    { id: 'short' }, { id: 'PLOT-001' }, { id: 'plot-001\n' }, { id: 'a'.repeat(65) },
    { ownerId: '../owner' }, { ownerId: 'x'.repeat(129) }, { ownerId: '' },
    { cycleRef: 'x'.repeat(65) }, { cycleRef: '' }, { cycleRef: '轮次' },
    { name: '' }, { name: '田'.repeat(65) }, { unitLabel: '🌾'.repeat(65) },
  ]) rejectsRecord(rawRecord(override));
});

test('timestamps are representable integer milliseconds with observed and starting order', () => {
  const normalize = required('normalizeFarmRecord');
  assert.equal(normalize(rawRecord({ startedAt: null, expectedHarvestAt: null }), options).startedAt, null);
  assert.equal(normalize(rawRecord({ startedAt: 0, observedAt: 0, expectedHarvestAt: 8_640_000_000_000_000 }), options)
    .expectedHarvestAt, 8_640_000_000_000_000);
  for (const override of [
    { startedAt: -1 }, { observedAt: NOW + 1 }, { observedAt: NOW + 0.5 },
    { observedAt: NaN }, { expectedHarvestAt: Infinity }, { expectedHarvestAt: 8_640_000_000_000_001 },
    { startedAt: NOW }, { expectedHarvestAt: NOW - 5001 }, { observedAt: null },
  ]) rejectsRecord(rawRecord(override));
  for (const badNow of [undefined, -1, Infinity, 8_640_000_000_000_001]) {
    rejectsRecord(rawRecord(), { environment: ENVIRONMENT, now: badNow });
  }
  rejectsRecord(rawRecord(), { environment: 'test', now: NOW });
});

test('plot measurements reject animal values and enforce finite numeric ranges', () => {
  const normalize = required('normalizeFarmRecord');
  assert.deepEqual(normalize(rawRecord({ measurements: {} }), options).measurements, {});
  assert.deepEqual(normalize(rawRecord({ measurements: { areaM2: Number.MIN_VALUE, moisturePercent: 100 } }), options)
    .measurements, { areaM2: Number.MIN_VALUE, moisturePercent: 100 });
  for (const measurements of [
    { weightKg: 1 }, { headCount: 1 }, { notes: 'private' }, [], null,
    { areaM2: 0 }, { areaM2: -1 }, { areaM2: Infinity }, { areaM2: '12' },
    { moisturePercent: -0.01 }, { moisturePercent: 100.01 }, { moisturePercent: NaN },
  ]) rejectsRecord(rawRecord({ measurements }));
});

test('animal measurements allow zero observations but reject fractional or unsafe head counts', () => {
  const normalize = required('normalizeFarmRecord');
  assert.deepEqual(normalize(rawRecord({ kind: 'animal', measurements: { weightKg: 0, headCount: 0 } }), options)
    .measurements, { weightKg: 0, headCount: 0 });
  for (const measurements of [
    { areaM2: 1 }, { moisturePercent: 1 }, { weightKg: -1 }, { weightKg: Infinity },
    { headCount: 0.5 }, { headCount: Number.MAX_SAFE_INTEGER + 1 }, { headCount: -1 },
  ]) rejectsRecord(rawRecord({ kind: 'animal', measurements }));
  rejectsRecord(rawRecord({ kind: 'other' }));
  rejectsRecord(rawRecord({ status: 'paid' }));
});

test('hostile reflection failures are replaced with the fixed safe validation error', () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('private payload'); } });
  rejectsRecord(hostile);
});

const batch = (entries = [{ expectedVersion: 0, record: rawRecord() }]) =>
  ({ formatVersion: 1, batchId: 'batch-001', source: 'farm-east', entries });
const publicRecord = (overrides = {}) => ({ ...rawRecord(), environment: ENVIRONMENT,
  version: 3, createdAt: NOW - 10_000, updatedAt: NOW - 500, ...overrides });
const page = (overrides = {}) => ({ recordFormat: 1, ownerId: OWNER, environment: ENVIRONMENT,
  kind: 'plots', items: [publicRecord()], nextCursor: null, serverTime: NOW, ...overrides });
function detail(overrides = {}) {
  const current = publicRecord();
  return { recordFormat: 1, ownerId: OWNER, environment: ENVIRONMENT, record: current,
    events: [
      { version: 3, recordedAt: NOW - 500, source: 'farm-east', record: structuredClone(current) },
      { version: 2, recordedAt: NOW - 2000, source: 'farm-east', record: publicRecord({
        version: 2, observedAt: NOW - 3000, updatedAt: NOW - 2000, status: 'planned', startedAt: null,
      }) },
    ], nextBeforeVersion: null, serverTime: NOW, ...overrides };
}
function rejectsBatch(value) {
  const normalize = required('normalizeFarmBatch');
  const ValidationError = required('FarmRecordValidationError');
  assert.throws(() => normalize(value, options), ValidationError);
}

test('a batch canonicalizes entries without adding client-selected environment or sharing input references', () => {
  const input = batch();
  const result = required('normalizeFarmBatch')(input, options);
  assert.deepEqual(Object.keys(result), ['formatVersion', 'batchId', 'source', 'entries']);
  assert.deepEqual(Object.keys(result.entries[0]), ['expectedVersion', 'record']);
  assert.equal(result.entries[0].record.environment, 'development');
  input.entries[0].record.measurements.areaM2 = 99;
  assert.equal(result.entries[0].record.measurements.areaM2, 12.5);
});

test('batch size and unique IDs are checked before applying any import', () => {
  const normalize = required('normalizeFarmBatch');
  const entries = Array.from({ length: 100 }, (_, index) => ({ expectedVersion: 0,
    record: rawRecord({ id: `plot-${String(index).padStart(3, '0')}` }) }));
  assert.equal(normalize(batch(entries), options).entries.length, 100);
  rejectsBatch(batch([]));
  rejectsBatch(batch([...entries, { expectedVersion: 0, record: rawRecord({ id: 'plot-100' }) }]));
  rejectsBatch(batch([{ expectedVersion: 0, record: rawRecord() }, { expectedVersion: 1, record: rawRecord() }]));
});

test('batch shape, version, source and optimistic versions reject malformed imports', () => {
  for (const value of [
    { ...batch(), formatVersion: 2 }, { ...batch(), environment: ENVIRONMENT },
    { ...batch(), batchId: 'bad' }, { ...batch(), source: 'ab' }, { ...batch(), source: 'farm-east\n' },
    { ...batch(), source: 'Farm-East' }, { ...batch(), source: 'x'.repeat(65) },
    batch([{ expectedVersion: -1, record: rawRecord() }]),
    batch([{ expectedVersion: 0.5, record: rawRecord() }]),
    batch([{ expectedVersion: Number.MAX_SAFE_INTEGER + 1, record: rawRecord() }]),
    batch([{ record: rawRecord() }]), batch([{ expectedVersion: 0, record: rawRecord(), private: true }]),
  ]) rejectsBatch(value);
});

test('sparse, decorated, accessor and subclass arrays do not masquerade as JSON batches', () => {
  const sparse = Array(1);
  const decorated = batch().entries; decorated.private = true;
  let reads = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return batch().entries[0]; } });
  class Entries extends Array {}
  for (const entries of [sparse, decorated, accessor, new Entries(...batch().entries)]) rejectsBatch(batch(entries));
  assert.equal(reads, 0);
});

test('public record validation binds owner and environment without consulting the local clock', () => {
  const isRecord = required('isFarmRecord');
  assert.equal(isRecord(publicRecord(), OWNER, ENVIRONMENT), true);
  assert.equal(isRecord(publicRecord(), 'another-account', ENVIRONMENT), false);
  assert.equal(isRecord(publicRecord(), OWNER, 'production'), false);
  assert.equal(isRecord({ ...rawRecord(), environment: ENVIRONMENT }, OWNER, ENVIRONMENT), false);
  for (const override of [
    { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: NOW }, { updatedAt: NOW - 2000 }, { updatedAt: 8_640_000_000_000_001 },
    { observedAt: NOW }, { private: true }, { environment: 'test' },
  ]) assert.equal(isRecord(publicRecord(override), OWNER, ENVIRONMENT), false, JSON.stringify(override));
});

test('pages validate server time, bounded count, same owner/environment and category', () => {
  const isPage = required('isFarmPage');
  assert.equal(isPage(page(), OWNER, 'plots', ENVIRONMENT), true);
  assert.equal(isPage(page(), OWNER, 'plots'), true);
  assert.equal(isPage(page({ items: [] }), OWNER, 'plots', ENVIRONMENT), true);
  const animal = publicRecord({ kind: 'animal', measurements: { headCount: 2 } });
  assert.equal(isPage(page({ kind: 'animals', items: [animal] }), OWNER, 'animals', ENVIRONMENT), true);
  for (const value of [
    page({ ownerId: 'another' }), page({ environment: 'production' }), page({ kind: 'animals' }),
    page({ serverTime: NOW - 501 }), page({ serverTime: Infinity }), page({ recordFormat: 2 }),
    page({ private: true }), page({ items: [publicRecord({ ownerId: 'another' })] }),
    page({ items: [publicRecord({ environment: 'production' })] }), page({ items: [animal] }),
    page({ items: Array.from({ length: 21 }, (_, index) => publicRecord({ id: `plot-${String(index).padStart(3, '0')}` })) }),
  ]) assert.equal(isPage(value, OWNER, 'plots', ENVIRONMENT), false);
});

test('page cursors identify the last item of a nonempty strictly ascending unique page', () => {
  const isPage = required('isFarmPage');
  const items = [publicRecord({ id: 'plot-001' }), publicRecord({ id: 'plot-002' })];
  assert.equal(isPage(page({ items, nextCursor: 'plot-002' }), OWNER, 'plots'), true);
  for (const value of [
    page({ items, nextCursor: 'plot-001' }), page({ items: [], nextCursor: 'plot-002' }),
    page({ items: [items[1], items[0]] }), page({ items: [items[0], items[0]] }),
    page({ nextCursor: 0 }), page({ nextCursor: undefined }),
  ]) assert.equal(isPage(value, OWNER, 'plots'), false);
});

test('detail validates public snapshots, descending event versions and an exclusive page cursor', () => {
  const isDetail = required('isFarmDetail');
  assert.equal(isDetail(detail(), OWNER, 'plot-001', ENVIRONMENT), true);
  assert.equal(isDetail(detail({ nextBeforeVersion: 2 }), OWNER, 'plot-001'), true);
  assert.equal(isDetail(detail({ events: [] }), OWNER, 'plot-001'), true);
  for (const value of [
    detail({ nextBeforeVersion: 3 }), detail({ nextBeforeVersion: 0 }), detail({ nextBeforeVersion: 1.5 }),
    detail({ events: [], nextBeforeVersion: 2 }), detail({ events: detail().events.toReversed() }),
    detail({ events: [detail().events[0], detail().events[0]] }), detail({ serverTime: NOW - 501 }),
    detail({ ownerId: 'another' }), detail({ environment: 'production' }), detail({ private: true }),
    detail({ record: publicRecord({ id: 'plot-002' }) }),
  ]) assert.equal(isDetail(value, OWNER, 'plot-001', ENVIRONMENT), false);
});

test('detail rejects event snapshots from another owner, environment, kind or cycle and inconsistent event metadata', () => {
  const isDetail = required('isFarmDetail');
  const overrides = [
    { id: 'plot-002' }, { ownerId: 'another' }, { environment: 'production' },
    { kind: 'animal', measurements: {} }, { cycleRef: 'another-cycle' },
    { version: 1 }, { updatedAt: NOW - 100 }, { createdAt: NOW - 9000 },
  ];
  for (const override of overrides) {
    const value = detail(); Object.assign(value.events[1].record, override);
    assert.equal(isDetail(value, OWNER, 'plot-001'), false, JSON.stringify(override));
  }
  for (const override of [{ version: 4 }, { recordedAt: NOW + 1 }, { source: 'bad/source' }, { extra: true }]) {
    const value = detail(); Object.assign(value.events[0], override);
    assert.equal(isDetail(value, OWNER, 'plot-001'), false);
  }
  const mismatch = detail(); mismatch.events[0].record.name = 'different snapshot';
  assert.equal(isDetail(mismatch, OWNER, 'plot-001'), false);
  const oversized = detail({ events: Array(21).fill(detail().events[0]) });
  assert.equal(isDetail(oversized, OWNER, 'plot-001'), false);
});

test('transition validation preserves record identity, known start, status and observation progression', () => {
  const transition = required('validateFarmRecordTransition');
  const normalize = required('normalizeFarmRecord');
  const previous = publicRecord({ status: 'planned', startedAt: null });
  const next = normalize(rawRecord({ status: 'ready', observedAt: NOW }), options);
  assert.equal(transition(previous, next, options).status, 'ready');
  for (const override of [
    { id: 'plot-002' }, { ownerId: 'another' }, { cycleRef: 'next-cycle' },
    { kind: 'animal', measurements: {} }, { status: 'planned' },
    { observedAt: NOW - 1001 }, { startedAt: null }, { startedAt: NOW - 5001 },
  ]) {
    const changed = normalize(rawRecord(override), options);
    assert.throws(() => transition(publicRecord(), changed, options), required('FarmRecordValidationError'));
  }
  assert.throws(() => transition(publicRecord({ status: 'archived' }), next, options), required('FarmRecordValidationError'));
  assert.throws(() => transition(publicRecord(), { ...next, environment: 'production' }, options), required('FarmRecordValidationError'));
});

test('detail cannot present a historical observation or status later than its current record', () => {
  const isDetail = required('isFarmDetail');
  for (const override of [
    { status: 'archived' }, { observedAt: NOW - 500, updatedAt: NOW - 500 },
    { startedAt: NOW - 6000 },
  ]) {
    const value = detail(); Object.assign(value.events[1].record, override);
    value.events[1].recordedAt = value.events[1].record.updatedAt;
    assert.equal(isDetail(value, OWNER, 'plot-001'), false, JSON.stringify(override));
  }
});
