import { Agent, request as httpRequest } from 'node:http';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';

const DEFAULTS = Object.freeze({ workers: 4, durationSeconds: 60, requestsPerWorker: 10000 });
const RATE_LIMIT = Object.freeze({ maxRequests: 10000, windowMs: 1000, authMaxAttempts: 1000, authWindowMs: 1000 });
const INVENTORY = Object.freeze({ fertilizer: 2, tools: 1, seedPacks: 0, eggs: 0, crops: 0, meat: 0, decorations: 0 });
const REQUEST_TIMEOUT_MS = 5000, CYCLE_PAUSE_MS = 250, RESPONSE_LIMIT_BYTES = 256 * 1024;
// Business time advances with real elapsed time from a controlled daytime seed.
// Wall-clock/Shanghai-midnight behavior has separate API rules tests; it must not
// introduce unrelated revision conflicts into this fixed-workload comparison.
const BUSINESS_CLOCK_EPOCH = Date.parse('2026-10-27T04:00:00Z');
const FAILURE_CODES = new Set(['cancelled', 'deadline', 'transport', 'requestTimeout', 'responseInvalid', 'unexpected5xx',
  'unexpectedStatus', 'assetMismatch', 'replayMismatch', 'conflictMismatch', 'requestBudget', 'cleanup', 'shutdown', 'startup']);

class LoadFailure extends Error {
  constructor(code) { super('Local load verification failed'); this.code = code; }
}
const check = (value, code = 'assetMismatch') => { if (!value) throw new LoadFailure(code); };
const same = (actual, expected) => check(isDeepStrictEqual(actual, expected));
const rounded = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;

function normalizedOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['workers', 'durationSeconds', 'requestsPerWorker', 'signal'].includes(key))) {
    throw new TypeError('Invalid load-test options');
  }
  const result = { ...DEFAULTS, ...options };
  for (const [key, min, max] of [['workers', 1, 16], ['durationSeconds', 1, 300], ['requestsPerWorker', 16, 10000]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) throw new TypeError('Invalid load-test bounds');
  }
  if (result.signal !== undefined && !(result.signal instanceof AbortSignal)) throw new TypeError('Invalid cancellation signal');
  return result;
}

export function parseLoadOptions(args) {
  if (!Array.isArray(args)) throw new TypeError('Invalid load-test arguments');
  const flags = { '--workers': 'workers', '--duration': 'durationSeconds', '--requests-per-worker': 'requestsPerWorker' };
  const options = {}, seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!Object.hasOwn(flags, flag) || seen.has(flag) || typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
      throw new TypeError('Invalid load-test arguments');
    }
    seen.add(flag); options[flags[flag]] = Number(value);
  }
  return normalizedOptions(options);
}

// All expected economic values are hand-derived from the development API contract:
// 80 points - (2 * 30 - 20 coupon) = 40; 6 feed + 2 * 3 = 12.
export function verifyAccountSnapshot(snapshot, { profileId, revision, cart }) {
  try {
    check(snapshot.environment === 'development' && snapshot.profile.id === profileId && snapshot.revision === revision);
    same({ ...snapshot.wallet, receipts: [] }, { points: 40, feed: 12, adToday: 0, inviteCount: 0, welcomeClaimed: false, receipts: [] });
    same(snapshot.system.inventory, INVENTORY); same(snapshot.system.cart, cart);
    check(snapshot.system.coupons.length === 1);
    const coupon = snapshot.system.coupons[0];
    check(coupon.id === 'welcome-20' && coupon.min === 60 && coupon.off === 20 && coupon.used === true);
    check(snapshot.system.purchases.length === 1);
    const purchase = snapshot.system.purchases[0];
    check(purchase.couponId === 'welcome-20' && purchase.count === 2 && purchase.subtotal === 60 && purchase.discount === 20 && purchase.total === 40);
    check(purchase.items.length === 1 && purchase.items[0].id === 'feed-pack' && purchase.items[0].quantity === 2 &&
      purchase.items[0].cost === 30 && purchase.items[0].lineTotal === 60);
    same(purchase.items[0].grant, { feed: 3 });
    check(typeof purchase.receiptId === 'string' && purchase.receiptId.length > 0);
    same(snapshot.wallet.receipts, [purchase.receiptId]); same(snapshot.system.receipts, [purchase.receiptId]);
    check(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.system.daily.day) && snapshot.system.daily.day >= purchase.day);
    same(snapshot.system.daily.bought, snapshot.system.daily.day === purchase.day ? { 'feed-pack': 2 } : {});
  } catch { throw new LoadFailure('assetMismatch'); }
}

function verifyInitial(snapshot, profileId) {
  try {
    check(snapshot.profile.id === profileId && snapshot.environment === 'development' && snapshot.revision === 0);
    same(snapshot.wallet, { points: 80, feed: 6, adToday: 0, inviteCount: 0, welcomeClaimed: false, receipts: [] });
    same(snapshot.system.inventory, INVENTORY); same(snapshot.system.cart, {}); same(snapshot.system.purchases, []);
    same(snapshot.system.receipts, []); same(snapshot.system.daily.bought, {});
    check(snapshot.system.coupons.length === 1 && snapshot.system.coupons[0].id === 'welcome-20' && snapshot.system.coupons[0].used === false);
  } catch { throw new LoadFailure('assetMismatch'); }
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    const failed = () => { app.server.off('listening', ready); reject(new LoadFailure('startup')); };
    const ready = () => { app.server.off('error', failed); resolve(); };
    app.server.once('error', failed); app.server.once('listening', ready);
    try { app.server.listen(0, '127.0.0.1'); } catch { failed(); }
  });
  const address = app.server.address();
  check(address && typeof address !== 'string' && address.address === '127.0.0.1', 'startup');
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function within(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LoadFailure(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// The path is not a caller option. Verify this exact newly-created direct child
// and its original real path before invoking the only recursive removal here.
async function removeOwnedSandbox(directory, root, originalRealPath) {
  check(path.isAbsolute(directory) && path.dirname(directory) === root &&
    /^farm-api-load-[A-Za-z0-9]{6}$/.test(path.basename(directory)), 'cleanup');
  const stat = await lstat(directory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === originalRealPath &&
    path.dirname(originalRealPath) === root, 'cleanup');
  await rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

function percentiles(samples) {
  if (!samples.length) return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = samples.slice().sort((a, b) => a - b);
  const percentile = fraction => rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
  return { min: rounded(sorted[0]), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: rounded(sorted.at(-1)) };
}

export async function runLoadTest(options = {}) {
  const settings = normalizedOptions(options), started = performance.now(), controller = new AbortController();
  const histogram = monitorEventLoopDelay({ resolution: 20 }), latency = [];
  const report = { schemaVersion: 1, passed: false, workers: settings.workers, durationSecondsRequested: settings.durationSeconds,
    businessClock: 'controlled-daytime-plus-monotonic-elapsed',
    requestsPerWorkerLimit: settings.requestsPerWorker, hardRequestLimit: settings.workers * settings.requestsPerWorker,
    elapsedMs: 0, workloadElapsedMs: 0, requests: 0, responses: 0, readRequests: 0, writeRequests: 0,
    expected409: 0, expected401: 0, initialCheckouts: 0, sameKeyReplayPairs: 0, revisionConflictPairs: 0,
    completedCycles: 0, verifiedAccounts: 0, stoppedByRequestLimitWorkers: 0,
    unexpected5xx: 0, errors: 0, cancelled: false, failureCounts: {},
    latencyMs: {}, eventLoopDelayMs: {}, rssBytes: { start: process.memoryUsage().rss, end: 0, peak: 0, delta: 0 },
    rateLimit: { ...RATE_LIMIT }, sandboxRemoved: false };
  report.rssBytes.peak = report.rssBytes.start;
  let directory, root, originalRealPath, app, base, agent, watchdog, workloadStarted, deadlineExceeded = false;
  const fail = error => {
    const code = FAILURE_CODES.has(error?.code) ? error.code : 'startup';
    report.errors++; report.failureCounts[code] = (report.failureCounts[code] ?? 0) + 1;
  };
  const cancelled = () => { report.cancelled = true; controller.abort(); };
  if (settings.signal?.aborted) cancelled();
  else settings.signal?.addEventListener('abort', cancelled, { once: true });
  const ensureRunning = () => { if (controller.signal.aborted) throw new LoadFailure(deadlineExceeded ? 'deadline' : 'cancelled'); };
  const createTemporaryApp = () => createApp({ mode: 'development', allowDevelopmentAuth: true,
    databasePath: path.join(directory, 'load.sqlite'),
    clock: () => BUSINESS_CLOCK_EPOCH + Math.floor(performance.now() - started),
    developmentAuthLimit: { maxAttempts: RATE_LIMIT.authMaxAttempts, windowMs: RATE_LIMIT.authWindowMs },
    requestRateLimit: { maxRequests: RATE_LIMIT.maxRequests, windowMs: RATE_LIMIT.windowMs } });
  const connect = async () => {
    app = createTemporaryApp(); base = await listen(app);
    agent = new Agent({ keepAlive: true, maxSockets: settings.workers * 2, maxFreeSockets: settings.workers * 2 });
  };
  const close = async () => {
    agent?.destroy();
    if (!app) return;
    try { await within(app.close(), 7000, 'shutdown'); }
    catch (error) { app.server.closeAllConnections(); throw error; }
    app = undefined;
  };
  const send = async (worker, route, { body, key, token = worker.token, expected = [200] } = {}) => {
    ensureRunning();
    check(worker.used < settings.requestsPerWorker, 'requestBudget'); worker.used++; report.requests++;
    const method = body === undefined ? 'GET' : 'POST'; report[method === 'GET' ? 'readRequests' : 'writeRequests']++;
    const requestStarted = performance.now();
    try {
      const result = await new Promise((resolve, reject) => {
        let done = false, timer;
        const finish = (error, value) => {
          if (done) return; done = true; clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        const outgoing = httpRequest(base + route, { method, agent, signal: controller.signal, headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        } }, response => {
          let bytes = 0; const chunks = [];
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > RESPONSE_LIMIT_BYTES) { finish(new LoadFailure('responseInvalid')); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('error', () => finish(new LoadFailure('transport')));
          response.on('aborted', () => finish(new LoadFailure('transport')));
          response.on('end', () => {
            report.responses++;
            if (response.statusCode >= 500) { report.unexpected5xx++; finish(new LoadFailure('unexpected5xx')); return; }
            if (!expected.includes(response.statusCode)) { finish(new LoadFailure('unexpectedStatus')); return; }
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              check(typeof json.requestId === 'string' && json.requestId === response.headers['x-request-id'], 'responseInvalid');
              if (response.statusCode === 409) report.expected409++;
              if (response.statusCode === 401) report.expected401++;
              finish(null, { status: response.statusCode, json });
            } catch { finish(new LoadFailure('responseInvalid')); }
          });
        });
        outgoing.on('error', () => finish(new LoadFailure(controller.signal.aborted ?
          (deadlineExceeded ? 'deadline' : 'cancelled') : 'transport')));
        timer = setTimeout(() => { finish(new LoadFailure('requestTimeout')); outgoing.destroy(); }, REQUEST_TIMEOUT_MS);
        outgoing.end(body === undefined ? undefined : JSON.stringify(body));
      });
      return result;
    } finally { latency.push(performance.now() - requestStarted); }
  };
  const snapshot = async worker => (await send(worker, '/bootstrap')).json.data;
  const mutate = (worker, route, body, key, expected) => send(worker, route, { body, key, expected });
  const verify = (worker, value, cart = {}, revision = worker.revision) =>
    verifyAccountSnapshot(value, { profileId: worker.profileId, revision, cart });
  const replayPair = (pair, expectedSnapshot) => {
    check(pair.every(result => result.status === 200) && pair.filter(result => result.json.replayed === true).length === 1 &&
      pair.filter(result => result.json.replayed === false).length === 1, 'replayMismatch');
    check(isDeepStrictEqual(pair[0].json.data, pair[1].json.data) &&
      (!expectedSnapshot || isDeepStrictEqual(pair[0].json.data, expectedSnapshot)), 'replayMismatch');
    report.sameKeyReplayPairs++;
  };
  histogram.enable();
  const memorySampler = setInterval(() => { report.rssBytes.peak = Math.max(report.rssBytes.peak, process.memoryUsage().rss); }, 50);
  memorySampler.unref();
  try {
    root = await realpath(tmpdir());
    directory = await mkdtemp(path.join(root, 'farm-api-load-')); originalRealPath = await realpath(directory);
    ensureRunning();
    watchdog = setTimeout(() => { deadlineExceeded = true; controller.abort(); }, settings.durationSeconds * 1000 + 30000);
    await connect();
    const workers = Array.from({ length: settings.workers }, (_, index) => ({ account: `load_member_${index}`, used: 0, revision: 2, cycle: 0 }));
    const initialize = workers.map(async worker => {
      const auth = (await send(worker, '/auth/development', { body: { account: worker.account } })).json.data;
      check(typeof auth?.token === 'string' && typeof auth?.profile?.id === 'string', 'responseInvalid');
      worker.token = auth.token; worker.profileId = auth.profile.id;
      verifyInitial(await snapshot(worker), worker.profileId);
      const unauthorized = await send(worker, '/bootstrap', { token: '', expected: [401] });
      check(unauthorized.json.error?.code === 'UNAUTHENTICATED', 'responseInvalid');
      await mutate(worker, '/cart/items', { sku: 'feed-pack', delta: 2, expectedRevision: 0 }, 'load-initial-cart');
      worker.checkoutBody = { couponId: 'welcome-20', expectedRevision: 1 };
      const pair = await Promise.all([0, 1].map(() => mutate(worker, '/checkout', worker.checkoutBody, 'load-original-checkout')));
      replayPair(pair); worker.checkoutSnapshot = pair[0].json.data; verify(worker, worker.checkoutSnapshot);
      report.initialCheckouts++;
    });
    try { await Promise.all(initialize); }
    catch (error) { controller.abort(); await Promise.allSettled(initialize); throw error; }
    check(new Set(workers.map(worker => worker.profileId)).size === settings.workers);
    workloadStarted = performance.now(); const deadline = workloadStarted + settings.durationSeconds * 1000;
    const running = workers.map(async worker => {
      while (performance.now() < deadline) {
        // Seven requests per whole cycle; reserve two for restart/login verification.
        if (worker.used + 9 > settings.requestsPerWorker) { report.stoppedByRequestLimitWorkers++; break; }
        ensureRunning(); verify(worker, await snapshot(worker));
        const replay = await mutate(worker, '/checkout', worker.checkoutBody, 'load-original-checkout');
        check(replay.json.replayed === true && isDeepStrictEqual(replay.json.data, worker.checkoutSnapshot), 'replayMismatch');
        const cycle = ++worker.cycle, body = { sku: 'fertilizer', delta: 1, expectedRevision: worker.revision };
        const raced = await Promise.all([0, 1].map(index => mutate(worker, '/cart/items', body, `load-add-${cycle}-${index}`, [200, 409])));
        check(isDeepStrictEqual(raced.map(result => result.status).sort(), [200, 409]), 'conflictMismatch');
        check(raced.find(result => result.status === 409).json.error?.code === 'REVISION_CONFLICT', 'conflictMismatch');
        worker.revision++;
        for (const result of raced) verify(worker, result.json.data, { fertilizer: 1 });
        report.revisionConflictPairs++;
        const removeBody = { sku: 'fertilizer', delta: -1, expectedRevision: worker.revision };
        const removed = await Promise.all([0, 1].map(() => mutate(worker, '/cart/items', removeBody, `load-remove-${cycle}`)));
        replayPair(removed); worker.revision++;
        for (const result of removed) verify(worker, result.json.data);
        verify(worker, await snapshot(worker)); report.completedCycles++;
        const pause = Math.min(CYCLE_PAUSE_MS, deadline - performance.now());
        if (pause > 0) await delay(pause, undefined, { signal: controller.signal });
      }
    });
    try { await Promise.all(running); }
    catch (error) { controller.abort(); await Promise.allSettled(running); throw error; }
    report.workloadElapsedMs = rounded(performance.now() - workloadStarted);
    await close(); ensureRunning(); await connect();
    for (const worker of workers) {
      const auth = (await send(worker, '/auth/development', { token: '', body: { account: worker.account } })).json.data;
      check(auth.profile.id === worker.profileId && auth.token !== worker.token);
      worker.token = auth.token; verify(worker, await snapshot(worker)); report.verifiedAccounts++;
    }
    check(report.requests === report.responses && report.verifiedAccounts === settings.workers);
  } catch (error) {
    if (workloadStarted && report.workloadElapsedMs === 0) report.workloadElapsedMs = rounded(performance.now() - workloadStarted);
    fail(controller.signal.aborted && error?.name === 'AbortError' ? new LoadFailure(deadlineExceeded ? 'deadline' : 'cancelled') : error);
    controller.abort();
  } finally {
    clearTimeout(watchdog); settings.signal?.removeEventListener('abort', cancelled);
    try { await close(); } catch { fail(new LoadFailure('shutdown')); }
    if (directory) {
      try { await removeOwnedSandbox(directory, root, originalRealPath); report.sandboxRemoved = true; }
      catch { fail(new LoadFailure('cleanup')); }
    }
    clearInterval(memorySampler); histogram.disable();
    report.elapsedMs = rounded(performance.now() - started); report.latencyMs = percentiles(latency);
    report.eventLoopDelayMs = histogram.count ? {
      min: rounded(histogram.min / 1e6), p50: rounded(histogram.percentile(50) / 1e6),
      p95: rounded(histogram.percentile(95) / 1e6), p99: rounded(histogram.percentile(99) / 1e6),
      max: rounded(histogram.max / 1e6), mean: rounded(histogram.mean / 1e6),
    } : { min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    report.rssBytes.end = process.memoryUsage().rss;
    report.rssBytes.peak = Math.max(report.rssBytes.peak, report.rssBytes.end);
    report.rssBytes.delta = report.rssBytes.end - report.rssBytes.start;
    report.passed = report.errors === 0 && report.unexpected5xx === 0 && report.sandboxRemoved;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node services/api/tools/load-api.mjs [--duration 1..300] [--workers 1..16] [--requests-per-worker 16..10000]\nCreates only a new temporary local development sandbox. No target URL or database option is supported.\n');
  } else {
    try {
      const settings = parseLoadOptions(process.argv.slice(2)), cancellation = new AbortController();
      const cancel = () => cancellation.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const report = await runLoadTest({ ...settings, signal: cancellation.signal });
        process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = report.passed ? 0 : 1;
      } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    } catch { process.stderr.write('Invalid load-test arguments. Use --help for bounds; no external target is supported.\n'); process.exitCode = 1; }
  }
}
