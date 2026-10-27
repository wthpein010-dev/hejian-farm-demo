// The Store's login response is the only session wire format. Keep credentials
// in memory, and read descriptors before values so getters never run here.
const SESSION_FIELDS = ['token', 'expiresAt', 'environment', 'profile'];
const PROFILE_FIELDS = ['id', 'displayName'];
const TOKEN = /^[A-Za-z0-9_-]{43}(?![\s\S])/u;
// Preserve the safe account-ID contract already used by snapshots and records;
// current random UUIDs are one valid subset, not a new restriction on old IDs.
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?![\s\S])/u;

export class SessionValidationError extends Error {
  constructor() { super('登录回复不完整，请重试。'); this.name = 'SessionValidationError'; this.code = 'SESSION_DATA_INVALID'; }
}
function ensure(condition) { if (!condition) throw new SessionValidationError(); }
function fields(value, names) {
  ensure(value !== null && typeof value === 'object');
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  ensure(keys.length === names.length);
  const result = {};
  for (const key of keys) {
    ensure(typeof key === 'string' && names.includes(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  for (const name of names) ensure(Object.hasOwn(result, name));
  return result;
}

export function parseSession(value) {
  try {
    const session = fields(value, SESSION_FIELDS), profile = fields(session.profile, PROFILE_FIELDS);
    ensure(typeof session.token === 'string' && TOKEN.test(session.token));
    // No serverTime is supplied here. Structural validation cannot decide
    // expiry from the device clock; the server's session/401 check owns that.
    ensure(Number.isSafeInteger(session.expiresAt) && session.expiresAt > 0);
    ensure(session.environment === 'development' || session.environment === 'production');
    ensure(typeof profile.id === 'string' && PROFILE_ID.test(profile.id));
    ensure(typeof profile.displayName === 'string' && profile.displayName.length > 0);
    return { token: session.token, expiresAt: session.expiresAt, environment: session.environment,
      profile: { id: profile.id, displayName: profile.displayName } };
  } catch { throw new SessionValidationError(); }
}
