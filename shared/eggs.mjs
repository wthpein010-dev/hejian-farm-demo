// Strict daily-production boundary. No identity, date or quantity inferred from animal names.
export const EGGS_PAGE_SIZE = 20;
export const EGGS_ACTIONS = Object.freeze(['register', 'withdraw', 'collect']);
export const EGGS_CODES = Object.freeze(['OK', 'EGGS_UNAVAILABLE', 'NOT_FOUND', 'PROFILE_DISABLED', 'PROFILE_CHANGED', 'RECORD_CHANGED', 'BATCH_CHANGED', 'INVALID_STATE', 'DAILY_BATCH_EXISTS', 'SOURCE_EXISTS', 'QUANTITY_LIMIT', 'REVISION_CONFLICT', 'ASSET_LIMIT', 'IDEMPOTENCY_CONFLICT', 'INTENT_PENDING']);
const ensure = value => { if (!value) throw new TypeError('收蛋资料无效'); };
const integer = (x, min = 0) => Number.isSafeInteger(x) && x >= min;
const time = x => integer(x) && x <= 8.64e15;
const exact = (x, re) => typeof x === 'string' && re.test(x) && !/[\r\n]/u.test(x);
const safe = (x, max = 128) => typeof x === 'string' && x.length <= max && exact(x, /^[A-Za-z0-9_-]+$/u);
const recordId = x => exact(x, /^[a-z0-9][a-z0-9-]{7,63}$/u);
const key = x => exact(x, /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/u);
const source = x => exact(x, /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/u);
const text = x => typeof x === 'string' && x.trim().length > 0 && [...x].length <= 64 && !/[\u0000-\u001f\u007f]/u.test(x);
const environment = x => ['development', 'production'].includes(x);
export const isEggsId = x => exact(x, /^[a-f0-9]{32}$/u);
function fields(x, keys) {
  ensure(x && typeof x === 'object' && !Array.isArray(x));
  ensure([Object.prototype, null].includes(Object.getPrototypeOf(x)));
  const own = Reflect.ownKeys(x); ensure(own.length === keys.length);
  const result = {};
  for (const k of own) {
    ensure(typeof k === 'string' && keys.includes(k));
    const d = Object.getOwnPropertyDescriptor(x, k); ensure(d && Object.hasOwn(d, 'value') && d.enumerable);
    result[k] = d.value;
  }
  return result;
}
function array(value, max) {
  ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  ensure(integer(length) && length <= max && Reflect.ownKeys(value).length === length + 1);
  return Array.from({ length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); ensure(d && Object.hasOwn(d, 'value') && d.enumerable); return d.value; });
}
const bool = fn => { try { fn(); return true; } catch { return false; } };
const envelopeFields = ['eggFormat', 'ownerId', 'environment', 'serverTime'];
function envelope(x, ownerId, env) { ensure(x.eggFormat === 1 && safe(ownerId) && x.ownerId === ownerId && environment(env) && x.environment === env && time(x.serverTime)); }
export function isEggsCommand(input, audience = 'customer') {
  return bool(() => {
    ensure(['customer', 'staff'].includes(audience));
    const raw = fields(input, Reflect.ownKeys(input));
    const action = raw.action;
    const x = fields(input, ['domain', 'action', ...(action === 'register' ? ['recordId', 'expectedProfileVersion', 'sourceRef', 'quantity'] : ['batchId', 'expectedBatchVersion', ...(action === 'collect' ? ['expectedRevision'] : [])])]);
    ensure(x.domain === 'eggs' && (audience === 'customer' ? action === 'collect' : ['register', 'withdraw'].includes(action)));
    if (action === 'register') ensure(recordId(x.recordId) && integer(x.expectedProfileVersion, 1) && source(x.sourceRef) && integer(x.quantity, 1) && x.quantity <= 10000);
    else ensure(isEggsId(x.batchId) && integer(x.expectedBatchVersion, 1) && x.expectedBatchVersion <= 2);
    if (action === 'collect') ensure(integer(x.expectedRevision));
  });
}
export function normalizeEggsProvision(input) {
  const x = fields(input, ['recordId', 'expectedProfileVersion', 'recordVersion', 'profile', 'enabled', 'maxDailyQuantity', 'staff']);
  ensure(recordId(x.recordId) && integer(x.expectedProfileVersion) && x.expectedProfileVersion < Number.MAX_SAFE_INTEGER && integer(x.recordVersion, 1) && x.profile === 'chicken-eggs' && typeof x.enabled === 'boolean' && integer(x.maxDailyQuantity, 1) && x.maxDailyQuantity <= 10000);
  const seen = new Set();
  const staff = array(x.staff, 40).map(raw => { const s = fields(raw, ['accountId', 'role']); ensure(safe(s.accountId) && s.role === 'record' && !seen.has(s.accountId)); seen.add(s.accountId); return { accountId: s.accountId, role: s.role }; }).sort((a, b) => a.accountId.localeCompare(b.accountId));
  ensure(x.enabled || staff.length === 0);
  return { recordId: x.recordId, expectedProfileVersion: x.expectedProfileVersion, recordVersion: x.recordVersion, profile: x.profile, enabled: x.enabled, maxDailyQuantity: x.maxDailyQuantity, staff };
}
export function isEggsReceipt(value, ownerId, env, operationKey, action) {
  return bool(() => {
    const x = fields(value, ['eggFormat', 'ownerId', 'environment', 'operationKey', 'action', 'outcome', 'code', 'batchId', 'completedAt', 'quantity', 'appliedRevision']);
    ensure(x.eggFormat === 1 && safe(ownerId) && x.ownerId === ownerId && environment(env) && x.environment === env && key(operationKey) && x.operationKey === operationKey && EGGS_ACTIONS.includes(action) && x.action === action && EGGS_CODES.includes(x.code) && ['applied', 'refused'].includes(x.outcome) && (x.outcome === 'applied') === (x.code === 'OK') && (x.batchId === null || isEggsId(x.batchId)) && time(x.completedAt));
    ensure(x.code !== 'OK' || x.batchId !== null);
    if (x.code === 'OK' && action === 'collect') ensure(integer(x.quantity, 1) && x.quantity <= 10000 && integer(x.appliedRevision, 1));
    else ensure(x.quantity === 0 && x.appliedRevision === null);
  });
}
export function isEggsStatus(value, ownerId, env) {
  return bool(() => { const x = fields(value, [...envelopeFields, 'available', 'hasStaffAccess']); envelope(x, ownerId, env); ensure(typeof x.available === 'boolean' && typeof x.hasStaffAccess === 'boolean' && (!x.hasStaffAccess || x.available)); });
}
const recordFields = ['recordId', 'recordVersion', 'profileVersion', 'cycleRef', 'name', 'unitLabel', 'enabled', 'maxDailyQuantity', 'currentBatchId', 'permissions'];
function record(value) {
  const x = fields(value, recordFields), p = fields(x.permissions, ['canRegister']);
  ensure(recordId(x.recordId) && integer(x.recordVersion, 1) && integer(x.profileVersion) && safe(x.cycleRef, 64) && text(x.name) && text(x.unitLabel) && typeof x.enabled === 'boolean' && typeof p.canRegister === 'boolean');
  ensure(x.maxDailyQuantity === null || (integer(x.maxDailyQuantity, 1) && x.maxDailyQuantity <= 10000));
  ensure(x.currentBatchId === null || isEggsId(x.currentBatchId));
  ensure(!x.enabled || (x.profileVersion > 0 && x.maxDailyQuantity !== null));
  ensure(x.profileVersion !== 0 || (!x.enabled && x.maxDailyQuantity === null));
  ensure(!p.canRegister || (x.enabled && x.currentBatchId === null));
  return x;
}
export function isEggsRecord(value, ownerId, env, id) {
  return bool(() => { const x = fields(value, [...envelopeFields, ...recordFields]); envelope(x, ownerId, env); const r = record(Object.fromEntries(recordFields.map(k => [k, x[k]]))); ensure(r.recordId === id); });
}
export function isEggsRecordsPage(value, ownerId, env) {
  return bool(() => { const x = fields(value, [...envelopeFields, 'items', 'nextCursor']); envelope(x, ownerId, env); let prev = ''; const items = array(x.items, 20); for (const item of items) { const r = record(item); ensure(r.recordId > prev); prev = r.recordId; } ensure(x.nextCursor === null || (items.length === 20 && x.nextCursor === prev)); });
}
const batchFields = ['id', 'recordId', 'cycleRef', 'name', 'unitLabel', 'day', 'sourceRef', 'quantity', 'status', 'version', 'createdAt', 'updatedAt', 'collectedAt', 'withdrawnAt'];
function batch(value, now) {
  const x = fields(value, batchFields);
  ensure(isEggsId(x.id) && recordId(x.recordId) && safe(x.cycleRef, 64) && text(x.name) && text(x.unitLabel) && exact(x.day, /^\d{4}-\d{2}-\d{2}$/u) && Number.isFinite(Date.parse(x.day + 'T00:00:00Z')) && new Date(Date.parse(x.day + 'T00:00:00Z')).toISOString().slice(0, 10) === x.day && source(x.sourceRef) && integer(x.quantity, 1) && x.quantity <= 10000 && ['available', 'collected', 'withdrawn'].includes(x.status));
  ensure(time(x.createdAt) && time(x.updatedAt) && x.createdAt <= x.updatedAt && x.updatedAt <= now && new Date(x.createdAt + 28800000).toISOString().slice(0, 10) === x.day);
  ensure(x.version === (x.status === 'available' ? 1 : 2));
  ensure(x.status === 'collected' ? time(x.collectedAt) && x.collectedAt === x.updatedAt : x.collectedAt === null);
  ensure(x.status === 'withdrawn' ? time(x.withdrawnAt) && x.withdrawnAt === x.updatedAt : x.withdrawnAt === null);
  ensure(x.status !== 'available' || x.createdAt === x.updatedAt);
  return x;
}
export function isEggsPage(value, ownerId, env) {
  return bool(() => { const x = fields(value, [...envelopeFields, 'items', 'nextCursor']); envelope(x, ownerId, env); let prev = ''; const items = array(x.items, 20); for (const item of items) { const b = batch(item, x.serverTime); ensure(b.id > prev); prev = b.id; } ensure(x.nextCursor === null || (items.length === 20 && x.nextCursor === prev)); });
}
export function isEggsDetail(value, ownerId, env, id) {
  return bool(() => { const x = fields(value, [...envelopeFields, 'batch', 'permissions']); envelope(x, ownerId, env); const b = batch(x.batch, x.serverTime), p = fields(x.permissions, ['canCollect', 'canWithdraw']); ensure(b.id === id && typeof p.canCollect === 'boolean' && typeof p.canWithdraw === 'boolean' && !(p.canCollect && p.canWithdraw) && ((!p.canCollect && !p.canWithdraw) || b.status === 'available')); });
}
