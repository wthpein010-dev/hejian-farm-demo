import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, realpath, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let runner = {};
try { runner = await import('../tools/load-api.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const script = fileURLToPath(new URL('../tools/load-api.mjs', import.meta.url));
const cliEnvironment = { ...process.env };
delete cliEnvironment.NODE_TEST_CONTEXT;

test('load options reject external targets, out-of-bounds work and ambiguous arguments before creating a service', () => {
  assert.equal(typeof runner.parseLoadOptions, 'function', 'the bounded load CLI must validate its inputs');
  assert.deepEqual(runner.parseLoadOptions([]), { workers: 4, durationSeconds: 60, requestsPerWorker: 10000 });
  assert.deepEqual(runner.parseLoadOptions(['--workers', '16', '--duration', '300', '--requests-per-worker', '16']),
    { workers: 16, durationSeconds: 300, requestsPerWorker: 16 });
  for (const args of [
    ['--url', 'https://example.invalid'], ['--database', 'existing.sqlite'], ['http://127.0.0.1:8787'],
    ['--workers', '0'], ['--workers', '17'], ['--duration', '0'], ['--duration', '301'],
    ['--requests-per-worker', '15'], ['--requests-per-worker', '10001'], ['--workers', '1.5'],
    ['--workers'], ['--duration', '1', '--duration', '2'], ['--duration', '1e2'],
  ]) assert.throws(() => runner.parseLoadOptions(args), TypeError);
});

test('one-second real HTTP and temporary SQLite load verifies checkout, replay, conflicts and restart without exposing identities', { timeout: 15000 }, async () => {
  assert.equal(typeof runner.runLoadTest, 'function', 'the load runner must execute its own isolated service');
  const report = await runner.runLoadTest({ workers: 2, durationSeconds: 1 });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.workers, 2);
  assert.equal(report.verifiedAccounts, 2);
  assert.equal(report.initialCheckouts, 2);
  assert.ok(report.completedCycles >= 2);
  assert.equal(report.revisionConflictPairs, report.completedCycles);
  assert.equal(report.expected409, report.completedCycles);
  assert.equal(report.expected401, 2);
  assert.equal(report.sameKeyReplayPairs, report.completedCycles + 2);
  assert.equal(report.requests, report.responses);
  assert.ok(report.requests > 20);
  assert.ok(report.readRequests > 0 && report.writeRequests > 0);
  assert.ok(report.workloadElapsedMs >= 1000);
  assert.equal(report.unexpected5xx, 0);
  assert.equal(report.errors, 0);
  assert.equal(report.sandboxRemoved, true);
  assert.equal(report.rateLimit.maxRequests, 10000);
  assert.equal(report.rateLimit.windowMs, 1000);
  for (const value of Object.values(report.latencyMs)) assert.ok(Number.isFinite(value) && value >= 0);
  for (const value of Object.values(report.eventLoopDelayMs)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.ok(report.rssBytes.peak >= report.rssBytes.start);
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /Bearer|token|profile|account-|sqlite|farm-api-load-|127\.0\.0\.1|\\Users\\/i);
});

test('the per-worker hard request budget stops a real workload before it can exceed its cap', { timeout: 15000 }, async () => {
  assert.equal(typeof runner.runLoadTest, 'function');
  const report = await runner.runLoadTest({ workers: 1, durationSeconds: 1, requestsPerWorker: 16 });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.ok(report.requests <= 16);
  assert.equal(report.stoppedByRequestLimitWorkers, 1);
  assert.equal(report.completedCycles, 1);
  assert.equal(report.verifiedAccounts, 1);
  assert.equal(report.sandboxRemoved, true);
});

test('economic verification detects debit, grant, stock, coupon and history drift rather than accepting a healthy HTTP status', () => {
  assert.equal(typeof runner.verifyAccountSnapshot, 'function');
  const fixture = () => ({
    environment: 'development', revision: 2, profile: { id: 'synthetic-owner' },
    wallet: { points: 40, feed: 12, adToday: 0, inviteCount: 0, welcomeClaimed: false, receipts: ['receipt-1'] },
    system: { inventory: { fertilizer: 2, tools: 1, seedPacks: 0, eggs: 0, crops: 0, meat: 0, decorations: 0 },
      cart: {}, coupons: [{ id: 'welcome-20', min: 60, off: 20, used: true }],
      daily: { day: '2026-10-27', bought: { 'feed-pack': 2 } }, receipts: ['receipt-1'],
      purchases: [{ receiptId: 'receipt-1', couponId: 'welcome-20', day: '2026-10-27', count: 2, subtotal: 60, discount: 20, total: 40,
        items: [{ id: 'feed-pack', quantity: 2, cost: 30, lineTotal: 60, grant: { feed: 3 } }] }],
    },
  });
  const expectation = { profileId: 'synthetic-owner', revision: 2, cart: {} };
  assert.doesNotThrow(() => runner.verifyAccountSnapshot(fixture(), expectation));
  for (const corrupt of [
    s => { s.wallet.points = 0; }, s => { s.wallet.feed = 18; },
    s => { s.system.inventory.fertilizer = 3; }, s => { s.system.daily.bought['feed-pack'] = 4; },
    s => { s.system.coupons[0].used = false; }, s => { s.system.purchases.push(s.system.purchases[0]); },
    s => { s.system.purchases[0].total = 60; }, s => { s.wallet.receipts.push('receipt-2'); },
    s => { s.system.cart.fertilizer = 1; }, s => { s.profile.id = 'another-owner'; }, s => { s.revision++; },
  ]) {
    const snapshot = fixture(); corrupt(snapshot);
    assert.throws(() => runner.verifyAccountSnapshot(snapshot, expectation));
  }
});

test('an already cancelled load returns a failed redacted report and removes only its own temporary sandbox', { timeout: 15000 }, async () => {
  assert.equal(typeof runner.runLoadTest, 'function');
  const controller = new AbortController(); controller.abort();
  const report = await runner.runLoadTest({ durationSeconds: 1, workers: 1, signal: controller.signal });
  assert.equal(report.passed, false);
  assert.ok(report.errors > 0);
  assert.equal(report.cancelled, true);
  assert.equal(report.sandboxRemoved, true);
  assert.equal(report.requests, 0);
});

test('the CLI exits nonzero for a caller-provided target instead of running against it', () => {
  assert.equal(typeof runner.parseLoadOptions, 'function');
  const result = spawnSync(process.execPath, [script, '--url', 'http://127.0.0.1:8787'],
    { encoding: 'utf8', timeout: 5000, env: cliEnvironment });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(result.stderr, /Invalid load-test arguments/);
});

test('real Node default test discovery does not execute the load CLI filename', async () => {
  assert.equal(typeof runner.parseLoadOptions, 'function');
  const root = await realpath(tmpdir()), directory = await mkdtemp(path.join(root, 'farm-load-discovery-'));
  const copiedScript = path.join(directory, path.basename(script));
  try {
    // A real copy preserves the production filename. If discovered, its missing
    // relative imports make the child fail promptly instead of running 60s.
    await copyFile(script, copiedScript);
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'],
      { cwd: directory, encoding: 'utf8', timeout: 5000, env: cliEnvironment });
    assert.equal(result.status, 0, 'default discovery must ignore the load CLI filename');
    assert.match(result.stdout, /# tests 0\b/);
    assert.doesNotMatch(result.stdout, /schemaVersion|workloadElapsedMs/);
  } finally {
    assert.equal(path.dirname(directory), root);
    assert.equal(path.isAbsolute(directory), true);
    await unlink(copiedScript); await rmdir(directory);
  }
});
