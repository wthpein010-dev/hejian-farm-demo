import { randomUUID } from 'node:crypto';

const ROUTES = new Set([
  '/livez', '/readyz', '/healthz', '/api/v1/auth/development', '/api/v1/auth/platform',
  '/api/v1/auth/logout', '/api/v1/bootstrap', '/api/v1/account/privacy',
  '/api/v1/account/checkout-receipt',
  '/api/v1/friends', '/api/v1/friends/commands',
  '/api/v1/forum/status', '/api/v1/forum/commands',
  '/api/v1/planting/status', '/api/v1/planting/commands', '/api/v1/staff/planting/commands',
  '/api/v1/account/deletion/prepare', '/api/v1/account/deletion/confirm', '/api/v1/cart/items',
  '/api/v1/checkout', '/api/v1/events/shop-visit', '/api/v1/activities/sign-in', '/api/v1/activities/season/claim',
]);
const METHODS = new Set(['GET', 'POST', 'OPTIONS']);
const LATENCY_BUCKETS = Object.freeze([5, 25, 100, 500, 2000, 10000]);

function routeTemplate(pathname) {
  if (ROUTES.has(pathname)) return pathname;
  if (/^\/api\/v1\/planting\/record\/[a-z0-9][a-z0-9-]{7,63}$/.test(pathname)) return '/api/v1/planting/record/:recordId';
  if (/^\/api\/v1\/(staff\/)?planting\/orders\/(start|[a-f0-9]{32})$/.test(pathname)) return pathname.includes('/staff/') ? '/api/v1/staff/planting/orders/:cursor' : '/api/v1/planting/orders/:cursor';
  if (/^\/api\/v1\/(staff\/)?planting\/order\/[a-f0-9]{32}$/.test(pathname)) return pathname.includes('/staff/') ? '/api/v1/staff/planting/order/:orderId' : '/api/v1/planting/order/:orderId';
  if (/^\/api\/v1\/forum\/posts\/(all|harvest|questions|chat)\/(start|[a-f0-9]{32})$/.test(pathname)) return '/api/v1/forum/posts/:circle/:cursor';
  if (/^\/api\/v1\/forum\/(mine|reports)\/(start|[a-f0-9]{32})$/.test(pathname)) return pathname.includes('/mine/') ? '/api/v1/forum/mine/:cursor' : '/api/v1/forum/reports/:cursor';
  if (/^\/api\/v1\/forum\/post\/[a-f0-9]{32}\/(start|[a-f0-9]{32})$/.test(pathname)) return '/api/v1/forum/post/:id/:cursor';
  if (/^\/api\/v1\/account\/exchanges\/(start|shop-api-[a-f0-9]{64})$/.test(pathname)) return '/api/v1/account/exchanges/:cursor';
  if (/^\/api\/v1\/account\/exchange\/shop-api-[a-f0-9]{64}$/.test(pathname)) return '/api/v1/account/exchange/:exchangeId';
  if (/^\/api\/v1\/farm\/records\/(plots|animals)\/(start|[a-z0-9][a-z0-9-]{7,63})$/.test(pathname)) return '/api/v1/farm/records/:kind/:cursor';
  if (/^\/api\/v1\/farm\/record\/[a-z0-9][a-z0-9-]{7,63}\/(0|[1-9][0-9]{0,15})$/.test(pathname)) return '/api/v1/farm/record/:recordId/:beforeVersion';
  if (/^\/api\/v1\/activities\/tasks\/[A-Za-z0-9_-]{1,64}\/claim$/.test(pathname)) return '/api/v1/activities/tasks/:taskId/claim';
  if (/^\/api\/v1\/activities\/achievements\/[A-Za-z0-9_-]{1,64}\/claim$/.test(pathname)) return '/api/v1/activities/achievements/:achievementId/claim';
  return 'unknown';
}

// This sink never maintains its own queue. Once the stream's bounded byte budget
// is reached, diagnostics are dropped rather than retaining business traffic.
export function createJsonLineLogger(stream, { maxBufferedBytes = 65536 } = {}) {
  if (!stream || typeof stream.write !== 'function' || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 256 || maxBufferedBytes > 1048576) {
    throw new TypeError('Diagnostic output configuration is invalid');
  }
  let dropped = 0, failed = false;
  stream.on?.('error', () => { failed = true; });
  const logger = event => {
    try {
      if (failed || stream.destroyed || stream.writableEnded) { dropped++; return; }
      const line = JSON.stringify(event) + '\n', bytes = Buffer.byteLength(line);
      if (bytes > maxBufferedBytes || (Number(stream.writableLength) || 0) + bytes > maxBufferedBytes) { dropped++; return; }
      stream.write(line);
    } catch { dropped++; }
  };
  logger.dropped = () => dropped;
  return logger;
}

export function createOperations(logger) {
  if (logger !== undefined && typeof logger !== 'function') throw new TypeError('logger must be a function');
  const requests = new Map();
  let completed = 0, aborted = 0, active = 0, maxActive = 0;
  const emit = event => {
    try {
      const pending = logger?.(Object.freeze(event));
      // An embedded async sink is optional and must not reject into an HTTP
      // handler or become an asset-transaction dependency.
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch {}
  };
  return {
    lifecycle(phase) {
      if (['listening', 'draining', 'forced', 'stopped', 'startup_failed', 'configuration_failed'].includes(phase)) emit({ event: 'lifecycle', phase });
    },
    observe(request, response) {
      const requestId = randomUUID(), started = process.hrtime.bigint();
      const method = METHODS.has(request.method) ? request.method : 'OTHER';
      let route = 'invalid', recorded = false;
      active++; maxActive = Math.max(maxActive, active);
      const finish = outcome => {
        if (recorded) return;
        recorded = true; active--;
        if (outcome === 'completed') completed++; else aborted++;
        const durationMs = Math.max(0, Number(process.hrtime.bigint() - started) / 1e6);
        const status = outcome === 'aborted' && !response.headersSent ? 0
          : Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : 0;
        const key = `${method}|${route}|${status}|${outcome}`;
        let metric = requests.get(key);
        if (!metric) {
          metric = { route, method, status, outcome, count: 0, durationMs: 0, latencyBuckets: Array(LATENCY_BUCKETS.length + 1).fill(0) };
          requests.set(key, metric);
        }
        metric.count++; metric.durationMs += durationMs;
        const index = LATENCY_BUCKETS.findIndex(bound => durationMs <= bound);
        metric.latencyBuckets[index === -1 ? LATENCY_BUCKETS.length : index]++;
        emit({ event: 'request', requestId, route, method, status, outcome, durationMs });
      };
      response.once('finish', () => finish('completed'));
      response.once('close', () => finish(response.writableFinished ? 'completed' : 'aborted'));
      return { requestId, route(pathname) { route = routeTemplate(pathname); } };
    },
    metrics() {
      return { completed, aborted, active, maxActive, latencyBoundsMs: [...LATENCY_BUCKETS, null],
        requests: [...requests.values()].map(metric => ({ ...metric, latencyBuckets: [...metric.latencyBuckets] })) };
    },
  };
}
