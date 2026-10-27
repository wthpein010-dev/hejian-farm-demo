// Historical checkout snapshots are the only authority for this read-only DTO.
// Keep this JSON boundary usable by both Node and uni-app without platform APIs.
export const EXCHANGE_PAGE_SIZE = 20;
export const RESOURCE_INFO = Object.freeze([
  { key: 'feed', title: '日常饲料', unit: '份', art: 'feed' },
  { key: 'fertilizer', title: '田园养护肥', unit: '份', art: 'fertilizer' },
  { key: 'tools', title: '农事工具', unit: '件', art: 'tools' },
  { key: 'seedPacks', title: '当季种子盒', unit: '份', art: 'seed' },
  { key: 'decorations', title: '庄园装扮', unit: '件', art: 'sign' },
].map(value => Object.freeze(value)));

const RESOURCE_KEYS = RESOURCE_INFO.map(value => value.key);
const EXCHANGE_FIELDS = ['id', 'day', 'items', 'count', 'subtotal', 'discount', 'total', 'couponId'];
const ITEM_FIELDS = ['sku', 'title', 'art', 'quantity', 'unitPoints', 'linePoints', 'grant'];
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?![\s\S])/u;
const ART_ID = /^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/u;

export class ExchangeValidationError extends Error {
  constructor() { super('积分兑换记录数据无效'); this.name = 'ExchangeValidationError'; this.code = 'EXCHANGE_DATA_INVALID'; }
}
export class ExchangeCursorError extends Error {
  constructor() { super('兑换记录翻页位置无效，请刷新记录'); this.name = 'ExchangeCursorError'; this.code = 'EXCHANGE_CURSOR_INVALID'; }
}

function ensure(condition) { if (!condition) throw new ExchangeValidationError(); }
function guarded(work) {
  try { return work(); }
  catch (failure) {
    if (failure instanceof ExchangeCursorError || failure instanceof ExchangeValidationError) throw failure;
    throw new ExchangeValidationError();
  }
}
function fields(value, required, optional = []) {
  ensure(value !== null && typeof value === 'object');
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]);
  ensure(keys.length >= required.length && keys.length <= allowed.size);
  const result = {};
  for (const key of keys) {
    ensure(typeof key === 'string' && allowed.has(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  for (const key of required) ensure(Object.hasOwn(result, key));
  return result;
}
function array(value, minimum = 0, maximum = 0xffffffff) {
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
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function add(left, right) { const value = left + right; ensure(integer(value)); return value; }
function multiply(left, right) { const value = left * right; ensure(integer(value)); return value; }
function safeId(value) { return typeof value === 'string' && PROFILE_ID.test(value); }
function displayText(value) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function day(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?![\s\S])/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), date = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && date >= 1 && date <= monthDays[month - 1];
}
export function isExchangeId(value) {
  return typeof value === 'string' && /^shop-api-[a-f0-9]{64}(?![\s\S])/u.test(value);
}
function resourceQuantities(value) {
  const input = fields(value, [], RESOURCE_KEYS), output = {};
  ensure(Object.keys(input).length > 0);
  for (const key of RESOURCE_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    ensure(integer(input[key], 1));
    output[key] = input[key];
  }
  return output;
}
function item(value) {
  const input = fields(value, ITEM_FIELDS);
  ensure(safeId(input.sku) && displayText(input.title));
  ensure(typeof input.art === 'string' && ART_ID.test(input.art));
  ensure(integer(input.quantity, 1) && integer(input.unitPoints) && integer(input.linePoints));
  ensure(multiply(input.unitPoints, input.quantity) === input.linePoints);
  return { sku: input.sku, title: input.title, art: input.art, quantity: input.quantity,
    unitPoints: input.unitPoints, linePoints: input.linePoints, grant: resourceQuantities(input.grant) };
}
function rawItem(value) {
  const input = fields(value, ['id', 'title', 'art', 'quantity', 'cost', 'lineTotal', 'grant'], ['description', 'category', 'limit']);
  return item({ sku: input.id, title: input.title, art: input.art, quantity: input.quantity,
    unitPoints: input.cost, linePoints: input.lineTotal, grant: input.grant });
}
function reconciled(input, items) {
  ensure(isExchangeId(input.id) && day(input.day));
  ensure(integer(input.count, 1) && integer(input.subtotal) && integer(input.discount) && integer(input.total));
  ensure(input.discount <= input.subtotal && input.total === input.subtotal - input.discount);
  ensure(input.couponId === null || safeId(input.couponId));
  ensure((input.couponId === null) === (input.discount === 0));
  const skus = new Set(), received = {};
  let count = 0, subtotal = 0;
  for (const entry of items) {
    ensure(!skus.has(entry.sku)); skus.add(entry.sku);
    count = add(count, entry.quantity); subtotal = add(subtotal, entry.linePoints);
    for (const [key, quantity] of Object.entries(entry.grant)) {
      received[key] = add(received[key] || 0, multiply(quantity, entry.quantity));
    }
  }
  ensure(items.length > 0 && input.count === count && input.subtotal === subtotal);
  const orderedReceived = {};
  for (const key of RESOURCE_KEYS) if (Object.hasOwn(received, key)) orderedReceived[key] = received[key];
  return { id: input.id, day: input.day, items, count: input.count, subtotal: input.subtotal,
    discount: input.discount, total: input.total, couponId: input.couponId, received: orderedReceived };
}
function projectRaw(value) {
  const input = fields(value, [...EXCHANGE_FIELDS, 'receiptId']);
  ensure(isExchangeId(input.id) && input.receiptId === input.id.slice(5));
  return reconciled(input, array(input.items, 1).map(rawItem));
}
export function toExchange(purchase) { return guarded(() => projectRaw(purchase)); }

function scope(value, pagination = false) {
  const input = fields(value, ['ownerId', 'environment', 'serverTime'], pagination ? ['cursor'] : []);
  ensure(safeId(input.ownerId) && ['development', 'production'].includes(input.environment) && integer(input.serverTime));
  return input;
}
function scopeFields(input) { return { ownerId: input.ownerId, environment: input.environment, serverTime: input.serverTime }; }
export function createExchangePage(purchases, options) {
  return guarded(() => {
    const context = scope(options, true), cursor = Object.hasOwn(context, 'cursor') ? context.cursor : 'start';
    if (cursor !== 'start' && !isExchangeId(cursor)) throw new ExchangeCursorError();
    const history = array(purchases).map(projectRaw), ids = new Set();
    let previousDay = '';
    for (const exchange of history) {
      ensure(!ids.has(exchange.id) && exchange.day >= previousDay);
      ids.add(exchange.id); previousDay = exchange.day;
    }
    let before = history.length;
    if (cursor !== 'start') {
      before = history.findIndex(exchange => exchange.id === cursor);
      if (before < 0) throw new ExchangeCursorError();
    }
    const start = Math.max(0, before - EXCHANGE_PAGE_SIZE);
    const items = history.slice(start, before).reverse();
    return { exchangeFormat: 1, ...scopeFields(context), items,
      nextCursor: start > 0 ? items[items.length - 1].id : null };
  });
}
export function createExchangeDetail(purchase, options) {
  return guarded(() => ({ exchangeFormat: 1, ...scopeFields(scope(options)), exchange: projectRaw(purchase) }));
}
function wireExchange(value) {
  const input = fields(value, [...EXCHANGE_FIELDS, 'received']);
  const result = reconciled(input, array(input.items, 1).map(item));
  const received = resourceQuantities(input.received);
  ensure(RESOURCE_KEYS.every(key => received[key] === result.received[key]));
  return result;
}
function wireScope(value, ownerId, environment, extra) {
  const input = fields(value, ['exchangeFormat', 'ownerId', 'environment', 'serverTime', ...extra]);
  ensure(input.exchangeFormat === 1 && input.ownerId === ownerId && input.environment === environment);
  scope({ ownerId: input.ownerId, environment: input.environment, serverTime: input.serverTime });
  return input;
}
function valid(work) { try { work(); return true; } catch { return false; } }
export function isExchangePage(value, ownerId, environment) {
  return valid(() => {
    const input = wireScope(value, ownerId, environment, ['items', 'nextCursor']);
    const items = array(input.items, 0, EXCHANGE_PAGE_SIZE).map(wireExchange), ids = new Set();
    let previousDay = null;
    for (const exchange of items) {
      ensure(!ids.has(exchange.id) && (previousDay === null || exchange.day <= previousDay));
      ids.add(exchange.id); previousDay = exchange.day;
    }
    ensure(input.nextCursor === null || (items.length === EXCHANGE_PAGE_SIZE && isExchangeId(input.nextCursor) && input.nextCursor === items[items.length - 1].id));
  });
}
export function isExchangeDetail(value, ownerId, environment) {
  return valid(() => { wireExchange(wireScope(value, ownerId, environment, ['exchange']).exchange); });
}
