import { isPlantingCommand, isPlantingReceipt } from './planting.mjs';

export const RECOVERY_CODES = Object.freeze([
  'OK',
  'SLOT_CHANGED',
  'EPOCH_CHANGED',
  'PREPARE_CONFLICT',
  'RECOVERY_UNAVAILABLE',
]);
const operations = ['prepare', 'execute', 'ack', 'abandon'];
const phases = ['prepared', 'settled', 'abandoned', 'quarantined'];
const ensure = (value) => {
  if (!value) throw new TypeError('恢复资料无效');
};
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const time = (value) => integer(value) && value <= 8.64e15;
export const isRecoveryId = (value) =>
  typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value) && !/[\r\n]/u.test(value);
const safe = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 128 &&
  /^[A-Za-z0-9_-]+$/u.test(value) &&
  !/[\r\n]/u.test(value);
const validEnvironment = (value) => value === 'development' || value === 'production';
function fields(value, keys) {
  ensure(value && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null);
  const names = Reflect.ownKeys(value);
  ensure(names.length === keys.length);
  const result = {};
  for (const key of names) {
    ensure(typeof key === 'string' && keys.includes(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  return result;
}
const check = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const canonicalCommand = (command) =>
  Object.fromEntries(
    Object.keys(command)
      .sort()
      .map((key) => [key, command[key]]),
  );
function prepare(input) {
  const value = fields(input, ['expectedEpoch', 'expectedVersion', 'audience', 'command']);
  ensure(isRecoveryId(value.expectedEpoch) && integer(value.expectedVersion));
  ensure(
    ['customer', 'staff'].includes(value.audience) &&
      isPlantingCommand(value.command, value.audience),
  );
  return {
    expectedEpoch: value.expectedEpoch,
    expectedVersion: value.expectedVersion,
    audience: value.audience,
    command: canonicalCommand(value.command),
  };
}
export const isRecoveryPrepare = (value) => check(() => prepare(value));
function envelope(value, ownerId, environment) {
  ensure(value.recoveryFormat === 1 && safe(ownerId) && value.ownerId === ownerId);
  ensure(
    validEnvironment(environment) && value.environment === environment && time(value.serverTime),
  );
}
function intent(input, ownerId, environment, now) {
  const value = fields(input, [
    'id',
    'audience',
    'command',
    'operationKey',
    'prepareEpoch',
    'prepareVersion',
    'phase',
    'version',
    'createdAt',
    'updatedAt',
    'closedAt',
    'receipt',
  ]);
  ensure(isRecoveryId(value.id) && value.operationKey === 'intent-' + value.id);
  ensure(isRecoveryId(value.prepareEpoch) && integer(value.prepareVersion));
  ensure(
    ['customer', 'staff'].includes(value.audience) &&
      isPlantingCommand(value.command, value.audience) &&
      phases.includes(value.phase),
  );
  ensure(integer(value.version, 1) && time(value.createdAt) && time(value.updatedAt));
  ensure(value.createdAt <= value.updatedAt && value.updatedAt <= now);
  ensure(value.closedAt === null || (time(value.closedAt) && value.closedAt === value.updatedAt));
  if (value.phase === 'prepared') {
    ensure(
      value.version === 1 &&
        value.receipt === null &&
        value.closedAt === null &&
        value.updatedAt === value.createdAt,
    );
  } else if (value.phase === 'settled') {
    ensure(value.version === (value.closedAt === null ? 2 : 3));
    ensure(
      isPlantingReceipt(
        value.receipt,
        ownerId,
        environment,
        value.operationKey,
        value.command.action,
      ),
    );
    ensure(
      value.receipt.completedAt >= value.createdAt && value.receipt.completedAt <= value.updatedAt,
    );
    ensure(value.closedAt !== null || value.receipt.completedAt === value.updatedAt);
  } else if (value.phase === 'abandoned') {
    ensure(value.version === 2 && value.receipt === null && value.closedAt !== null);
  } else {
    ensure(value.version >= 2 && value.receipt === null && value.closedAt === null);
  }
  return value;
}
export function isRecoveryView(input, ownerId, environment) {
  return check(() => {
    const value = fields(input, [
      'recoveryFormat',
      'ownerId',
      'environment',
      'serverTime',
      'available',
      'epoch',
      'version',
      'intent',
    ]);
    envelope(value, ownerId, environment);
    ensure(
      typeof value.available === 'boolean' && isRecoveryId(value.epoch) && integer(value.version),
    );
    ensure(environment !== 'production' || value.available === false);
    if (value.intent !== null) {
      const original = intent(value.intent, ownerId, environment, value.serverTime);
      ensure(
        original.closedAt === null &&
          original.phase !== 'abandoned' &&
          value.version > original.prepareVersion,
      );
      ensure(value.version >= original.prepareVersion + original.version);
      ensure(
        original.phase !== 'prepared' ||
          (original.prepareEpoch === value.epoch && value.version === original.prepareVersion + 1),
      );
      ensure(original.phase !== 'quarantined' || original.prepareEpoch !== value.epoch);
    }
  });
}
export function isRecoveryDetail(input, ownerId, environment, id) {
  return check(() => {
    const value = fields(input, [
      'recoveryFormat',
      'ownerId',
      'environment',
      'serverTime',
      'intent',
    ]);
    envelope(value, ownerId, environment);
    ensure(
      isRecoveryId(id) && intent(value.intent, ownerId, environment, value.serverTime).id === id,
    );
  });
}
export function isRecoveryResult(input, ownerId, environment, operation, attempt) {
  return check(() => {
    const value = fields(input, [
      'recoveryFormat',
      'ownerId',
      'environment',
      'serverTime',
      'operation',
      'code',
      'epoch',
      'version',
      'currentIntentId',
      'intent',
      'attempt',
    ]);
    envelope(value, ownerId, environment);
    ensure(
      operations.includes(operation) &&
        value.operation === operation &&
        RECOVERY_CODES.includes(value.code),
    );
    ensure(isRecoveryId(value.epoch) && integer(value.version));
    ensure(
      value.currentIntentId === null || (isRecoveryId(value.currentIntentId) && value.version >= 1),
    );
    let original = null;
    if (value.intent !== null)
      original = intent(value.intent, ownerId, environment, value.serverTime);
    if (operation === 'prepare') {
      const canonical = prepare(value.attempt);
      if (attempt !== undefined)
        ensure(JSON.stringify(canonical) === JSON.stringify(prepare(attempt)));
      if (value.code === 'OK') {
        ensure(
          original !== null &&
            original.prepareEpoch === canonical.expectedEpoch &&
            original.prepareVersion === canonical.expectedVersion,
        );
        ensure(
          original.audience === canonical.audience &&
            JSON.stringify(canonicalCommand(original.command)) ===
              JSON.stringify(canonical.command),
        );
      } else if (value.code === 'PREPARE_CONFLICT') {
        ensure(
          original !== null &&
            original.prepareEpoch === canonical.expectedEpoch &&
            original.prepareVersion === canonical.expectedVersion,
        );
        ensure(
          original.audience !== canonical.audience ||
            JSON.stringify(canonicalCommand(original.command)) !==
              JSON.stringify(canonical.command),
        );
      } else {
        ensure(original === null);
        if (value.code === 'EPOCH_CHANGED') ensure(canonical.expectedEpoch !== value.epoch);
        if (value.code === 'SLOT_CHANGED')
          ensure(
            canonical.expectedEpoch === value.epoch &&
              (canonical.expectedVersion !== value.version || value.currentIntentId !== null),
          );
      }
    } else {
      ensure(value.attempt === null && value.code === 'OK' && original !== null);
      if (operation === 'ack') ensure(original.phase === 'settled' && original.closedAt !== null);
      if (operation === 'execute' || operation === 'abandon')
        ensure(original.phase === 'settled' || original.phase === 'abandoned');
    }
    if (original) ensure(value.version >= original.prepareVersion + original.version);
    if (original && original.closedAt === null) {
      ensure(
        value.currentIntentId === original.id &&
          value.version >= original.prepareVersion + original.version,
      );
      if (original.phase === 'prepared')
        ensure(
          original.prepareEpoch === value.epoch && value.version === original.prepareVersion + 1,
        );
      if (original.phase === 'quarantined') ensure(original.prepareEpoch !== value.epoch);
    }
    if (original?.closedAt !== null && original !== null)
      ensure(value.currentIntentId !== original.id);
  });
}
