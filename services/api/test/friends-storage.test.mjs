import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FarmStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { createBackup, verifyBackup, restoreBackup } from '../tools/sqlite-backup.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const config = databasePath => normalizeConfig({ databasePath, mode: 'development', allowDevelopmentAuth: true, clock: () => NOW });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-friends-'));
  await mkdir(path.join(directory, 'source'));
  const databasePath = path.join(directory, 'source', 'farm.sqlite');
  let store = new FarmStore(config(databasePath)), n = 0;
  const a = store.createIdentity('development', 'friends-storage-a', store.serverNow()), b = store.createIdentity('development', 'friends-storage-b', store.serverNow());
  const command = (auth, body, key = 'friend-store-key-' + ++n) => {
    assert.equal(typeof store.friendsView, 'function');
    return store.friendCommand(auth.profile.id, key, { expectedVersion: store.friendsView(auth.profile.id, NOW).version, ...body }, NOW);
  };
  const view = auth => store.friendsView(auth.profile.id, NOW);
  const db = work => { const connection = new DatabaseSync(databasePath); try { return work(connection); } finally { connection.close(); } };
  t.after(async () => { store.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('farm-friends-')); await rm(directory, { recursive: true, force: true }); });
  return { directory, databasePath, a, b, command, view, db, get store() { return store; },
    reopen: () => { store.close(); store = new FarmStore(config(databasePath)); }, output: name => path.join(directory, name) };
}
async function rewriteManifest(directory) {
  const bytes = await readFile(path.join(directory, 'farm.sqlite')), filename = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  Object.assign(manifest, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(filename, JSON.stringify(manifest));
}
test('schema9 online backup and restore retain relations and command receipts but revoke old sessions', async t => {
  const f = await fixture(t);
  f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
  const body = { action: 'request', code: f.view(f.b).profile.code, expectedVersion: 1 };
  const receipt = f.command(f.a, body, 'original-friend-request');
  const peerId = f.view(f.b).incoming[0].peerId;
  f.command(f.b, { action: 'accept', peerId });
  const before = f.store.bootstrap(f.a.profile.id, NOW), friends = f.view(f.a);
  const backup = f.output('backup');
  assert.equal((await createBackup({ databasePath: f.databasePath, outputDirectory: backup })).schemaVersion, 9);
  await restoreBackup({ backupDirectory: backup, outputDirectory: f.output('restored') });
  const restored = new FarmStore(config(path.join(f.output('restored'), 'farm.sqlite')));
  try {
    assert.equal(restored.authenticate(f.a.token, NOW), null);
    assert.deepEqual(restored.friendsView(f.a.profile.id, NOW), friends);
    assert.deepEqual(restored.friendCommand(f.a.profile.id, 'original-friend-request', body, NOW), receipt);
    assert.deepEqual(restored.bootstrap(f.a.profile.id, NOW), before);
  } finally { restored.close(); }
  f.reopen(); assert.equal(f.view(f.a).friends.length, 1);
});

test('account deletion removes both-sided social references and an old request cannot recreate the deleted identity', async t => {
  const f = await fixture(t);
  f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
  f.command(f.a, { action: 'request', code: f.view(f.b).profile.code });
  f.command(f.b, { action: 'block', peerId: f.view(f.b).incoming[0].peerId });
  const prepared = f.store.prepareDeletion(f.a.profile.id, f.a.token, 0, NOW);
  assert.equal(f.store.confirmDeletion(prepared.data.confirmationToken, NOW).status, 200);
  assert.equal(f.view(f.b).blocked.length, 0);
  f.db(db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM friends_profiles WHERE owner_id = ?').get(f.a.profile.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM friends_commands WHERE owner_id = ?').get(f.a.profile.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM friends_blocks').get().n, 0);
  });
  const fresh = f.store.createIdentity('development', 'friends-storage-a', NOW);
  assert.notEqual(fresh.profile.id, f.a.profile.id); assert.equal(f.view(fresh).enabled, false);
});

for (const kind of ['extra-index', 'missing-index', 'cross-environment', 'unsafe-receipt', 'foreign-receipt', 'blocked-relation', 'invalid-code', 'invalid-allowance', 'relation-newer-than-profile', 'block-newer-than-profile']) {
  test(`schema9 verifier refuses ${kind} despite a recomputed backup hash`, async t => {
    const f = await fixture(t); f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
    f.command(f.a, { action: 'request', code: f.view(f.b).profile.code });
    const backup = f.output('backup'); await createBackup({ databasePath: f.databasePath, outputDirectory: backup });
    const db = new DatabaseSync(path.join(backup, 'farm.sqlite'));
    try {
      if (kind === 'extra-index') db.exec('CREATE INDEX surprise_friend_index ON friends_profiles(version)');
      if (kind === 'missing-index') db.exec('DROP INDEX friends_relations_right');
      if (kind === 'cross-environment') db.exec("UPDATE friends_profiles SET environment = 'production'");
      if (kind === 'invalid-code') db.exec("UPDATE friends_profiles SET code = 'guessable' WHERE owner_id = '" + f.a.profile.id + "'");
      if (kind === 'invalid-allowance') db.exec("UPDATE friends_profiles SET allowance_day = '2026-02-30'");
      if (kind === 'unsafe-receipt' || kind === 'foreign-receipt') {
        const row = db.prepare('SELECT rowid, result_json FROM friends_commands LIMIT 1').get(), result = JSON.parse(row.result_json);
        if (kind === 'unsafe-receipt') result.peerId = 'a'.repeat(32); else result.ownerId = f.b.profile.id;
        db.prepare('UPDATE friends_commands SET result_json = ? WHERE rowid = ?').run(JSON.stringify(result), row.rowid);
      }
      if (kind === 'blocked-relation') db.prepare('INSERT INTO friends_blocks (environment, owner_id, peer_id, created_at) VALUES (?, ?, ?, ?)').run('development', f.a.profile.id, f.b.profile.id, NOW);
      if (kind === 'relation-newer-than-profile') {
        db.exec('UPDATE friends_relations SET updated_at = updated_at + 1; UPDATE server_clock SET last_time = last_time + 1');
      }
      if (kind === 'block-newer-than-profile') {
        db.exec('DELETE FROM friends_relations; UPDATE server_clock SET last_time = last_time + 1');
        db.prepare('INSERT INTO friends_blocks (environment, owner_id, peer_id, created_at) VALUES (?, ?, ?, ?)').run('development', f.a.profile.id, f.b.profile.id, NOW + 1);
      }
    } finally { db.close(); }
    await rewriteManifest(backup);
    await assert.rejects(verifyBackup({ backupDirectory: backup }));
    await assert.rejects(restoreBackup({ backupDirectory: backup, outputDirectory: f.output('refused') }));
  });
}

test('schema5 migration preserves accounts and financial receipts; schema9 refuses future startup before changing bytes', async t => {
  const f = await fixture(t), before = f.store.bootstrap(f.a.profile.id, NOW);
  f.store.close();
  f.db(db => { db.exec('DROP TABLE IF EXISTS recovery_slots; DROP TABLE IF EXISTS planting_intents; DROP TABLE IF EXISTS recovery_epoch; DROP TABLE planting_events; DROP TABLE planting_orders; DROP TABLE planting_grants; DROP TABLE planting_plans; DROP TABLE planting_commands; DROP TABLE forum_commands; DROP TABLE forum_reports; DROP TABLE forum_content; DROP TABLE forum_usage; DROP TABLE forum_moderation; DROP TABLE friends_commands; DROP TABLE friends_blocks; DROP TABLE friends_relations; DROP TABLE friends_profiles; PRAGMA user_version = 5'); });
  f.reopen(); assert.deepEqual(f.store.bootstrap(f.a.profile.id, NOW), before);
  assert.equal(f.view(f.a).enabled, false);
  f.store.close(); f.db(db => db.exec('PRAGMA user_version = 10'));
  const bytes = await readFile(f.databasePath);
  assert.throws(() => new FarmStore(config(f.databasePath)), /schema/);
  assert.deepEqual(await readFile(f.databasePath), bytes);
});

test('a late accept from a former pending relation cannot accept a recreated request', async t => {
  const f = await fixture(t); f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
  f.command(f.a, { action: 'request', code: f.view(f.b).profile.code });
  const old = { action: 'accept', peerId: f.view(f.b).incoming[0].peerId, expectedVersion: f.view(f.b).version };
  f.command(f.a, { action: 'cancel', peerId: f.view(f.a).outgoing[0].peerId });
  f.command(f.a, { action: 'request', code: f.view(f.b).profile.code });
  assert.equal(f.command(f.b, old).code, 'FRIENDS_CHANGED');
  assert.equal(f.view(f.b).friends.length, 0); assert.equal(f.view(f.b).incoming.length, 1);
});

test('a command receipt storage failure rolls back both profiles, allowance and relation before the original retry', async t => {
  const f = await fixture(t); f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
  const beforeA = f.view(f.a), beforeB = f.view(f.b), body = { action: 'request', code: beforeB.profile.code, expectedVersion: beforeA.version };
  f.db(db => db.exec("CREATE TRIGGER fail_friend_receipt BEFORE INSERT ON friends_commands WHEN NEW.key = 'faulted-friend-command' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"));
  assert.throws(() => f.command(f.a, body, 'faulted-friend-command'));
  assert.deepEqual(f.view(f.a), beforeA); assert.deepEqual(f.view(f.b), beforeB);
  f.db(db => { assert.equal(db.prepare('SELECT allowance_count FROM friends_profiles WHERE owner_id = ?').get(f.a.profile.id).allowance_count, 0); db.exec('DROP TRIGGER fail_friend_receipt'); });
  assert.equal(f.command(f.a, body, 'faulted-friend-command').outcome, 'applied');
  assert.equal(f.view(f.a).outgoing.length, 1);
});

test('two live connections recheck independent versions before changing either participant', async t => {
  const f = await fixture(t); f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
  const second = new FarmStore(config(f.databasePath));
  try {
    const body = { action: 'request', code: f.view(f.b).profile.code, expectedVersion: 1 };
    const original = f.command(f.a, body, 'two-connection-request');
    assert.deepEqual(second.friendCommand(f.a.profile.id, 'two-connection-request', body, NOW), original);
    assert.equal(second.friendCommand(f.a.profile.id, 'two-connection-stale', { action: 'disable', expectedVersion: 1 }, NOW).code, 'FRIENDS_CHANGED');
    assert.equal(f.view(f.a).outgoing.length, 1); assert.equal(f.view(f.b).incoming.length, 1);
  } finally { second.close(); }
});

test('the bounded view enforces 200 active relations and 200 blocks without consuming rejected requester allowance', async t => {
  const f = await fixture(t); f.command(f.a, { action: 'enable' });
  const targetCode = f.view(f.a).profile.code;
  for (let i = 0; i < 200; i++) {
    const peer = f.store.createIdentity('development', 'friends-bound-' + i, NOW);
    f.command(peer, { action: 'enable' });
    assert.equal(f.command(peer, { action: 'request', code: targetCode }).outcome, 'applied');
  }
  assert.equal(f.view(f.a).incoming.length, 200);
  f.command(f.b, { action: 'enable' });
  assert.equal(f.command(f.b, { action: 'request', code: targetCode }).code, 'FRIEND_LIMIT');
  f.db(db => assert.equal(db.prepare('SELECT allowance_count FROM friends_profiles WHERE owner_id = ?').get(f.b.profile.id).allowance_count, 0));
  for (const item of f.view(f.a).incoming) assert.equal(f.command(f.a, { action: 'block', peerId: item.peerId }).outcome, 'applied');
  assert.equal(f.view(f.a).blocked.length, 200);
  assert.equal(f.command(f.b, { action: 'request', code: targetCode }).outcome, 'applied');
  assert.equal(f.command(f.a, { action: 'block', peerId: f.view(f.a).incoming[0].peerId }).code, 'BLOCK_LIMIT');
  assert.equal(f.view(f.a).incoming.length, 1); assert.equal(f.view(f.b).outgoing.length, 1);
});

test('an exhausted independent version fails atomically instead of committing an unreadable view', async t => {
  const f = await fixture(t); f.command(f.a, { action: 'enable' }); f.command(f.b, { action: 'enable' });
  f.db(db => db.prepare('UPDATE friends_profiles SET version = ? WHERE owner_id = ?').run(Number.MAX_SAFE_INTEGER, f.b.profile.id));
  const before = f.view(f.a), other = f.view(f.b);
  assert.throws(() => f.command(f.a, { action: 'request', code: other.profile.code }));
  assert.deepEqual(f.view(f.a), before); assert.deepEqual(f.view(f.b), other);
  assert.throws(() => f.command(f.b, { action: 'disable' }));
  assert.deepEqual(f.view(f.b), other);
});

for (const environment of ['development', 'production']) {
  test(`backup and replay reject an applied command falsely attributed to a non-sandbox ${environment} identity`, async t => {
    const f = await fixture(t), verified = new FarmStore(normalizeConfig({ databasePath: f.databasePath, mode: environment, clock: () => NOW }));
    try {
      const auth = verified.createIdentity('weixin', 'synthetic-non-sandbox', NOW), key = 'forged-friend-command';
      const input = { action: 'enable', expectedVersion: 0 };
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const receipt = { friendsFormat: 1, ownerId: auth.profile.id, environment, operationKey: key, action: 'enable', outcome: 'applied', code: 'OK', completedAt: NOW };
      f.db(db => db.prepare('INSERT INTO friends_commands (environment, owner_id, key, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(environment, auth.profile.id, key, fingerprint, JSON.stringify(receipt), NOW));
      await assert.rejects(createBackup({ databasePath: f.databasePath, outputDirectory: f.output('forged') }));
      assert.throws(() => verified.friendCommand(auth.profile.id, key, input, NOW));
    } finally { verified.close(); }
  });
}
