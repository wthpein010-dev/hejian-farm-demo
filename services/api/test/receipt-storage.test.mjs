import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { encodeReceipt } from '../src/receipt-codec.mjs';
import { createApp } from '../src/server.mjs';
import { createBackup, verifyBackup, restoreBackup } from '../tools/sqlite-backup.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

const NOW = Date.parse('2026-10-27T08:00:00Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function database(file, work) {
  const db = new DatabaseSync(file);
  try { return work(db); } finally { db.close(); }
}

async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'farm-receipt-storage-'));
  const sourceDirectory = path.join(directory, 'source');
  await mkdir(sourceDirectory, { mode: 0o700 });
  const databasePath = path.join(sourceDirectory, 'farm.sqlite');
  const running = new Set();
  t.after(async () => {
    for (const app of running) await app.close();
    assert.equal(path.isAbsolute(directory), true);
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.equal(await realpath(directory), directory);
    assert.ok(path.basename(directory).startsWith('farm-receipt-storage-'));
    await rm(directory, { recursive: true, force: false });
  });
  async function service(file = databasePath) {
    const app = createApp({ mode: 'development', allowDevelopmentAuth: true, databasePath: file, clock: () => NOW,
      requestRateLimit: { maxRequests: 10000, windowMs: 60000 } });
    running.add(app);
    const base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`;
    const request = async (route, { token, body, key } = {}) => {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      return { status: response.status, json: await response.json() };
    };
    const login = async (account = 'receipt-reviewer') => {
      const response = await request('/auth/development', { body: { account } });
      assert.equal(response.status, 200); return response.json.data;
    };
    const snapshot = async token => {
      const response = await request('/bootstrap', { token });
      assert.equal(response.status, 200); return response.json.data;
    };
    return { app, request, login, snapshot, file, close: async () => { await app.close(); running.delete(app); } };
  }
  return { directory, databasePath, service, output: name => path.join(directory, name) };
}

async function checkout(service) {
  const auth = await service.login();
  const cartBody = { sku: 'feed-pack', delta: 2, expectedRevision: 0 }, cartKey = 'receipt-storage-cart';
  const added = await service.request('/cart/items', { token: auth.token, key: cartKey, body: cartBody });
  assert.equal(added.status, 200);
  const body = { couponId: 'welcome-20', expectedRevision: 1 }, key = 'receipt-storage-checkout';
  const purchased = await service.request('/checkout', { token: auth.token, key, body });
  assert.equal(purchased.status, 200); assert.equal(purchased.json.replayed, false);
  assert.deepEqual([purchased.json.data.wallet.points, purchased.json.data.wallet.feed, purchased.json.data.revision], [40, 12, 2]);
  return { auth, key, body, original: purchased.json.data, cartKey, cartBody, cartSnapshot: added.json.data };
}

const stored = (file, owner, key) => database(file,
  db => db.prepare('SELECT success_json FROM idempotency WHERE user_id = ? AND key = ?').get(owner, key).success_json);
const version = file => database(file, db => db.prepare('PRAGMA user_version').get().user_version);

for (const schema of [2, 3]) {
  test(`legacy schema${schema} cannot claim to contain a versioned compact receipt`, async t => {
    const f = await fixture(t), source = await f.service(); await checkout(source); await source.close();
    database(f.databasePath, db => {
      if (schema === 2) db.exec('DROP TABLE deletion_confirmations; DROP TABLE deletion_receipts');
      db.exec(`PRAGMA user_version = ${schema}`);
    });
    await assert.rejects(createBackup({ databasePath: f.databasePath, outputDirectory: f.output('incorrect-version') }), refusedReceipt);
  });
}

for (const encoding of ['raw', 'compact']) {
  test(`a valid ${encoding} foreign-account receipt cannot escape through replay or backup`, async t => {
    const f = await fixture(t), source = await f.service(), scenario = await checkout(source);
    const other = await source.login('other-receipt-account'), foreign = await source.snapshot(other.token);
    const text = encoding === 'raw' ? JSON.stringify(foreign) : encodeReceipt(foreign);
    database(f.databasePath, db => db.prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ? AND key = ?')
      .run(text, scenario.auth.profile.id, scenario.key));
    const replay = await source.request('/checkout', { token: scenario.auth.token, key: scenario.key, body: scenario.body });
    assert.equal(replay.status, 500);
    assert.ok(!JSON.stringify(replay.json).includes(other.profile.id));
    assert.deepEqual(await source.snapshot(scenario.auth.token), scenario.original);
    await assert.rejects(createBackup({ databasePath: f.databasePath, outputDirectory: f.output('foreign-owner') }), refusedReceipt);
  });
}
const compact = (text, original) => {
  assert.equal(JSON.parse(text).receiptEncoding, 'deflate-raw-v1', 'new ordinary snapshots use the versioned lossless encoding');
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(original)), 'the persisted receipt is actually smaller');
};
const refusedReceipt = failure => ['INVALID_APPLICATION_RECEIPT', 'INVALID_APPLICATION_DATA'].includes(failure?.code);

test('schema4 compact receipts still replay the original result after later writes and a real service restart', async t => {
  const f = await fixture(t), first = await f.service(), scenario = await checkout(first);
  const { auth, key, body, original } = scenario;
  assert.equal(version(f.databasePath), 4);
  compact(stored(f.databasePath, auth.profile.id, key), original);
  const changed = await first.request('/activities/sign-in', { token: auth.token, key: 'receipt-storage-later-signin', body: { expectedRevision: 2 } });
  assert.equal(changed.status, 200); assert.equal(changed.json.data.wallet.points, 60);
  await first.close();
  const reopened = await f.service(), nextLogin = await reopened.login();
  assert.equal(nextLogin.profile.id, auth.profile.id);
  const replay = await reopened.request('/checkout', { token: nextLogin.token, key, body });
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  assert.deepEqual(replay.json.data, original, 'replay returns the historical revision, not the latest snapshot');
  const current = await reopened.snapshot(nextLogin.token);
  assert.deepEqual([current.wallet.points, current.wallet.feed, current.revision, current.system.purchases.length], [60, 12, 3, 1]);
  const conflict = await reopened.request('/checkout', { token: nextLogin.token, key, body: { expectedRevision: 3 } });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await reopened.snapshot(nextLogin.token), current);
});

test('a canonical schema3 raw-receipt fixture upgrades without rewriting old receipts, assets or code claims', async t => {
  const f = await fixture(t), initial = await f.service(), scenario = await checkout(initial);
  await initial.close();
  const rawCart = JSON.stringify(scenario.cartSnapshot), rawCheckout = JSON.stringify(scenario.original);
  // The SQL layout is unchanged. Explicit raw JSON plus user_version=3 recreates
  // the persisted representation accepted by the previous service generation.
  const before = database(f.databasePath, db => {
    db.prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ? AND key = ?').run(rawCart, scenario.auth.profile.id, scenario.cartKey);
    db.prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ? AND key = ?').run(rawCheckout, scenario.auth.profile.id, scenario.key);
    db.prepare('INSERT INTO code_claims VALUES (?, ?, ?, ?, ?)').run('c'.repeat(64), 'weixin', 'used', NOW, NOW);
    db.exec('PRAGMA user_version = 3');
    return { user: db.prepare('SELECT * FROM users').get(), claims: db.prepare('SELECT * FROM code_claims').all() };
  });
  const upgraded = await f.service();
  assert.equal(version(f.databasePath), 4);
  assert.deepEqual(database(f.databasePath, db => ({ user: db.prepare('SELECT * FROM users').get(),
    claims: db.prepare('SELECT * FROM code_claims').all() })), before);
  assert.equal(stored(f.databasePath, scenario.auth.profile.id, scenario.cartKey), rawCart);
  assert.equal(stored(f.databasePath, scenario.auth.profile.id, scenario.key), rawCheckout);
  const replay = await upgraded.request('/checkout', { token: scenario.auth.token, key: scenario.key, body: scenario.body });
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.data, scenario.original);
  const added = await upgraded.request('/activities/sign-in', { token: scenario.auth.token, key: 'receipt-storage-new-after-upgrade', body: { expectedRevision: 2 } });
  assert.equal(added.status, 200);
  compact(stored(f.databasePath, scenario.auth.profile.id, 'receipt-storage-new-after-upgrade'), added.json.data);
  assert.equal(stored(f.databasePath, scenario.auth.profile.id, scenario.key), rawCheckout, 'reading an old result does not silently rewrite it');
});

test('schema4 backup and isolated restore preserve mixed raw/compact history while revoking sessions and deletion confirmations', async t => {
  const f = await fixture(t), source = await f.service(), scenario = await checkout(source);
  const rawCart = JSON.stringify(scenario.cartSnapshot);
  database(f.databasePath, db => {
    db.prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ? AND key = ?').run(rawCart, scenario.auth.profile.id, scenario.cartKey);
    db.prepare('INSERT INTO deletion_receipts VALUES (?, ?)').run('d'.repeat(64), NOW);
  });
  const compressedCheckout = stored(f.databasePath, scenario.auth.profile.id, scenario.key);
  compact(compressedCheckout, scenario.original);
  assert.equal((await source.request('/account/deletion/prepare', { token: scenario.auth.token, body: { expectedRevision: 2 } })).status, 200);
  const backupDirectory = f.output('mixed-backup'), outputDirectory = f.output('mixed-restored');
  const backup = await createBackup({ databasePath: f.databasePath, outputDirectory: backupDirectory });
  assert.equal(backup.schemaVersion, 4);
  assert.equal((await verifyBackup({ backupDirectory })).schemaVersion, 4);
  const originalBackupBytes = await readFile(path.join(backupDirectory, 'farm.sqlite'));
  const report = await restoreBackup({ backupDirectory, outputDirectory });
  assert.equal(report.sessionsInvalidated, true);
  const recoveredFile = path.join(outputDirectory, 'farm.sqlite');
  const counts = database(recoveredFile, db => ({ sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    proposals: db.prepare('SELECT COUNT(*) AS n FROM deletion_confirmations').get().n,
    receipts: db.prepare('SELECT COUNT(*) AS n FROM deletion_receipts').get().n }));
  assert.deepEqual(counts, { sessions: 0, proposals: 0, receipts: 1 });
  assert.equal(stored(recoveredFile, scenario.auth.profile.id, scenario.cartKey), rawCart);
  assert.equal(stored(recoveredFile, scenario.auth.profile.id, scenario.key), compressedCheckout);
  assert.deepEqual(await readFile(path.join(backupDirectory, 'farm.sqlite')), originalBackupBytes);
  const recovered = await f.service(recoveredFile);
  assert.equal((await recovered.request('/bootstrap', { token: scenario.auth.token })).status, 401);
  const newSession = await recovered.login(); assert.equal(newSession.profile.id, scenario.auth.profile.id);
  for (const [route, key, body, original] of [['/cart/items', scenario.cartKey, scenario.cartBody, scenario.cartSnapshot],
    ['/checkout', scenario.key, scenario.body, scenario.original]]) {
    const replay = await recovered.request(route, { token: newSession.token, key, body });
    assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.data, original);
  }
  assert.deepEqual(await recovered.snapshot(newSession.token), scenario.original);
});

for (const corruption of ['unknown-format', 'wrong-checksum', 'truncated-payload']) {
  test(`invalid encoded history is rejected by HTTP replay and verified backup restore: ${corruption}`, async t => {
    const f = await fixture(t), source = await f.service(), scenario = await checkout(source);
    const backupDirectory = f.output('valid-backup');
    await createBackup({ databasePath: f.databasePath, outputDirectory: backupDirectory });
    const raw = Buffer.from(JSON.stringify(scenario.original));
    const envelope = { receiptEncoding: 'deflate-raw-v1', utf8Bytes: raw.length, sha256: hash(raw),
      payload: deflateRawSync(raw, { level: 1 }).toString('base64') };
    if (corruption === 'unknown-format') envelope.receiptEncoding = 'unrecognized-receipt-v999';
    if (corruption === 'wrong-checksum') envelope.sha256 = '0'.repeat(64);
    if (corruption === 'truncated-payload') envelope.payload = envelope.payload.slice(0, -4);
    const damaged = JSON.stringify(envelope);
    const overwrite = file => database(file, db => db.prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ? AND key = ?')
      .run(damaged, scenario.auth.profile.id, scenario.key));
    overwrite(f.databasePath);
    const replay = await source.request('/checkout', { token: scenario.auth.token, key: scenario.key, body: scenario.body });
    assert.equal(replay.status, 500, 'invalid storage is not returned as a successful replay');
    assert.equal(replay.json.error.code, 'INTERNAL_ERROR');
    assert.deepEqual(await source.snapshot(scenario.auth.token), scenario.original);
    await assert.rejects(createBackup({ databasePath: f.databasePath, outputDirectory: f.output('refused-source-backup') }), refusedReceipt);
    overwrite(path.join(backupDirectory, 'farm.sqlite'));
    const bytes = await readFile(path.join(backupDirectory, 'farm.sqlite'));
    const manifestPath = path.join(backupDirectory, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.bytes = bytes.length; manifest.sha256 = hash(bytes);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyBackup({ backupDirectory }), refusedReceipt);
    await assert.rejects(restoreBackup({ backupDirectory, outputDirectory: f.output('refused-restore') }), refusedReceipt);
  });
}

test('a receipt persistence failure rolls back the debit, coupon, resources and new operation key before retry', async t => {
  const f = await fixture(t), source = await f.service(), auth = await source.login();
  const added = await source.request('/cart/items', { token: auth.token, key: 'receipt-storage-rollback-cart',
    body: { sku: 'feed-pack', delta: 2, expectedRevision: 0 } });
  assert.equal(added.status, 200);
  const before = await source.snapshot(auth.token), key = 'receipt-storage-write-failure', body = { couponId: 'welcome-20', expectedRevision: 1 };
  database(f.databasePath, db => db.exec(`CREATE TRIGGER receipt_write_failure BEFORE UPDATE OF success_json ON idempotency
    WHEN NEW.key = 'receipt-storage-write-failure' BEGIN SELECT RAISE(ABORT, 'isolated receipt write failure'); END`));
  assert.equal((await source.request('/checkout', { token: auth.token, key, body })).status, 500);
  assert.deepEqual(await source.snapshot(auth.token), before);
  assert.equal(database(f.databasePath, db => db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE user_id = ? AND key = ?')
    .get(auth.profile.id, key).n), 0);
  database(f.databasePath, db => db.exec('DROP TRIGGER receipt_write_failure'));
  const completed = await source.request('/checkout', { token: auth.token, key, body });
  assert.equal(completed.status, 200); assert.equal(completed.json.replayed, false);
  compact(stored(f.databasePath, auth.profile.id, key), completed.json.data);
  const replay = await source.request('/checkout', { token: auth.token, key, body });
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.data, completed.json.data);
  assert.deepEqual([completed.json.data.wallet.points, completed.json.data.wallet.feed, completed.json.data.system.purchases.length], [40, 12, 1]);
});
