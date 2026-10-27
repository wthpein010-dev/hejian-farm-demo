import { createHash, randomBytes } from 'node:crypto';
import {
  isPlantingCommand,
  isPlantingReceipt,
  isPlantingDetail,
  isPlantingPage,
  isPlantingId,
  normalizePlantingProvision,
} from '../../../shared/planting.mjs';

// Parent Store owns BEGIN IMMEDIATE. These definitions are also the backup schema authority.
export const PLANTING_TABLE_SQL = Object.freeze({
  planting_plans: `CREATE TABLE IF NOT EXISTS planting_plans (
  environment TEXT NOT NULL CHECK (environment IN ('development','production')), record_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL CHECK(version >= 1), record_version INTEGER NOT NULL CHECK(record_version >= 1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), not_before INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(environment,record_id), FOREIGN KEY(environment,record_id) REFERENCES farm_records(environment,id))`,
  planting_grants: `CREATE TABLE IF NOT EXISTS planting_grants (
  environment TEXT NOT NULL CHECK (environment IN ('development','production')), record_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('dispatch','execute')), staff_ref TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)), version INTEGER NOT NULL CHECK(version >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(environment,record_id,account_id,role), FOREIGN KEY(environment,record_id) REFERENCES planting_plans(environment,record_id))`,
  planting_orders: `CREATE TABLE IF NOT EXISTS planting_orders (
  environment TEXT NOT NULL CHECK (environment IN ('development','production')), id TEXT NOT NULL,
  record_id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), assignee_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('requested','accepted','assigned','working','completed','cancelled')),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 100), data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(environment,id), FOREIGN KEY(environment,record_id) REFERENCES planting_plans(environment,record_id))`,
  planting_events: `CREATE TABLE IF NOT EXISTS planting_events (
  environment TEXT NOT NULL CHECK (environment IN ('development','production')), order_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 100),
  data_json TEXT NOT NULL, PRIMARY KEY(environment,order_id,version), FOREIGN KEY(environment,order_id) REFERENCES planting_orders(environment,id))`,
  planting_commands: `CREATE TABLE IF NOT EXISTS planting_commands (
  environment TEXT NOT NULL CHECK (environment IN ('development','production')), owner_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(environment,owner_id,key))`,
});
export const PLANTING_INDEX_SQL = Object.freeze({
  planting_one_active: `CREATE UNIQUE INDEX IF NOT EXISTS planting_one_active ON planting_orders(environment,record_id) WHERE status NOT IN ('completed','cancelled')`,
  planting_orders_owner: `CREATE INDEX IF NOT EXISTS planting_orders_owner ON planting_orders(owner_id,environment,id)`,
  planting_orders_assignee: `CREATE INDEX IF NOT EXISTS planting_orders_assignee ON planting_orders(assignee_id,environment,id)`,
  planting_grants_account: `CREATE INDEX IF NOT EXISTS planting_grants_account ON planting_grants(account_id,environment,active)`,
});
export const PLANTING_SQL =
  [...Object.values(PLANTING_TABLE_SQL), ...Object.values(PLANTING_INDEX_SQL)].join(';\n') + ';';
export class PlantingError extends Error {
  constructor(code = 'INVALID_PLANTING_DATA') {
    super('播种作业暂不可用');
    this.name = 'PlantingError';
    this.code = [
      'INVALID_PLANTING_DATA',
      'NOT_FOUND',
      'PLANTING_UNAVAILABLE',
      'PLAN_CHANGED',
      'RECORD_CHANGED',
      'ACCOUNT_UNAVAILABLE',
      'ACTIVE_WORK',
      'RESERVED_OPERATION_KEY',
    ].includes(code)
      ? code
      : 'INVALID_PLANTING_DATA';
  }
}
const invalid = () => {
  throw new PlantingError();
};
const time = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 8.64e15;
const safe = (x) =>
  typeof x === 'string' &&
  x.length >= 1 &&
  x.length <= 128 &&
  /^[A-Za-z0-9_-]+$/u.test(x) &&
  !/[\r\n]/u.test(x);
const recordId = (x) => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{7,63}$/u.test(x) && !/[\r\n]/u.test(x);
const operationKey = (x) =>
  typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/u.test(x) && !/[\r\n]/u.test(x);
const positive = (x) => Number.isSafeInteger(x) && x >= 1;
const random = () => randomBytes(16).toString('hex');
const ended = (x) => ['completed', 'cancelled'].includes(x);
const digest = (x) => createHash('sha256').update(x).digest('hex');
const available = (u, environment) =>
  environment === 'development' && u?.environment === environment && u.identity_provider === 'development';
const canonicalCommand = (input) =>
  Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((k) => [k, input[k]]),
  );

export function createPlanting({ prepare, environment, farmRegistry, beforeNewCommand }) {
  if (
    typeof prepare !== 'function' ||
    !['development', 'production'].includes(environment) ||
    !farmRegistry?.detail ||
    !farmRegistry?.applyBatch
  )
    invalid();
  const plan = (id) =>
    prepare('SELECT * FROM planting_plans WHERE environment = ? AND record_id = ?').get(environment, id);
  const grants = (id) =>
    prepare(
      'SELECT * FROM planting_grants WHERE environment = ? AND record_id = ? ORDER BY account_id, role',
    ).all(environment, id);
  const account = (id) =>
    prepare('SELECT id, environment, identity_provider FROM users WHERE id = ?').get(id);
  const grant = (record, who, role) =>
    prepare(
      `SELECT * FROM planting_grants WHERE environment = ? AND record_id = ? AND account_id = ? AND role = ? AND active = 1`,
    ).get(environment, record, who, role);
  const liveGrant = (record, who, role) =>
    available(account(who), environment) ? grant(record, who, role) : null;
  const row = (id) =>
    prepare('SELECT * FROM planting_orders WHERE environment = ? AND id = ?').get(environment, id);
  const parse = (r) => {
    try {
      const o = JSON.parse(r.data_json);
      if (
        o.id !== r.id ||
        o.recordId !== r.record_id ||
        o.version !== r.version ||
        o.status !== r.status ||
        o.createdAt !== r.created_at ||
        o.updatedAt !== r.updated_at
      )
        invalid();
      return o;
    } catch {
      invalid();
    }
  };
  const active = (id) =>
    prepare(
      `SELECT id FROM planting_orders WHERE environment = ? AND record_id = ? AND status NOT IN ('completed','cancelled')`,
    ).get(environment, id)?.id ?? null;
  const archive = (owner, id, now) => {
    try {
      return farmRegistry.detail(owner, id, 0, now).record;
    } catch (e) {
      if (e.code === 'NOT_FOUND') return null;
      throw e;
    }
  };
  const eligible = (r, p) =>
    r &&
    p &&
    p.enabled === 1 &&
    r.kind === 'plot' &&
    r.status === 'planned' &&
    r.startedAt === null &&
    r.version === p.record_version &&
    r.ownerId === p.owner_id;
  const revoke = (ids) => {
    for (const id of new Set(ids.filter(Boolean)))
      prepare('DELETE FROM deletion_confirmations WHERE user_id = ?').run(id);
  };
  const affected = (r) => [r.owner_id, r.assignee_id, ...grants(r.record_id).map((g) => g.account_id)];
  const stamp = (u, now) => ({ plantingFormat: 1, ownerId: u.id, environment, serverTime: now });
  function assertRead(user, now) {
    if (!safe(user?.id) || !time(now)) invalid();
    if (!available(user, environment)) throw new PlantingError('PLANTING_UNAVAILABLE');
  }
  function authorized(user, audience, r) {
    return audience === 'customer'
      ? r.owner_id === user.id
      : audience === 'staff' &&
          (liveGrant(r.record_id, user.id, 'dispatch') || liveGrant(r.record_id, user.id, 'execute'));
  }
  function permissions(user, audience, r, now) {
    const o = parse(r),
      p = plan(r.record_id),
      dispatch = audience === 'staff' && !!liveGrant(r.record_id, user.id, 'dispatch'),
      execute =
        audience === 'staff' && !!liveGrant(r.record_id, user.id, 'execute') && r.assignee_id === user.id;
    return {
      canCancel:
        audience === 'customer' &&
        r.owner_id === user.id &&
        ['requested', 'accepted', 'assigned'].includes(o.status),
      canAccept: dispatch && !!p?.enabled && o.status === 'requested',
      canAssign: dispatch && !!p?.enabled && ['accepted', 'assigned'].includes(o.status) && o.version < 98,
      canStart: execute && !!p?.enabled && o.status === 'assigned' && now >= o.notBefore,
      canComplete: execute && !!p?.enabled && o.status === 'working',
      canCancelWork: dispatch && o.status === 'working',
    };
  }
  function detail(user, audience, id, now) {
    assertRead(user, now);
    if (!isPlantingId(id) || !['customer', 'staff'].includes(audience)) invalid();
    const r = row(id);
    if (!r || !authorized(user, audience, r)) throw new PlantingError('NOT_FOUND');
    const p = permissions(user, audience, r, now);
    const out = {
      ...stamp(user, now),
      order: parse(r),
      events: prepare(
        'SELECT data_json FROM planting_events WHERE environment = ? AND order_id = ? ORDER BY version',
      )
        .all(environment, id)
        .map((x) => JSON.parse(x.data_json)),
      candidates:
        audience === 'staff' && liveGrant(r.record_id, user.id, 'dispatch')
          ? grants(r.record_id)
              .filter(
                (g) =>
                  g.active === 1 && g.role === 'execute' && available(account(g.account_id), environment),
              )
              .map((g) => ({ ref: g.staff_ref, label: '农务员' + g.staff_ref.slice(0, 6) }))
              .sort((a, b) => a.ref.localeCompare(b.ref))
          : [],
      permissions: p,
    };
    if (!isPlantingDetail(out, user.id, environment, id)) invalid();
    return out;
  }
  function event(id, version, action, now, occurredAt, actorRef) {
    prepare('INSERT INTO planting_events (environment,order_id,version,data_json) VALUES (?,?,?,?)').run(
      environment,
      id,
      version,
      JSON.stringify({ version, action, recordedAt: now, occurredAt, actorRef }),
    );
  }
  function update(r, o) {
    prepare(
      'UPDATE planting_orders SET assignee_id = ?, status = ?, version = ?, data_json = ?, updated_at = ? WHERE environment = ? AND id = ?',
    ).run(r.assignee_id, o.status, o.version, JSON.stringify(o), o.updatedAt, environment, o.id);
  }
  function command(user, audience, key, input, now, intentId = null) {
    if (!safe(user?.id) || !operationKey(key) || !time(now) || !isPlantingCommand(input, audience)) invalid();
    const fingerprint = digest(JSON.stringify({ audience, command: canonicalCommand(input) }));
    const receipt = (code, orderId = null) => ({
      plantingFormat: 1,
      ownerId: user.id,
      environment,
      operationKey: key,
      action: input.action,
      outcome: code === 'OK' ? 'applied' : 'refused',
      code,
      orderId,
      completedAt: now,
    });
    const old = prepare(
      'SELECT * FROM planting_commands WHERE environment = ? AND owner_id = ? AND key = ?',
    ).get(environment, user.id, key);
    if (old) {
      if (old.fingerprint !== fingerprint) return receipt('IDEMPOTENCY_CONFLICT');
      const result = JSON.parse(old.result_json);
      if (!isPlantingReceipt(result, user.id, environment, key, input.action)) invalid();
      return result;
    }
    let id = null;
    const apply = () => {
      // Historical receipts above settle before any current recovery gate.
      // The optional context is supplied only by Store's trusted executor.
      const blocked = beforeNewCommand?.(user, audience, key, input, now, intentId);
      if (blocked) return blocked;
      if (!available(user, environment) || !available(account(user.id), environment))
        return 'PLANTING_UNAVAILABLE';
      if (input.action === 'request') {
        const r = archive(user.id, input.recordId, now);
        if (!r) return 'NOT_FOUND';
        if (active(r.id)) return 'ACTIVE_ORDER_EXISTS';
        const p = plan(r.id);
        if (!p?.enabled) return 'PLAN_DISABLED';
        if (input.expectedRecordVersion !== r.version || !eligible(r, p)) return 'RECORD_CHANGED';
        id = random();
        const o = {
          id,
          recordId: r.id,
          cycleRef: r.cycleRef,
          name: r.name,
          unitLabel: r.unitLabel,
          status: 'requested',
          version: 1,
          recordVersion: r.version,
          notBefore: p.not_before,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
          assigneeRef: null,
        };
        prepare(
          'INSERT INTO planting_orders (environment,id,record_id,owner_id,assignee_id,status,version,data_json,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?,?,?)',
        ).run(environment, id, r.id, user.id, o.status, 1, JSON.stringify(o), now, now);
        event(id, 1, 'request', now, now, 'customer');
        revoke([user.id, ...grants(r.id).map((g) => g.account_id)]);
        return 'OK';
      }
      const r = row(input.orderId);
      if (!r || !authorized(user, audience, r)) return 'NOT_FOUND';
      id = r.id;
      const o = parse(r),
        p = plan(r.record_id);
      if (input.expectedOrderVersion !== o.version) return 'ORDER_CHANGED';
      if (now < o.updatedAt) invalid();
      if (ended(o.status)) return 'INVALID_STATE';
      const dispatch = audience === 'staff' && liveGrant(r.record_id, user.id, 'dispatch'),
        execute = audience === 'staff' && liveGrant(r.record_id, user.id, 'execute');
      if (input.action !== 'cancel' && input.action !== 'cancel-work' && !p?.enabled) return 'PLAN_DISABLED';
      let occurredAt = now,
        actorRef = audience === 'customer' ? 'customer' : (dispatch || execute)?.staff_ref;
      if (input.action === 'cancel') {
        if (!['requested', 'accepted', 'assigned'].includes(o.status)) return 'INVALID_STATE';
        o.status = 'cancelled';
      } else if (input.action === 'accept') {
        if (!dispatch) return 'NOT_FOUND';
        if (o.status !== 'requested') return 'INVALID_STATE';
        o.status = 'accepted';
      } else if (input.action === 'assign') {
        if (!dispatch) return 'NOT_FOUND';
        if (!['accepted', 'assigned'].includes(o.status)) return 'INVALID_STATE';
        if (o.version >= 98) return 'EVENT_LIMIT';
        const g = grants(r.record_id).find(
          (g) =>
            g.active === 1 &&
            g.role === 'execute' &&
            g.staff_ref === input.assigneeRef &&
            available(account(g.account_id), environment),
        );
        if (!g) return 'ASSIGNEE_UNAVAILABLE';
        revoke([r.assignee_id, g.account_id]);
        r.assignee_id = g.account_id;
        o.assigneeRef = g.staff_ref;
        o.status = 'assigned';
      } else if (input.action === 'start') {
        if (!execute || r.assignee_id !== user.id) return 'NOT_FOUND';
        if (o.status !== 'assigned') return 'INVALID_STATE';
        if (now < o.notBefore) return 'TOO_EARLY';
        o.status = 'working';
        o.startedAt = now;
        actorRef = execute.staff_ref;
      } else if (input.action === 'complete') {
        if (!execute || r.assignee_id !== user.id) return 'NOT_FOUND';
        if (o.status !== 'working') return 'INVALID_STATE';
        const record = archive(r.owner_id, r.record_id, now);
        if (
          !record ||
          record.version !== o.recordVersion ||
          input.expectedRecordVersion !== record.version ||
          record.cycleRef !== o.cycleRef ||
          record.kind !== 'plot' ||
          record.status !== 'planned' ||
          record.startedAt !== null
        )
          return 'RECORD_CHANGED';
        if (input.performedAt < Math.max(o.startedAt, record.observedAt) || input.performedAt > now)
          return 'INVALID_PERFORMED_AT';
        const { version, createdAt, updatedAt, ...base } = record;
        farmRegistry.applyBatch(
          {
            formatVersion: 1,
            batchId: 'planting-' + random(),
            source: 'planting-complete',
            entries: [
              {
                expectedVersion: version,
                record: {
                  ...base,
                  status: 'growing',
                  startedAt: input.performedAt,
                  expectedHarvestAt: null,
                  observedAt: input.performedAt,
                  measurements: {},
                },
              },
            ],
          },
          now,
        );
        o.status = 'completed';
        o.completedAt = input.performedAt;
        occurredAt = input.performedAt;
        actorRef = execute.staff_ref;
      } else {
        if (!dispatch) return 'NOT_FOUND';
        if (o.status !== 'working') return 'INVALID_STATE';
        if (input.stoppedAt < o.startedAt || input.stoppedAt > now) return 'INVALID_PERFORMED_AT';
        if (p.version >= Number.MAX_SAFE_INTEGER) invalid();
        prepare(
          'UPDATE planting_plans SET enabled = 0, version = version + 1, updated_at = ? WHERE environment = ? AND record_id = ?',
        ).run(now, environment, r.record_id);
        o.status = 'cancelled';
        occurredAt = input.stoppedAt;
      }
      if (o.version >= 100) invalid();
      o.version++;
      o.updatedAt = now;
      update(r, o);
      event(id, o.version, input.action, now, occurredAt, actorRef);
      revoke(affected(r));
      return 'OK';
    };
    const code = apply();
    const result = receipt(code, id);
    if (!isPlantingReceipt(result, user.id, environment, key, input.action)) invalid();
    prepare(
      'INSERT INTO planting_commands (environment,owner_id,key,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)',
    ).run(environment, user.id, key, fingerprint, JSON.stringify(result), now);
    return result;
  }
  function provision(input, now) {
    if (!time(now) || environment !== 'development') throw new PlantingError('PLANTING_UNAVAILABLE');
    let x;
    try {
      x = normalizePlantingProvision(input);
    } catch {
      invalid();
    }
    const rr = prepare('SELECT owner_id FROM farm_records WHERE environment = ? AND id = ?').get(
      environment,
      x.recordId,
    );
    if (!rr) throw new PlantingError('NOT_FOUND');
    const r = archive(rr.owner_id, x.recordId, now),
      p = plan(x.recordId);
    if (p && (!positive(p.version) || p.version >= Number.MAX_SAFE_INTEGER)) invalid();
    if ((p?.version ?? 0) !== x.expectedPlanVersion) throw new PlantingError('PLAN_CHANGED');
    if (
      r.version !== x.recordVersion ||
      r.kind !== 'plot' ||
      (p && p.owner_id !== r.ownerId) ||
      (x.enabled && (r.status !== 'planned' || r.startedAt !== null))
    )
      throw new PlantingError('RECORD_CHANGED');
    if (!available(account(r.ownerId), environment)) throw new PlantingError('ACCOUNT_UNAVAILABLE');
    for (const s of x.staff)
      if (!available(account(s.accountId), environment)) throw new PlantingError('ACCOUNT_UNAVAILABLE');
    if (p && now < p.updated_at) invalid();
    const old = grants(x.recordId);
    if (p)
      prepare(
        'UPDATE planting_plans SET version = version + 1, record_version = ?, enabled = ?, not_before = ?, updated_at = ? WHERE environment = ? AND record_id = ?',
      ).run(r.version, +x.enabled, x.notBefore, now, environment, r.id);
    else
      prepare(
        'INSERT INTO planting_plans (environment,record_id,owner_id,version,record_version,enabled,not_before,created_at,updated_at) VALUES (?,?,?,1,?,?,?,?,?)',
      ).run(environment, r.id, r.ownerId, r.version, +x.enabled, x.notBefore, now, now);
    for (const g of old) {
      if (g.version >= Number.MAX_SAFE_INTEGER) invalid();
      prepare(
        'UPDATE planting_grants SET active = 0, version = version + 1, updated_at = ? WHERE environment = ? AND record_id = ? AND account_id = ? AND role = ?',
      ).run(now, environment, r.id, g.account_id, g.role);
    }
    for (const s of x.staff) {
      const g = old.find((g) => g.account_id === s.accountId && g.role === s.role);
      if (g)
        prepare(
          'UPDATE planting_grants SET active = 1 WHERE environment = ? AND record_id = ? AND account_id = ? AND role = ?',
        ).run(environment, r.id, s.accountId, s.role);
      else {
        const ref =
          prepare(
            'SELECT staff_ref FROM planting_grants WHERE environment = ? AND account_id = ? LIMIT 1',
          ).get(environment, s.accountId)?.staff_ref ?? random();
        prepare(
          'INSERT INTO planting_grants (environment,record_id,account_id,role,staff_ref,active,version,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)',
        ).run(environment, r.id, s.accountId, s.role, ref, now, now);
      }
    }
    revoke([r.ownerId, ...old.map((g) => g.account_id), ...x.staff.map((s) => s.accountId)]);
    return {
      ok: true,
      operation: 'planting-provision',
      version: (p?.version ?? 0) + 1,
      grants: x.staff.length,
    };
  }
  const api = {
    status(user, now) {
      if (!safe(user?.id) || !time(now)) invalid();
      const a = available(user, environment);
      return {
        ...stamp(user, now),
        available: a,
        hasStaffAccess:
          a &&
          !!prepare(
            'SELECT 1 FROM planting_grants WHERE environment = ? AND account_id = ? AND active = 1 LIMIT 1',
          ).get(environment, user.id),
      };
    },
    record(user, id, now) {
      assertRead(user, now);
      if (!recordId(id)) invalid();
      const r = archive(user.id, id, now);
      if (!r) throw new PlantingError('NOT_FOUND');
      const p = plan(id),
        currentOrderId = active(id);
      return {
        ...stamp(user, now),
        recordId: id,
        recordVersion: r.version,
        enabled: !!eligible(r, p) && !currentOrderId,
        notBefore: p?.not_before ?? null,
        currentOrderId,
      };
    },
    page(user, audience, cursor = 'start', now) {
      assertRead(user, now);
      if (!['customer', 'staff'].includes(audience) || !(cursor === 'start' || isPlantingId(cursor)))
        invalid();
      const rows =
        audience === 'customer'
          ? prepare(
              'SELECT * FROM planting_orders WHERE environment = ? AND owner_id = ? AND id > ? ORDER BY id LIMIT 21',
            ).all(environment, user.id, cursor === 'start' ? '' : cursor)
          : prepare(
              `SELECT o.* FROM planting_orders o WHERE o.environment = ? AND o.id > ? AND EXISTS (SELECT 1 FROM planting_grants g WHERE g.environment = o.environment AND g.record_id = o.record_id AND g.account_id = ? AND g.active = 1) ORDER BY o.id LIMIT 21`,
            ).all(environment, cursor === 'start' ? '' : cursor, user.id);
      const items = rows.slice(0, 20).map(parse);
      const result = { ...stamp(user, now), items, nextCursor: rows.length > 20 ? items.at(-1).id : null };
      if (!isPlantingPage(result, user.id, environment)) invalid();
      return result;
    },
    detail,
    command,
    provision,
    hasActiveWork(id) {
      return !!prepare(
        `SELECT 1 FROM planting_orders WHERE environment = ? AND status NOT IN ('completed','cancelled') AND (owner_id = ? OR assignee_id = ?) LIMIT 1`,
      ).get(environment, id, id);
    },
    assertImportSafe(batch) {
      for (const e of batch.entries) if (active(e.record.id)) throw new PlantingError('ACTIVE_WORK');
    },
    deleteOwner(id, now) {
      if (!safe(id) || !time(now)) invalid();
      if (api.hasActiveWork(id)) throw new PlantingError('ACTIVE_WORK');
      const touched = prepare(
        'SELECT DISTINCT record_id FROM planting_grants WHERE environment = ? AND account_id = ?',
      ).all(environment, id);
      for (const t of touched) {
        const p = plan(t.record_id);
        if (p.version >= Number.MAX_SAFE_INTEGER || now < p.updated_at) invalid();
        revoke([p.owner_id, ...grants(t.record_id).map((g) => g.account_id)]);
        prepare(
          'UPDATE planting_plans SET version = version + 1, updated_at = ? WHERE environment = ? AND record_id = ?',
        ).run(now, environment, t.record_id);
      }
      for (const p of prepare(
        'SELECT record_id FROM planting_plans WHERE environment = ? AND owner_id = ?',
      ).all(environment, id))
        revoke([id, ...grants(p.record_id).map((g) => g.account_id)]);
      prepare('UPDATE planting_orders SET assignee_id = NULL WHERE environment = ? AND assignee_id = ?').run(
        environment,
        id,
      );
      prepare(
        'DELETE FROM planting_events WHERE environment = ? AND order_id IN (SELECT id FROM planting_orders WHERE environment = ? AND owner_id = ?)',
      ).run(environment, environment, id);
      prepare('DELETE FROM planting_orders WHERE environment = ? AND owner_id = ?').run(environment, id);
      prepare(
        'DELETE FROM planting_grants WHERE environment = ? AND (account_id = ? OR record_id IN (SELECT record_id FROM planting_plans WHERE environment = ? AND owner_id = ?))',
      ).run(environment, id, environment, id);
      prepare('DELETE FROM planting_plans WHERE environment = ? AND owner_id = ?').run(environment, id);
      prepare('DELETE FROM planting_commands WHERE environment = ? AND owner_id = ?').run(environment, id);
    },
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(api).map(([name, method]) => [
        name,
        (...args) => {
          try {
            return method(...args);
          } catch (e) {
            if (e instanceof PlantingError) throw e;
            invalid();
          }
        },
      ]),
    ),
  );
}

// Restore never revives staff powers from an older backup. Original command receipts stay unchanged.
export function restorePlantingAuthorization(db) {
  try {
    for (const table of ['planting_plans', 'planting_grants'])
      if (db.prepare(`SELECT 1 FROM ${table} WHERE version >= ? LIMIT 1`).get(Number.MAX_SAFE_INTEGER))
        invalid();
    db.exec(
      'UPDATE planting_plans SET enabled = 0, version = version + 1; UPDATE planting_grants SET active = 0, version = version + 1;',
    );
  } catch {
    invalid();
  }
}

export function validatePlantingDatabase(db, now) {
  try {
    if (!time(now)) invalid();
    const users = new Map(
      db
        .prepare('SELECT id,environment,identity_provider,created_at FROM users')
        .all()
        .map((u) => [u.id, u]),
    );
    const plans = new Map(),
      grants = new Map(),
      refs = new Map(),
      accountRefs = new Map(),
      orders = new Map(),
      eventMap = new Map(),
      activeGrants = new Map();
    const key = (e, id) => e + '\0' + id;
    const stamp = (r, owner) => {
      const u = users.get(owner);
      if (
        !u ||
        !available(u, r.environment) ||
        !time(r.created_at) ||
        r.created_at < u.created_at ||
        !time(r.updated_at) ||
        r.updated_at < r.created_at ||
        r.updated_at > now
      )
        invalid();
    };
    for (const p of db.prepare('SELECT * FROM planting_plans').all()) {
      stamp(p, p.owner_id);
      if (
        !recordId(p.record_id) ||
        !positive(p.version) ||
        !positive(p.record_version) ||
        ![0, 1].includes(p.enabled) ||
        !time(p.not_before)
      )
        invalid();
      const r = db
        .prepare('SELECT owner_id,version,data_json FROM farm_records WHERE environment = ? AND id = ?')
        .get(p.environment, p.record_id);
      if (!r || r.owner_id !== p.owner_id || p.record_version > r.version) invalid();
      const a = JSON.parse(r.data_json);
      if (a.kind !== 'plot') invalid();
      plans.set(key(p.environment, p.record_id), p);
    }
    for (const g of db.prepare('SELECT * FROM planting_grants').all()) {
      stamp(g, g.account_id);
      const p = plans.get(key(g.environment, g.record_id));
      if (
        !p ||
        !['dispatch', 'execute'].includes(g.role) ||
        ![0, 1].includes(g.active) ||
        !positive(g.version) ||
        !isPlantingId(g.staff_ref) ||
        g.created_at < p.created_at ||
        g.updated_at > p.updated_at
      )
        invalid();
      const ref = refs.get(key(g.environment, g.staff_ref)),
        oldRef = accountRefs.get(key(g.environment, g.account_id));
      if ((ref && ref !== g.account_id) || (oldRef && oldRef !== g.staff_ref)) invalid();
      refs.set(key(g.environment, g.staff_ref), g.account_id);
      accountRefs.set(key(g.environment, g.account_id), g.staff_ref);
      grants.set(key(g.environment, g.record_id) + '\0' + g.account_id + '\0' + g.role, g);
      if (g.active) {
        const k = key(g.environment, g.record_id),
          n = (activeGrants.get(k) ?? 0) + 1;
        if (n > 40) invalid();
        activeGrants.set(k, n);
      }
    }
    const activeRecords = new Set();
    for (const r of db.prepare('SELECT * FROM planting_orders').all()) {
      stamp(r, r.owner_id);
      const p = plans.get(key(r.environment, r.record_id));
      const o = JSON.parse(r.data_json);
      if (
        !p ||
        p.owner_id !== r.owner_id ||
        o.recordId !== r.record_id ||
        o.id !== r.id ||
        o.version !== r.version ||
        o.status !== r.status ||
        o.createdAt !== r.created_at ||
        o.updatedAt !== r.updated_at ||
        JSON.stringify(o) !== r.data_json ||
        r.created_at < p.created_at
      )
        invalid();
      const events = db
        .prepare('SELECT * FROM planting_events WHERE environment = ? AND order_id = ? ORDER BY version')
        .all(r.environment, r.id)
        .map((e) => {
          const value = JSON.parse(e.data_json);
          if (e.version !== value.version || JSON.stringify(value) !== e.data_json) invalid();
          return value;
        });
      const no = {
        canCancel: false,
        canAccept: false,
        canAssign: false,
        canStart: false,
        canComplete: false,
        canCancelWork: false,
      };
      if (
        !isPlantingDetail(
          {
            plantingFormat: 1,
            ownerId: r.owner_id,
            environment: r.environment,
            serverTime: now,
            order: o,
            events,
            candidates: [],
            permissions: no,
          },
          r.owner_id,
          r.environment,
          r.id,
        )
      )
        invalid();
      eventMap.set(key(r.environment, r.id), events);
      const originalRow = db
        .prepare(
          'SELECT data_json FROM farm_record_events WHERE environment = ? AND record_id = ? AND version = ?',
        )
        .get(r.environment, r.record_id, o.recordVersion);
      if (!originalRow) invalid();
      const original = JSON.parse(originalRow.data_json);
      if (
        original.ownerId !== r.owner_id ||
        original.kind !== 'plot' ||
        original.status !== 'planned' ||
        original.startedAt !== null ||
        original.cycleRef !== o.cycleRef ||
        original.name !== o.name ||
        original.unitLabel !== o.unitLabel ||
        original.updatedAt > o.createdAt
      )
        invalid();
      if (o.status === 'completed') {
        const completionRow = db
          .prepare(
            'SELECT data_json,source FROM farm_record_events WHERE environment = ? AND record_id = ? AND version = ?',
          )
          .get(r.environment, r.record_id, o.recordVersion + 1);
        if (!completionRow || completionRow.source !== 'planting-complete') invalid();
        const completed = JSON.parse(completionRow.data_json);
        if (
          completed.status !== 'growing' ||
          completed.ownerId !== r.owner_id ||
          completed.cycleRef !== o.cycleRef ||
          completed.startedAt !== o.completedAt ||
          completed.observedAt !== o.completedAt ||
          completed.expectedHarvestAt !== null ||
          Object.keys(completed.measurements).length !== 0 ||
          completed.updatedAt !== o.updatedAt
        )
          invalid();
      }
      if ((o.status === 'assigned' && o.version > 98) || (o.status === 'working' && o.version > 99))
        invalid();
      if (r.assignee_id !== null) {
        const u = users.get(r.assignee_id);
        if (!u || !available(u, r.environment) || !o.assigneeRef) invalid();
        const g = grants.get(key(r.environment, r.record_id) + '\0' + r.assignee_id + '\0execute');
        if (!g || g.staff_ref !== o.assigneeRef) invalid();
      } else if (!ended(o.status) && o.assigneeRef !== null) invalid();
      const archive = db
        .prepare('SELECT version,data_json FROM farm_records WHERE environment = ? AND id = ?')
        .get(r.environment, r.record_id);
      if (o.recordVersion > archive.version) invalid();
      const a = JSON.parse(archive.data_json);
      if (!ended(o.status)) {
        const k = key(r.environment, r.record_id);
        if (
          activeRecords.has(k) ||
          a.ownerId !== r.owner_id ||
          a.cycleRef !== o.cycleRef ||
          a.status !== 'planned' ||
          a.startedAt !== null ||
          archive.version !== o.recordVersion
        )
          invalid();
        activeRecords.add(k);
      }
      orders.set(key(r.environment, r.id), r);
    }
    for (const e of db.prepare('SELECT * FROM planting_events').all())
      if (!orders.has(key(e.environment, e.order_id))) invalid();
    for (const r of db.prepare('SELECT * FROM planting_commands').all()) {
      const u = users.get(r.owner_id),
        c = JSON.parse(r.result_json);
      if (
        !u ||
        u.environment !== r.environment ||
        !operationKey(r.key) ||
        typeof r.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(r.fingerprint) ||
        !isPlantingReceipt(c, r.owner_id, r.environment, r.key, c.action) ||
        JSON.stringify(c) !== r.result_json ||
        c.completedAt !== r.created_at ||
        r.created_at < u.created_at ||
        r.created_at > now ||
        (!available(u, r.environment) && c.code !== 'PLANTING_UNAVAILABLE')
      )
        invalid();
      const o = orders.get(key(r.environment, c.orderId));
      if (c.code === 'OK' && o) {
        const actor = ['request', 'cancel'].includes(c.action)
          ? 'customer'
          : accountRefs.get(key(r.environment, r.owner_id));
        if (['request', 'cancel'].includes(c.action) && o.owner_id !== r.owner_id) invalid();
        if (
          !eventMap
            .get(key(r.environment, c.orderId))
            .some((e) => e.action === c.action && e.recordedAt === r.created_at && e.actorRef === actor)
        )
          invalid();
      }
    }
    return true;
  } catch {
    invalid();
  }
}
