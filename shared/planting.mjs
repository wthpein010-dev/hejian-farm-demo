// Strict public boundary: no account identity, observations or client supplied roles in orders.
export const PLANTING_CODES = Object.freeze([
  'OK',
  'PLANTING_UNAVAILABLE',
  'NOT_FOUND',
  'PLAN_DISABLED',
  'RECORD_CHANGED',
  'ORDER_CHANGED',
  'INVALID_STATE',
  'ACTIVE_ORDER_EXISTS',
  'ASSIGNEE_UNAVAILABLE',
  'TOO_EARLY',
  'INVALID_PERFORMED_AT',
  'EVENT_LIMIT',
  'IDEMPOTENCY_CONFLICT',
]);
export const PLANTING_ACTIONS = Object.freeze([
  'request',
  'cancel',
  'accept',
  'assign',
  'start',
  'complete',
  'cancel-work',
]);
export const PLANTING_PAGE_SIZE = 20;
export const PLANTING_EVENT_LIMIT = 100;
const states = ['requested', 'accepted', 'assigned', 'working', 'completed', 'cancelled'];
const orderFields = [
  'id',
  'recordId',
  'cycleRef',
  'name',
  'unitLabel',
  'status',
  'version',
  'recordVersion',
  'notBefore',
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'assigneeRef',
];
const ensure = (x) => {
  if (!x) throw new TypeError('播种资料无效');
};
const integer = (x, min = 0) => Number.isSafeInteger(x) && x >= min;
const time = (x) => integer(x) && x <= 8.64e15;
const exact = (x, re) => typeof x === 'string' && re.test(x) && !/[\r\n]/u.test(x);
const safe = (x, max = 128) =>
  typeof x === 'string' && x.length >= 1 && x.length <= max && exact(x, /^[A-Za-z0-9_-]+$/u);
const recordId = (x) => exact(x, /^[a-z0-9][a-z0-9-]{7,63}$/u);
const operationKey = (x) => exact(x, /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/u);
export const isPlantingId = (x) => exact(x, /^[a-f0-9]{32}$/u);
const text = (x) =>
  typeof x === 'string' && x.trim().length > 0 && [...x].length <= 64 && !/[\u0000-\u001f\u007f]/u.test(x);
const env = (x) => x === 'development' || x === 'production';
function fields(x, keys) {
  ensure(x && typeof x === 'object' && !Array.isArray(x));
  const p = Object.getPrototypeOf(x);
  ensure(p === Object.prototype || p === null);
  const own = Reflect.ownKeys(x);
  ensure(own.length === keys.length);
  const out = {};
  for (const k of own) {
    ensure(typeof k === 'string' && keys.includes(k));
    const d = Object.getOwnPropertyDescriptor(x, k);
    ensure(d && Object.hasOwn(d, 'value') && d.enumerable);
    out[k] = d.value;
  }
  return out;
}
function array(x, max) {
  ensure(Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype);
  const n = Object.getOwnPropertyDescriptor(x, 'length')?.value;
  ensure(integer(n) && n <= max && Reflect.ownKeys(x).length === n + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(x, String(i));
    ensure(d && Object.hasOwn(d, 'value') && d.enumerable);
    out.push(d.value);
  }
  return out;
}
const bool = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
function envelope(x, ownerId, environment) {
  ensure(
    x.plantingFormat === 1 &&
      safe(ownerId) &&
      x.ownerId === ownerId &&
      env(environment) &&
      x.environment === environment &&
      time(x.serverTime),
  );
}
function order(value, now) {
  const x = fields(value, orderFields);
  ensure(
    isPlantingId(x.id) &&
      recordId(x.recordId) &&
      safe(x.cycleRef, 64) &&
      text(x.name) &&
      text(x.unitLabel) &&
      states.includes(x.status),
  );
  ensure(
    integer(x.version, 1) &&
      x.version <= 100 &&
      integer(x.recordVersion, 1) &&
      time(x.notBefore) &&
      time(x.createdAt) &&
      time(x.updatedAt) &&
      x.createdAt <= x.updatedAt &&
      x.updatedAt <= now,
  );
  ensure(
    x.startedAt === null ||
      (time(x.startedAt) && x.startedAt >= Math.max(x.createdAt, x.notBefore) && x.startedAt <= x.updatedAt),
  );
  ensure(
    x.completedAt === null ||
      (time(x.completedAt) &&
        x.startedAt !== null &&
        x.completedAt >= x.startedAt &&
        x.completedAt <= x.updatedAt),
  );
  ensure(x.assigneeRef === null || isPlantingId(x.assigneeRef));
  if (['requested', 'accepted'].includes(x.status)) ensure(x.assigneeRef === null && x.startedAt === null);
  if (x.status === 'assigned') ensure(x.assigneeRef !== null && x.startedAt === null);
  if (['working', 'completed'].includes(x.status)) ensure(x.startedAt !== null && x.assigneeRef !== null);
  ensure((x.status === 'completed') === (x.completedAt !== null));
  return x;
}
export function isPlantingCommand(input, audience = 'customer') {
  return bool(() => {
    ensure(audience === 'customer' || audience === 'staff');
    const action = fields(input, Object.keys(Object.getOwnPropertyDescriptors(input))).action;
    const keys =
      action === 'request'
        ? ['action', 'recordId', 'expectedRecordVersion']
        : [
            'action',
            'orderId',
            'expectedOrderVersion',
            ...(action === 'assign'
              ? ['assigneeRef']
              : action === 'complete'
                ? ['expectedRecordVersion', 'performedAt']
                : action === 'cancel-work'
                  ? ['stoppedAt', 'reason']
                  : []),
          ];
    const x = fields(input, keys);
    ensure(
      (audience === 'customer'
        ? ['request', 'cancel']
        : ['accept', 'assign', 'start', 'complete', 'cancel-work']
      ).includes(action),
    );
    if (action === 'request') ensure(recordId(x.recordId) && integer(x.expectedRecordVersion, 1));
    else
      ensure(isPlantingId(x.orderId) && integer(x.expectedOrderVersion, 1) && x.expectedOrderVersion <= 100);
    if (action === 'assign') ensure(isPlantingId(x.assigneeRef));
    if (action === 'complete') ensure(integer(x.expectedRecordVersion, 1) && time(x.performedAt));
    if (action === 'cancel-work') ensure(time(x.stoppedAt) && x.reason === 'farm-confirmed-stop');
  });
}
export function normalizePlantingProvision(input) {
  try {
    const x = fields(input, [
      'recordId',
      'expectedPlanVersion',
      'recordVersion',
      'enabled',
      'notBefore',
      'staff',
    ]);
    ensure(
      recordId(x.recordId) &&
        integer(x.expectedPlanVersion) &&
        x.expectedPlanVersion < Number.MAX_SAFE_INTEGER &&
        integer(x.recordVersion, 1) &&
        typeof x.enabled === 'boolean' &&
        time(x.notBefore),
    );
    const seen = new Set();
    const staff = array(x.staff, 40)
      .map((raw) => {
        const s = fields(raw, ['accountId', 'role']);
        ensure(safe(s.accountId) && ['dispatch', 'execute'].includes(s.role));
        const k = s.accountId + '\0' + s.role;
        ensure(!seen.has(k));
        seen.add(k);
        return { accountId: s.accountId, role: s.role };
      })
      .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.role.localeCompare(b.role));
    return {
      recordId: x.recordId,
      expectedPlanVersion: x.expectedPlanVersion,
      recordVersion: x.recordVersion,
      enabled: x.enabled,
      notBefore: x.notBefore,
      staff,
    };
  } catch {
    throw new TypeError('播种配置无效');
  }
}
export function isPlantingStatus(value, ownerId, environment) {
  return bool(() => {
    const x = fields(value, [
      'plantingFormat',
      'ownerId',
      'environment',
      'serverTime',
      'available',
      'hasStaffAccess',
    ]);
    envelope(x, ownerId, environment);
    ensure(
      typeof x.available === 'boolean' &&
        typeof x.hasStaffAccess === 'boolean' &&
        (!x.hasStaffAccess || x.available),
    );
  });
}
export function isPlantingRecord(value, ownerId, environment, id) {
  return bool(() => {
    const x = fields(value, [
      'plantingFormat',
      'ownerId',
      'environment',
      'serverTime',
      'recordId',
      'recordVersion',
      'enabled',
      'notBefore',
      'currentOrderId',
    ]);
    envelope(x, ownerId, environment);
    ensure(
      recordId(x.recordId) &&
        x.recordId === id &&
        integer(x.recordVersion, 1) &&
        typeof x.enabled === 'boolean' &&
        (x.notBefore === null || time(x.notBefore)) &&
        (x.currentOrderId === null || isPlantingId(x.currentOrderId)),
    );
    ensure(!x.enabled || x.notBefore !== null);
  });
}
export function isPlantingPage(value, ownerId, environment) {
  return bool(() => {
    const x = fields(value, [
      'plantingFormat',
      'ownerId',
      'environment',
      'serverTime',
      'items',
      'nextCursor',
    ]);
    envelope(x, ownerId, environment);
    let prev = '';
    const items = array(x.items, 20);
    for (const raw of items) {
      const o = order(raw, x.serverTime);
      ensure(o.id > prev);
      prev = o.id;
    }
    ensure(x.nextCursor === null || (items.length === 20 && x.nextCursor === prev));
  });
}
export function isPlantingDetail(value, ownerId, environment, id) {
  return bool(() => {
    const x = fields(value, [
      'plantingFormat',
      'ownerId',
      'environment',
      'serverTime',
      'order',
      'events',
      'candidates',
      'permissions',
    ]);
    envelope(x, ownerId, environment);
    const o = order(x.order, x.serverTime);
    ensure(o.id === id);
    const events = array(x.events, 100);
    ensure(events.length === o.version);
    let state = null,
      recorded = o.createdAt,
      started = null,
      completed = null;
    for (let i = 0; i < events.length; i++) {
      const e = fields(events[i], ['version', 'action', 'recordedAt', 'occurredAt', 'actorRef']);
      ensure(
        e.version === i + 1 &&
          PLANTING_ACTIONS.includes(e.action) &&
          time(e.recordedAt) &&
          e.recordedAt >= recorded &&
          e.recordedAt <= o.updatedAt &&
          time(e.occurredAt) &&
          e.occurredAt <= e.recordedAt &&
          (e.actorRef === 'customer' || isPlantingId(e.actorRef)),
      );
      recorded = e.recordedAt;
      if (e.action === 'request') {
        ensure(state === null && e.actorRef === 'customer' && e.recordedAt === o.createdAt);
        state = 'requested';
      } else if (e.action === 'accept') {
        ensure(state === 'requested' && isPlantingId(e.actorRef));
        state = 'accepted';
      } else if (e.action === 'assign') {
        ensure(['accepted', 'assigned'].includes(state) && isPlantingId(e.actorRef));
        state = 'assigned';
      } else if (e.action === 'start') {
        ensure(state === 'assigned' && e.actorRef === o.assigneeRef && e.occurredAt >= o.notBefore);
        state = 'working';
        started = e.occurredAt;
      } else if (e.action === 'complete') {
        ensure(state === 'working' && e.actorRef === o.assigneeRef && e.occurredAt >= started);
        state = 'completed';
        completed = e.occurredAt;
      } else if (e.action === 'cancel') {
        ensure(['requested', 'accepted', 'assigned'].includes(state) && e.actorRef === 'customer');
        state = 'cancelled';
      } else {
        ensure(state === 'working' && isPlantingId(e.actorRef) && e.occurredAt >= started);
        state = 'cancelled';
      }
      if (!['complete', 'cancel-work'].includes(e.action)) ensure(e.occurredAt === e.recordedAt);
    }
    ensure(
      state === o.status &&
        recorded === o.updatedAt &&
        started === o.startedAt &&
        completed === o.completedAt,
    );
    const refs = new Set();
    for (const raw of array(x.candidates, 40)) {
      const c = fields(raw, ['ref', 'label']);
      ensure(isPlantingId(c.ref) && c.label === '农务员' + c.ref.slice(0, 6) && !refs.has(c.ref));
      refs.add(c.ref);
    }
    const p = fields(x.permissions, [
      'canCancel',
      'canAccept',
      'canAssign',
      'canStart',
      'canComplete',
      'canCancelWork',
    ]);
    for (const v of Object.values(p)) ensure(typeof v === 'boolean');
    ensure(!p.canCancel || ['requested', 'accepted', 'assigned'].includes(o.status));
    ensure(!p.canAccept || o.status === 'requested');
    ensure(!p.canAssign || ['accepted', 'assigned'].includes(o.status));
    ensure(!p.canStart || o.status === 'assigned');
    ensure(!p.canComplete || o.status === 'working');
    ensure(!p.canCancelWork || o.status === 'working');
  });
}
export function isPlantingReceipt(value, ownerId, environment, key, action) {
  return bool(() => {
    const x = fields(value, [
      'plantingFormat',
      'ownerId',
      'environment',
      'operationKey',
      'action',
      'outcome',
      'code',
      'orderId',
      'completedAt',
    ]);
    ensure(
      x.plantingFormat === 1 &&
        safe(ownerId) &&
        x.ownerId === ownerId &&
        env(environment) &&
        x.environment === environment &&
        operationKey(key) &&
        x.operationKey === key &&
        PLANTING_ACTIONS.includes(action) &&
        x.action === action &&
        PLANTING_CODES.includes(x.code) &&
        (x.outcome === 'applied' || x.outcome === 'refused') &&
        (x.outcome === 'applied') === (x.code === 'OK') &&
        (x.orderId === null || isPlantingId(x.orderId)) &&
        time(x.completedAt),
    );
    ensure(x.code !== 'OK' || x.orderId !== null);
  });
}
