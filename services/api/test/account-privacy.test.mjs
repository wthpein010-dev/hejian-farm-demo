import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'farm-account-privacy-'));
  const file = path.join(directory, 'farm.sqlite');
  let instant = NOW, app, base;
  const start = async () => {
    app = createApp({ databasePath: file, mode: 'development', allowDevelopmentAuth: true,
      clock: () => instant, ...options });
    base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`;
  };
  await start();
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(file), directory);
    assert.equal(directory.startsWith(path.join(tmpdir(), 'farm-account-privacy-')), true);
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (route, { token, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await fetch(base + route, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text), text, headers: response.headers };
  };
  const login = async (account = 'privacy-owner') => {
    const r = await request('/auth/development', { body: { account } });
    assert.equal(r.status, 200, r.text); return r.json.data;
  };
  const prepare = (token, expectedRevision = 0) => request('/account/deletion/prepare', { token, body: { expectedRevision } });
  const preparedToken = async (token, expectedRevision = 0) => {
    const result = await prepare(token, expectedRevision);
    assert.equal(result.status, 200, result.text); return result.json.data.confirmationToken;
  };
  const confirm = confirmationToken => request('/account/deletion/confirm', { body: { confirmationToken } });
  const database = work => { const db = new DatabaseSync(file); try { return work(db); } finally { db.close(); } };
  const counts = () => database(db => Object.fromEntries(['users', 'sessions', 'idempotency', 'deletion_confirmations', 'deletion_receipts']
    .map(name => [name, db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count])));
  return { request, login, prepare, preparedToken, confirm, database, counts, file,
    setTime: value => { instant = value; }, getApp: () => app, getBase: () => base,
    restart: async () => { await app.close(); await start(); },
  };
}

async function finishBodyAfter(f, route, body, token, beforeFinish) {
  const observed = new Promise(resolve => {
    const listener = request => {
      if (request.url === '/api/v1' + route) { f.getApp().server.off('request', listener); resolve(); }
    };
    f.getApp().server.on('request', listener);
  });
  let outgoing;
  const completed = new Promise((resolve, reject) => {
    outgoing = httpRequest(f.getBase() + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject);
  });
  const serialized = JSON.stringify(body);
  outgoing.write(serialized.slice(0, -1));
  await observed; await beforeFinish(); outgoing.end('}');
  return completed;
}

test('privacy lists only the authenticated account data and rejects account selection or missing authorization', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login('privacy-neighbor');
  assert.equal((await f.request('/account/privacy')).status, 401);
  assert.equal((await f.request('/account/privacy?userId=' + b.profile.id, { token: a.token })).status, 400);
  const r = await f.request('/account/privacy', { token: a.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json.data).sort(), ['createdAt', 'dataCategories', 'deletionSupported', 'profile', 'updatedAt']);
  assert.deepEqual(r.json.data.profile, a.profile);
  assert.deepEqual([r.json.data.createdAt, r.json.data.updatedAt, r.json.data.deletionSupported], [NOW, NOW, true]);
  assert.deepEqual(r.json.data.dataCategories.map(category => category.id), ['account', 'assets', 'history', 'sessions']);
  assert.ok(r.json.data.dataCategories.every(category => typeof category.title === 'string' && category.title.length && typeof category.description === 'string' && category.description.length));
  for (const privateValue of [a.token, b.profile.id, 'identity_subject', 'token_hash', 'code_hash', 'privacy-owner']) assert.equal(r.text.includes(privateValue), false);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal((await f.request('/account/privacy', { token: b.token })).json.data.profile.id, b.profile.id);
});

test('prepare requires a recent valid session and current revision without deleting data or storing raw credentials', async t => {
  const f = await fixture(t), a = await f.login();
  const denied = await f.prepare(a.token, 1);
  assert.equal(denied.status, 409, denied.text);
  assert.deepEqual([denied.status, denied.json.error.code, denied.json.data.profile.id, denied.json.data.revision], [409, 'REVISION_CONFLICT', a.profile.id, 0]);
  for (const body of [{}, { expectedRevision: -1 }, { expectedRevision: '0' }, { expectedRevision: 0, userId: a.profile.id }]) {
    assert.equal((await f.request('/account/deletion/prepare', { token: a.token, body })).status, 400);
  }
  f.setTime(NOW + 300000);
  const ready = await f.prepare(a.token);
  assert.equal(ready.status, 200, ready.text);
  assert.match(ready.json.data.confirmationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([ready.json.data.serverTime, ready.json.data.expiresAt], [NOW + 300000, NOW + 420000]);
  const rows = f.database(db => db.prepare('SELECT * FROM deletion_confirmations').all());
  assert.equal(rows.length, 1); assert.equal(rows[0].token_hash, digest(ready.json.data.confirmationToken));
  assert.equal(JSON.stringify(rows).includes(ready.json.data.confirmationToken), false);
  assert.equal(JSON.stringify(rows).includes(a.token), false);
  assert.equal((await f.request('/bootstrap', { token: a.token })).status, 200);
  f.setTime(NOW + 300001);
  const old = await f.prepare(a.token);
  assert.deepEqual([old.status, old.json.error.code], [401, 'REAUTH_REQUIRED']);
  assert.equal(f.counts().users, 1);
});

test('successful deletion removes account-owned rows and every session, retaining only an anonymous replay receipt', async t => {
  const f = await fixture(t), a = await f.login(), second = await f.login(), neighbor = await f.login('privacy-neighbor');
  const signed = await f.request('/activities/sign-in', { token: a.token, body: { expectedRevision: 0 }, headers: { 'Idempotency-Key': 'privacy-signin-001' } });
  assert.equal(signed.status, 200);
  const neighborProof = await f.preparedToken(neighbor.token);
  const ready = await f.prepare(a.token, signed.json.data.revision);
  assert.equal(ready.status, 200, ready.text);
  const token = ready.json.data.confirmationToken;
  const finished = await f.confirm(token);
  assert.equal(finished.status, 200, finished.text);
  assert.deepEqual(finished.json.data, { deleted: true, completedAt: NOW });
  assert.deepEqual(f.counts(), { users: 1, sessions: 1, idempotency: 0, deletion_confirmations: 1, deletion_receipts: 1 });
  for (const session of [a, second]) assert.equal((await f.request('/bootstrap', { token: session.token })).status, 401);
  assert.equal((await f.request('/bootstrap', { token: neighbor.token })).status, 200);
  const receipt = f.database(db => db.prepare('SELECT * FROM deletion_receipts').get());
  assert.deepEqual({ ...receipt }, { token_hash: digest(token), completed_at: NOW });
  assert.equal(finished.text.includes(a.profile.id), false);
  assert.deepEqual((await f.confirm(token)).json.data, finished.json.data);
  assert.equal((await f.confirm(neighborProof)).status, 200);
});

test('completed confirmation survives restart and expiry and cannot delete a newly registered account of the same identity', async t => {
  const f = await fixture(t), original = await f.login();
  const token = await f.preparedToken(original.token);
  const completed = await f.confirm(token); assert.equal(completed.status, 200);
  await f.restart(); f.setTime(NOW + 600000);
  const replacement = await f.login(); assert.notEqual(replacement.profile.id, original.profile.id);
  const replay = await f.confirm(token);
  assert.equal(replay.status, 200); assert.deepEqual(replay.json.data, completed.json.data);
  assert.equal((await f.request('/bootstrap', { token: replacement.token })).status, 200);
  assert.equal(f.counts().users, 1);
});

test('another account cannot select a victim or use an unrelated or tampered confirmation', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login('privacy-neighbor');
  const token = await f.preparedToken(a.token);
  const changed = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  for (const confirmationToken of [changed, 'A'.repeat(43), a.token]) {
    const denied = await f.request('/account/deletion/confirm', { token: b.token, body: { confirmationToken } });
    assert.deepEqual([denied.status, denied.json.error.code], [410, 'DELETION_INVALID']);
    assert.equal(Object.hasOwn(denied.json, 'data'), false);
    assert.equal(denied.text.includes(a.profile.id), false);
  }
  for (const body of [{}, { confirmationToken: token, userId: a.profile.id }, { confirmationToken: a.token, expectedRevision: 0 }]) {
    assert.equal((await f.request('/account/deletion/confirm', { body })).status, 400);
  }
  assert.equal((await f.request('/bootstrap', { token: a.token })).status, 200);
  assert.equal((await f.request('/bootstrap', { token: b.token })).status, 200);
});

test('new prepare revokes its predecessor and pending confirmation expires at the two-minute boundary', async t => {
  const f = await fixture(t), a = await f.login();
  const old = await f.preparedToken(a.token);
  const current = await f.preparedToken(a.token);
  assert.notEqual(current, old);
  assert.deepEqual([(await f.confirm(old)).status, f.counts().deletion_confirmations], [410, 1]);
  f.setTime(NOW + 120000);
  const expired = await f.confirm(current);
  assert.deepEqual([expired.status, expired.json.error.code], [410, 'DELETION_EXPIRED']);
  assert.equal(Object.hasOwn(expired.json, 'data'), false);
  assert.equal((await f.request('/bootstrap', { token: a.token })).status, 200);
});

test('confirmation rejects a changed revision or invalid original session without exposing an anonymous snapshot', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login();
  const changedToken = await f.preparedToken(a.token);
  assert.equal((await f.request('/activities/sign-in', { token: b.token, body: { expectedRevision: 0 }, headers: { 'Idempotency-Key': 'privacy-change-001' } })).status, 200);
  const changed = await f.confirm(changedToken);
  assert.deepEqual([changed.status, changed.json.error.code], [409, 'DELETION_STATE_CHANGED']);
  assert.equal(Object.hasOwn(changed.json, 'data'), false);
  const loggedOutToken = await f.preparedToken(a.token, 1);
  assert.equal((await f.request('/auth/logout', { token: a.token, body: {} })).status, 200);
  const revoked = await f.confirm(loggedOutToken);
  assert.deepEqual([revoked.status, revoked.json.error.code], [401, 'REAUTH_REQUIRED']);
  assert.equal(Object.hasOwn(revoked.json, 'data'), false);
  assert.equal((await f.request('/bootstrap', { token: b.token })).status, 200);
});

test('slow prepare rechecks recent authentication and slow confirmation rechecks expiry after receiving its body', async t => {
  const f = await fixture(t), a = await f.login();
  const slowPrepare = await finishBodyAfter(f, '/account/deletion/prepare', { expectedRevision: 0 }, a.token, () => f.setTime(NOW + 300001));
  assert.deepEqual([slowPrepare.status, slowPrepare.json.error.code], [401, 'REAUTH_REQUIRED']);
  const recent = await f.login();
  const ready = await f.prepare(recent.token); assert.equal(ready.status, 200);
  const expired = await finishBodyAfter(f, '/account/deletion/confirm', { confirmationToken: ready.json.data.confirmationToken }, undefined,
    () => f.setTime(ready.json.data.expiresAt));
  assert.deepEqual([expired.status, expired.json.error.code], [410, 'DELETION_EXPIRED']);
  assert.equal(f.counts().users, 1);
});

test('a session expiring or revision changing while confirmation body arrives cannot commit deletion', async t => {
  const f = await fixture(t, { sessionTtlMs: 1000 }), a = await f.login();
  const token = await f.preparedToken(a.token);
  const expired = await finishBodyAfter(f, '/account/deletion/confirm', { confirmationToken: token }, undefined, () => f.setTime(NOW + 1000));
  assert.deepEqual([expired.status, expired.json.error.code], [401, 'REAUTH_REQUIRED']);
  const recent = await f.login(), current = await f.preparedToken(recent.token);
  const changed = await finishBodyAfter(f, '/account/deletion/confirm', { confirmationToken: current }, undefined, async () => {
    assert.equal((await f.request('/activities/sign-in', { token: recent.token, body: { expectedRevision: 0 }, headers: { 'Idempotency-Key': 'privacy-during-001' } })).status, 200);
  });
  assert.deepEqual([changed.status, changed.json.error.code], [409, 'DELETION_STATE_CHANGED']);
  assert.equal(f.counts().users, 1);
});

test('a failure during SQL deletion rolls back assets, sessions and capability, allowing the same capability to be checked later', async t => {
  const f = await fixture(t), a = await f.login();
  await f.request('/activities/sign-in', { token: a.token, body: { expectedRevision: 0 }, headers: { 'Idempotency-Key': 'privacy-atomic-001' } });
  const token = await f.preparedToken(a.token, 1);
  const before = f.counts();
  f.database(db => db.exec("CREATE TRIGGER fail_account_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'test-only fault'); END"));
  const failed = await f.confirm(token);
  assert.equal(failed.status, 500); assert.deepEqual(f.counts(), before);
  assert.equal((await f.request('/bootstrap', { token: a.token })).json.data.wallet.points, 100);
  f.database(db => db.exec('DROP TRIGGER fail_account_delete'));
  const results = await Promise.all([f.confirm(token), f.confirm(token)]);
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual(results[0].json.data, results[1].json.data);
  assert.deepEqual(f.counts(), { users: 0, sessions: 0, idempotency: 0, deletion_confirmations: 0, deletion_receipts: 1 });
});

test('pending confirmation survives a restart without persisting raw session or confirmation credentials', async t => {
  const f = await fixture(t), a = await f.login();
  const token = await f.preparedToken(a.token);
  await f.restart();
  const stored = f.database(db => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map(({ name }) => db.prepare(`SELECT * FROM ${name}`).all())));
  for (const raw of [a.token, token]) assert.equal(stored.includes(raw), false);
  assert.equal((await f.confirm(token)).status, 200);
  assert.equal((await f.request('/bootstrap', { token: a.token })).status, 401);
});

test('slow prepare rechecks a logged-out session and a concurrent revision before issuing any capability', async t => {
  const f = await fixture(t), a = await f.login();
  const revoked = await finishBodyAfter(f, '/account/deletion/prepare', { expectedRevision: 0 }, a.token, async () => {
    assert.equal((await f.request('/auth/logout', { token: a.token, body: {} })).status, 200);
  });
  assert.deepEqual([revoked.status, revoked.json.error.code], [401, 'REAUTH_REQUIRED']);
  assert.equal(f.counts().deletion_confirmations, 0);
  const recent = await f.login();
  const changed = await finishBodyAfter(f, '/account/deletion/prepare', { expectedRevision: 0 }, recent.token, async () => {
    assert.equal((await f.request('/activities/sign-in', { token: recent.token, body: { expectedRevision: 0 }, headers: { 'Idempotency-Key': 'privacy-prepare-001' } })).status, 200);
  });
  assert.deepEqual([changed.status, changed.json.error.code, changed.json.data.revision], [409, 'REVISION_CONFLICT', 1]);
  assert.equal(f.counts().deletion_confirmations, 0);
});

test('schema v2 upgrades preserve existing users, sessions and assets while adding account deletion ledgers', async t => {
  const f = await fixture(t), a = await f.login();
  await f.request('/activities/sign-in', { token: a.token, body: { expectedRevision: 0 }, headers: { 'Idempotency-Key': 'privacy-upgrade-001' } });
  await f.getApp().close();
  f.database(db => db.exec('DROP TABLE IF EXISTS deletion_confirmations; DROP TABLE IF EXISTS deletion_receipts; PRAGMA user_version = 2'));
  await f.restart();
  assert.equal((await f.request('/bootstrap', { token: a.token })).json.data.wallet.points, 100);
  assert.equal(f.database(db => db.prepare('PRAGMA user_version').get().user_version), 3);
  assert.deepEqual(f.counts(), { users: 1, sessions: 1, idempotency: 1, deletion_confirmations: 0, deletion_receipts: 0 });
  assert.equal((await f.prepare(a.token, 1)).status, 200);
});
