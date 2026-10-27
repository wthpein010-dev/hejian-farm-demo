import { createHash, randomBytes } from 'node:crypto';
import { isPlantingCommand, isPlantingReceipt } from '../../../shared/planting.mjs';
import {
  isRecoveryId,
  isRecoveryPrepare,
  isRecoveryView,
  isRecoveryDetail,
  isRecoveryResult,
} from '../../../shared/recovery.mjs';

// Store owns BEGIN IMMEDIATE for every mutation. Backup imports these exact definitions.
export const RECOVERY_TABLE_SQL = Object.freeze({
  recovery_epoch: `CREATE TABLE IF NOT EXISTS recovery_epoch (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  recovery_slots: `CREATE TABLE IF NOT EXISTS recovery_slots (
  owner_id TEXT NOT NULL REFERENCES users(id), environment TEXT NOT NULL CHECK(environment IN ('development','production')),
  version INTEGER NOT NULL CHECK(version >= 0), open_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,environment), FOREIGN KEY(environment,open_id) REFERENCES planting_intents(environment,id))`,
  planting_intents: `CREATE TABLE IF NOT EXISTS planting_intents (
  environment TEXT NOT NULL CHECK(environment IN ('development','production')), id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id), prepare_epoch TEXT NOT NULL, prepare_version INTEGER NOT NULL CHECK(prepare_version >= 0),
  fingerprint TEXT NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('customer','staff')), command_json TEXT NOT NULL, operation_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','settled','abandoned','quarantined')), version INTEGER NOT NULL CHECK(version >= 1),
  receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER,
  PRIMARY KEY(environment,id), FOREIGN KEY(owner_id,environment) REFERENCES recovery_slots(owner_id,environment))`,
});
export const RECOVERY_INDEX_SQL = Object.freeze({
  recovery_prepare_once: `CREATE UNIQUE INDEX IF NOT EXISTS recovery_prepare_once ON planting_intents(owner_id,environment,prepare_epoch,prepare_version)`,
  recovery_operation_once: `CREATE UNIQUE INDEX IF NOT EXISTS recovery_operation_once ON planting_intents(environment,owner_id,operation_key)`,
  recovery_one_open: `CREATE UNIQUE INDEX IF NOT EXISTS recovery_one_open ON planting_intents(owner_id,environment) WHERE closed_at IS NULL`,
});
export const RECOVERY_SQL =
  [...Object.values(RECOVERY_TABLE_SQL), ...Object.values(RECOVERY_INDEX_SQL)].join(';\n') + ';';
export class RecoveryError extends Error {
  constructor(code = 'INVALID_RECOVERY_DATA') {
    super('操作恢复暂不可用');
    this.name = 'RecoveryError';
    this.code = [
      'INVALID_RECOVERY_DATA',
      'NOT_FOUND',
      'RECOVERY_UNAVAILABLE',
      'RECOVERY_QUARANTINED',
      'INVALID_RECOVERY_STATE',
      'RECOVERY_PENDING',
      'RESERVED_OPERATION_KEY',
    ].includes(code)
      ? code
      : 'INVALID_RECOVERY_DATA';
  }
}
const invalid = () => {
  throw new RecoveryError();
};
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const time = (value) => integer(value) && value <= 8.64e15;
const safe = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 128 &&
  /^[A-Za-z0-9_-]+$/u.test(value) &&
  !/[\r\n]/u.test(value);
const random = () => randomBytes(16).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonicalCommand = (input) =>
  Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, input[key]]),
  );
const fingerprint = (audience, command) =>
  hash(JSON.stringify({ audience, command: canonicalCommand(command) }));
const canonicalPrepare = (input) => ({
  expectedEpoch: input.expectedEpoch,
  expectedVersion: input.expectedVersion,
  audience: input.audience,
  command: canonicalCommand(input.command),
});
const available = (user, environment) =>
  environment === 'development' &&
  user?.environment === environment &&
  user.identity_provider === 'development';
function increment(value) {
  if (!integer(value) || value >= Number.MAX_SAFE_INTEGER) invalid();
  return value + 1;
}
function parseIntent(row) {
  return {
    id: row.id,
    audience: row.audience,
    command: JSON.parse(row.command_json),
    operationKey: row.operation_key,
    prepareEpoch: row.prepare_epoch,
    prepareVersion: row.prepare_version,
    phase: row.phase,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
  };
}

export function createRecovery({ prepare, environment, executePlanting }) {
  if (
    typeof prepare !== 'function' ||
    typeof executePlanting !== 'function' ||
    !['development', 'production'].includes(environment)
  )
    invalid();
  prepare('INSERT OR IGNORE INTO recovery_epoch (singleton,epoch,created_at) VALUES (1,?,0)').run(
    random(),
  );
  const epoch = () => {
    const row = prepare('SELECT epoch FROM recovery_epoch WHERE singleton = 1').get();
    if (!isRecoveryId(row?.epoch)) invalid();
    return row.epoch;
  };
  const slot = (owner) =>
    prepare('SELECT * FROM recovery_slots WHERE owner_id = ? AND environment = ?').get(
      owner,
      environment,
    );
  const row = (owner, id) =>
    prepare('SELECT * FROM planting_intents WHERE environment = ? AND owner_id = ? AND id = ?').get(
      environment,
      owner,
      id,
    );
  const account = (owner) =>
    prepare('SELECT id,environment,identity_provider FROM users WHERE id = ?').get(owner);
  const stamp = (user, now) => ({
    recoveryFormat: 1,
    ownerId: user.id,
    environment,
    serverTime: now,
  });
  const enabled = (user) =>
    available(user, environment) && available(account(user.id), environment);
  function validateUser(user, now) {
    if (!safe(user?.id) || !time(now) || user.environment !== environment || !account(user.id))
      invalid();
  }
  function assertEnabled(user, now) {
    validateUser(user, now);
    if (!enabled(user)) throw new RecoveryError('RECOVERY_UNAVAILABLE');
  }
  function owned(user, id, now) {
    assertEnabled(user, now);
    if (!isRecoveryId(id)) invalid();
    const target = row(user.id, id);
    if (!target) throw new RecoveryError('NOT_FOUND');
    if (now < target.updated_at) invalid();
    return target;
  }
  function revoke(owner) {
    prepare('DELETE FROM deletion_confirmations WHERE user_id = ?').run(owner);
  }
  function bumpSlot(user, target, now, openId) {
    const current = slot(user.id);
    if (!current || current.open_id !== target.id || now < current.updated_at) invalid();
    const version = increment(current.version);
    prepare(
      'UPDATE recovery_slots SET version = ?, open_id = ?, updated_at = ? WHERE owner_id = ? AND environment = ?',
    ).run(version, openId, now, user.id, environment);
    revoke(user.id);
  }
  function result(user, operation, code, target, now, attempt = null) {
    const current = slot(user.id);
    const output = {
      ...stamp(user, now),
      operation,
      code,
      epoch: epoch(),
      version: current?.version ?? 0,
      currentIntentId: current?.open_id ?? null,
      intent: target ? parseIntent(target) : null,
      attempt,
    };
    if (!isRecoveryResult(output, user.id, environment, operation, attempt ?? undefined)) invalid();
    return output;
  }
  const api = {
    current(user, now) {
      validateUser(user, now);
      const current = slot(user.id);
      const target = current?.open_id ? row(user.id, current.open_id) : null;
      if (current?.open_id && !target) invalid();
      const output = {
        ...stamp(user, now),
        available: enabled(user),
        epoch: epoch(),
        version: current?.version ?? 0,
        intent: target ? parseIntent(target) : null,
      };
      if (!isRecoveryView(output, user.id, environment)) invalid();
      return output;
    },
    detail(user, id, now) {
      const target = owned(user, id, now);
      const output = { ...stamp(user, now), intent: parseIntent(target) };
      if (!isRecoveryDetail(output, user.id, environment, id)) invalid();
      return output;
    },
    prepareIntent(user, input, now) {
      validateUser(user, now);
      if (!isRecoveryPrepare(input)) invalid();
      const attempt = canonicalPrepare(input);
      const digest = fingerprint(attempt.audience, attempt.command);
      // Original accepted CAS tombstones win even after acknowledgement or epoch rotation.
      const old = prepare(
        'SELECT * FROM planting_intents WHERE environment = ? AND owner_id = ? AND prepare_epoch = ? AND prepare_version = ?',
      ).get(environment, user.id, attempt.expectedEpoch, attempt.expectedVersion);
      if (old)
        return result(
          user,
          'prepare',
          old.fingerprint === digest ? 'OK' : 'PREPARE_CONFLICT',
          old,
          now,
          attempt,
        );
      if (!enabled(user))
        return result(user, 'prepare', 'RECOVERY_UNAVAILABLE', null, now, attempt);
      if (attempt.expectedEpoch !== epoch())
        return result(user, 'prepare', 'EPOCH_CHANGED', null, now, attempt);
      let current = slot(user.id);
      if ((current?.version ?? 0) !== attempt.expectedVersion || current?.open_id)
        return result(user, 'prepare', 'SLOT_CHANGED', null, now, attempt);
      if (current && now < current.updated_at) invalid();
      const version = increment(current?.version ?? 0);
      let id = null;
      for (let tries = 0; tries < 16; tries++) {
        const candidate = random();
        const exists = prepare(
          'SELECT 1 FROM planting_intents WHERE environment = ? AND id = ?',
        ).get(environment, candidate);
        const legacy = prepare(
          'SELECT 1 FROM planting_commands WHERE environment = ? AND owner_id = ? AND key = ?',
        ).get(environment, user.id, 'intent-' + candidate);
        if (!exists && !legacy) {
          id = candidate;
          break;
        }
      }
      if (!id) invalid();
      if (!current) {
        prepare(
          'INSERT INTO recovery_slots (owner_id,environment,version,open_id,created_at,updated_at) VALUES (?,?,0,NULL,?,?)',
        ).run(user.id, environment, now, now);
      }
      prepare(
        "INSERT INTO planting_intents (environment,id,owner_id,prepare_epoch,prepare_version,fingerprint,audience,command_json,operation_key,phase,version,receipt_json,created_at,updated_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,'prepared',1,NULL,?,?,NULL)",
      ).run(
        environment,
        id,
        user.id,
        attempt.expectedEpoch,
        attempt.expectedVersion,
        digest,
        attempt.audience,
        JSON.stringify(attempt.command),
        'intent-' + id,
        now,
        now,
      );
      prepare(
        'UPDATE recovery_slots SET version = ?, open_id = ?, updated_at = ? WHERE owner_id = ? AND environment = ?',
      ).run(version, id, now, user.id, environment);
      revoke(user.id);
      return result(user, 'prepare', 'OK', row(user.id, id), now, attempt);
    },
    execute(user, id, now) {
      const target = owned(user, id, now);
      if (target.phase === 'quarantined') throw new RecoveryError('RECOVERY_QUARANTINED');
      if (target.phase === 'settled' || target.phase === 'abandoned')
        return result(user, 'execute', 'OK', target, now);
      if (target.phase !== 'prepared' || slot(user.id)?.open_id !== id)
        throw new RecoveryError('INVALID_RECOVERY_STATE');
      const input = JSON.parse(target.command_json);
      const receipt = executePlanting(user, target.audience, target.operation_key, input, now, id);
      if (!isPlantingReceipt(receipt, user.id, environment, target.operation_key, input.action))
        invalid();
      const ledger = prepare(
        'SELECT fingerprint,result_json FROM planting_commands WHERE environment = ? AND owner_id = ? AND key = ?',
      ).get(environment, user.id, target.operation_key);
      if (
        !ledger ||
        ledger.fingerprint !== target.fingerprint ||
        JSON.stringify(receipt) !== ledger.result_json ||
        receipt.completedAt !== now
      )
        invalid();
      prepare(
        "UPDATE planting_intents SET phase = 'settled', version = ?, receipt_json = ?, updated_at = ? WHERE environment = ? AND owner_id = ? AND id = ?",
      ).run(increment(target.version), ledger.result_json, now, environment, user.id, id);
      bumpSlot(user, target, now, id);
      return result(user, 'execute', 'OK', row(user.id, id), now);
    },
    acknowledge(user, id, now) {
      const target = owned(user, id, now);
      if (target.phase === 'quarantined') throw new RecoveryError('RECOVERY_QUARANTINED');
      if (target.phase !== 'settled') throw new RecoveryError('INVALID_RECOVERY_STATE');
      if (target.closed_at !== null) return result(user, 'ack', 'OK', target, now);
      prepare(
        'UPDATE planting_intents SET version = ?, updated_at = ?, closed_at = ? WHERE environment = ? AND owner_id = ? AND id = ?',
      ).run(increment(target.version), now, now, environment, user.id, id);
      bumpSlot(user, target, now, null);
      return result(user, 'ack', 'OK', row(user.id, id), now);
    },
    abandon(user, id, now) {
      const target = owned(user, id, now);
      if (target.phase === 'quarantined') throw new RecoveryError('RECOVERY_QUARANTINED');
      if (target.phase === 'settled' || target.phase === 'abandoned')
        return result(user, 'abandon', 'OK', target, now);
      if (target.phase !== 'prepared' || slot(user.id)?.open_id !== id)
        throw new RecoveryError('INVALID_RECOVERY_STATE');
      prepare(
        "UPDATE planting_intents SET phase = 'abandoned', version = ?, updated_at = ?, closed_at = ? WHERE environment = ? AND owner_id = ? AND id = ?",
      ).run(increment(target.version), now, now, environment, user.id, id);
      bumpSlot(user, target, now, null);
      return result(user, 'abandon', 'OK', row(user.id, id), now);
    },
    hasOpen(ownerId) {
      if (!safe(ownerId)) invalid();
      return !!slot(ownerId)?.open_id;
    },
    allowCommand(user, audience, key, input, intentId) {
      if (
        !safe(user?.id) ||
        !enabled(user) ||
        !isRecoveryId(intentId) ||
        !isPlantingCommand(input, audience)
      )
        return false;
      const target = row(user.id, intentId);
      return (
        !!target &&
        target.phase === 'prepared' &&
        target.closed_at === null &&
        slot(user.id)?.open_id === intentId &&
        target.operation_key === key &&
        target.audience === audience &&
        target.command_json === JSON.stringify(canonicalCommand(input))
      );
    },
    deleteOwner(ownerId) {
      if (!safe(ownerId)) invalid();
      if (api.hasOpen(ownerId)) throw new RecoveryError('RECOVERY_PENDING');
      prepare(
        'UPDATE recovery_slots SET open_id = NULL WHERE owner_id = ? AND environment = ?',
      ).run(ownerId, environment);
      prepare('DELETE FROM planting_intents WHERE owner_id = ? AND environment = ?').run(
        ownerId,
        environment,
      );
      prepare('DELETE FROM recovery_slots WHERE owner_id = ? AND environment = ?').run(
        ownerId,
        environment,
      );
    },
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(api).map(([name, method]) => [
        name,
        (...args) => {
          try {
            return method(...args);
          } catch (error) {
            if (error instanceof RecoveryError) throw error;
            invalid();
          }
        },
      ]),
    ),
  );
}

export function validateRecoveryDatabase(db, now) {
  try {
    if (!time(now)) invalid();
    const epochs = db.prepare('SELECT * FROM recovery_epoch').all();
    if (
      epochs.length !== 1 ||
      epochs[0].singleton !== 1 ||
      !isRecoveryId(epochs[0].epoch) ||
      !time(epochs[0].created_at) ||
      epochs[0].created_at > now
    )
      invalid();
    const users = new Map(
      db
        .prepare('SELECT id,environment,identity_provider,created_at FROM users')
        .all()
        .map((user) => [user.id, user]),
    );
    const slots = new Map();
    const intents = new Map();
    const histories = new Map();
    const slotKey = (owner, environment) => owner + '\0' + environment;
    const intentKey = (id, environment) => environment + '\0' + id;
    for (const current of db.prepare('SELECT * FROM recovery_slots').all()) {
      const user = users.get(current.owner_id);
      if (
        !user ||
        !available(user, current.environment) ||
        !integer(current.version, 1) ||
        !time(current.created_at) ||
        current.created_at < user.created_at ||
        !time(current.updated_at) ||
        current.updated_at < current.created_at ||
        current.updated_at > now ||
        (current.open_id !== null && !isRecoveryId(current.open_id))
      )
        invalid();
      slots.set(slotKey(current.owner_id, current.environment), current);
    }
    for (const target of db.prepare('SELECT * FROM planting_intents').all()) {
      const user = users.get(target.owner_id);
      const current = slots.get(slotKey(target.owner_id, target.environment));
      const detail = {
        recoveryFormat: 1,
        ownerId: target.owner_id,
        environment: target.environment,
        serverTime: now,
        intent: parseIntent(target),
      };
      if (
        !user ||
        !available(user, target.environment) ||
        !current ||
        !isRecoveryDetail(detail, target.owner_id, target.environment, target.id)
      )
        invalid();
      if (
        target.created_at < current.created_at ||
        target.updated_at > current.updated_at ||
        target.prepare_version >= current.version ||
        target.operation_key !== 'intent-' + target.id
      )
        invalid();
      if (
        JSON.stringify(canonicalCommand(detail.intent.command)) !== target.command_json ||
        fingerprint(target.audience, detail.intent.command) !== target.fingerprint
      )
        invalid();
      if (current.version < target.prepare_version + target.version) invalid();
      if (
        target.phase === 'prepared' &&
        (target.prepare_epoch !== epochs[0].epoch || current.version !== target.prepare_version + 1)
      )
        invalid();
      if (target.phase === 'quarantined' && target.prepare_epoch === epochs[0].epoch) invalid();
      if (
        target.prepare_epoch === epochs[0].epoch
          ? target.created_at < epochs[0].created_at
          : target.created_at > epochs[0].created_at
      )
        invalid();
      if ((target.closed_at === null) !== (current.open_id === target.id)) invalid();
      const ledger = db
        .prepare(
          'SELECT fingerprint,result_json,created_at FROM planting_commands WHERE environment = ? AND owner_id = ? AND key = ?',
        )
        .get(target.environment, target.owner_id, target.operation_key);
      if (target.phase === 'settled') {
        if (
          !ledger ||
          ledger.fingerprint !== target.fingerprint ||
          ledger.result_json !== target.receipt_json ||
          JSON.stringify(detail.intent.receipt) !== target.receipt_json ||
          ledger.created_at !== detail.intent.receipt.completedAt
        )
          invalid();
      } else if (ledger || target.receipt_json !== null) invalid();
      intents.set(intentKey(target.id, target.environment), target);
      const historyKey = slotKey(target.owner_id, target.environment);
      const history = histories.get(historyKey) ?? [];
      history.push(target);
      histories.set(historyKey, history);
    }
    for (const current of slots.values()) {
      const history = histories.get(slotKey(current.owner_id, current.environment));
      if (!history?.length) invalid();
      history.sort((a, b) => a.prepare_version - b.prepare_version);
      if (history[0].created_at !== current.created_at) invalid();
      for (let i = 1; i < history.length; i++) {
        const before = history[i - 1];
        const after = history[i];
        if (
          before.closed_at === null ||
          before.closed_at > after.created_at ||
          before.prepare_version + before.version > after.prepare_version
        )
          invalid();
      }
      if (current.open_id === null) continue;
      const target = intents.get(intentKey(current.open_id, current.environment));
      if (
        !target ||
        target.owner_id !== current.owner_id ||
        target.closed_at !== null ||
        target.updated_at > current.updated_at
      )
        invalid();
    }
    return true;
  } catch {
    invalid();
  }
}

export function restoreRecoveryDatabase(db, now) {
  try {
    if (!time(now)) invalid();
    validateRecoveryDatabase(db, now);
    const current = db
      .prepare('SELECT epoch,created_at FROM recovery_epoch WHERE singleton = 1')
      .get();
    if (now < current.created_at) invalid();
    const slots = db.prepare('SELECT version,updated_at FROM recovery_slots').all();
    const pending = db
      .prepare(
        "SELECT version,updated_at FROM planting_intents WHERE phase = 'prepared' AND closed_at IS NULL",
      )
      .all();
    for (const item of [...slots, ...pending]) {
      increment(item.version);
      if (now < item.updated_at) invalid();
    }
    let next = random();
    while (next === current.epoch) next = random();
    db.prepare('UPDATE recovery_epoch SET epoch = ?, created_at = ? WHERE singleton = 1').run(
      next,
      now,
    );
    db.prepare('UPDATE recovery_slots SET version = version + 1, updated_at = ?').run(now);
    db.prepare(
      "UPDATE planting_intents SET phase = 'quarantined', version = version + 1, updated_at = ? WHERE phase = 'prepared' AND closed_at IS NULL",
    ).run(now);
  } catch {
    invalid();
  }
}
