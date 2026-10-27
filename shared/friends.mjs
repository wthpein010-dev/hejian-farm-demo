// Strict, platform-neutral wire contract. Never includes financial state or platform identity.
export const FRIEND_ACTIONS = Object.freeze(['enable', 'disable', 'request', 'accept', 'decline', 'cancel', 'remove', 'block', 'unblock']);
export const FRIEND_REFUSAL_CODES = Object.freeze(['FRIENDS_UNAVAILABLE', 'FRIENDS_DISABLED', 'PEER_UNAVAILABLE', 'ALREADY_PENDING',
  'ALREADY_FRIENDS', 'REQUEST_NOT_FOUND', 'RELATION_NOT_FOUND', 'BLOCK_NOT_FOUND', 'FRIEND_LIMIT', 'BLOCK_LIMIT', 'DAILY_REQUEST_LIMIT', 'IDEMPOTENCY_CONFLICT', 'FRIENDS_CHANGED']);
export const isFriendCode = value => typeof value === 'string' && /^[a-f0-9]{32}(?![\s\S])/u.test(value);
export const isFriendPeerId = isFriendCode;
const alias = value => typeof value === 'string' && /^农友[a-f0-9]{8}(?![\s\S])/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => integer(value) && value <= 8.64e15;
const environment = value => ['development', 'production'].includes(value);
const owner = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?![\s\S])/u.test(value);
function fields(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && d.enumerable && Object.hasOwn(d, 'value'); });
}
export function isFriendCommand(input) {
  try {
    if (!input || typeof input !== 'object') return false;
    const d = Object.getOwnPropertyDescriptor(input, 'action');
    if (!d || !Object.hasOwn(d, 'value') || !FRIEND_ACTIONS.includes(d.value)) return false;
    const action = d.value, keys = ['action', 'expectedVersion', ...(action === 'request' ? ['code'] : ['enable', 'disable'].includes(action) ? [] : ['peerId'])];
    return fields(input, keys) && integer(input.expectedVersion) && (action === 'request' ? isFriendCode(input.code) : keys.length === 2 || isFriendPeerId(input.peerId));
  } catch { return false; }
}
export function isFriendCommandReceipt(value, ownerId, mode, key, action) {
  try {
    return fields(value, ['friendsFormat', 'ownerId', 'environment', 'operationKey', 'action', 'outcome', 'code', 'completedAt']) &&
      value.friendsFormat === 1 && owner(value.ownerId) && value.ownerId === ownerId && environment(value.environment) && value.environment === mode &&
      typeof value.operationKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}(?![\s\S])/u.test(value.operationKey) && value.operationKey === key &&
      FRIEND_ACTIONS.includes(value.action) && value.action === action && time(value.completedAt) &&
      (mode !== 'production' || value.outcome === 'refused') &&
      (value.outcome === 'applied' ? value.code === 'OK' : value.outcome === 'refused' && FRIEND_REFUSAL_CODES.includes(value.code));
  } catch { return false; }
}
export function isFriendsView(value, ownerId, mode) {
  try {
    if (!fields(value, ['friendsFormat', 'ownerId', 'environment', 'serverTime', 'version', 'available', 'enabled', 'profile', 'friends', 'incoming', 'outgoing', 'blocked']) ||
      value.friendsFormat !== 1 || !owner(value.ownerId) || value.ownerId !== ownerId || !environment(value.environment) || value.environment !== mode ||
      !time(value.serverTime) || !integer(value.version) || typeof value.available !== 'boolean' || typeof value.enabled !== 'boolean') return false;
    if ((mode === 'production' && value.available) || (!value.available && value.version !== 0) || (value.enabled && value.version < 1)) return false;
    if (value.enabled ? !value.available || !fields(value.profile, ['code', 'alias']) || !isFriendCode(value.profile.code) || !alias(value.profile.alias) : value.profile !== null) return false;
    const ids = new Set(); let active = 0;
    for (const kind of ['friends', 'incoming', 'outgoing', 'blocked']) {
      const list = value[kind];
      if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length > 200 || Reflect.ownKeys(list).length !== list.length + 1) return false;
      for (let i = 0; i < list.length; i++) {
        const d = Object.getOwnPropertyDescriptor(list, String(i)); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return false;
        const entry = d.value;
        if (!fields(entry, ['peerId', 'alias', 'createdAt']) || !isFriendPeerId(entry.peerId) || !alias(entry.alias) || entry.alias !== '农友' + entry.peerId.slice(0, 8) ||
          !time(entry.createdAt) || entry.createdAt > value.serverTime || ids.has(entry.peerId)) return false;
        ids.add(entry.peerId);
      }
      if (kind !== 'blocked') active += list.length;
    }
    return active <= 200 && (value.enabled || ids.size === 0) && (value.available || !value.enabled);
  } catch { return false; }
}
