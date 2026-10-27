import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';
import { request as httpRequest } from 'node:http';

const NOW = Date.parse('2026-10-27T04:00:00Z');
async function fixture(t, options = {}) {
  let now = NOW, counter = 0; const versions = new Map();
  const logs = [], app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true,
    clock: () => now, logger: entry => logs.push(entry), requestRateLimit: { maxRequests: 10000 }, ...options });
  const base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}/api/v1`;
  t.after(() => app.close());
  const request = async (route, token, body, key) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  };
  const login = async account => (await request('/auth/development', '', { account })).json.data;
  const view = async auth => { const result = await request('/friends', auth.token); assert.equal(result.status, 200); return result.json.data; };
  const command = async (auth, body, key = `friends-command-${++counter}`) => {
    const expectedVersion = body.expectedVersion ?? versions.get(key) ?? (await view(auth)).version;
    versions.set(key, expectedVersion); body = { ...body, expectedVersion };
    const result = await request('/friends/commands', auth.token, body, key);
    assert.equal(result.status, 200, JSON.stringify(result.json)); return result.json.data;
  };
  const enable = async auth => { assert.equal((await command(auth, { action: 'enable' })).outcome, 'applied'); return view(auth); };
  return { app, request, login, view, command, enable, logs, base, time: value => { now = value; } };
}

test('friends are opt-in, authenticated and separate from all financial state', async t => {
  const f = await fixture(t), a = await f.login('friends-first');
  assert.equal((await f.request('/friends')).status, 401);
  const before = (await f.request('/bootstrap', a.token)).json.data;
  assert.deepEqual(await f.view(a), { friendsFormat: 1, ownerId: a.profile.id, environment: 'development', serverTime: NOW,
    version: 0, available: true, enabled: false, profile: null, friends: [], incoming: [], outgoing: [], blocked: [] });
  const enabled = await f.enable(a);
  assert.match(enabled.profile.code, /^[a-f0-9]{32}$/); assert.match(enabled.profile.alias, /^农友[a-f0-9]{8}$/);
  assert.equal(enabled.version, 1);
  assert.deepEqual((await f.request('/bootstrap', a.token)).json.data, before);
  assert.equal((await f.request('/friends/commands', a.token, { action: 'enable', nickname: 'unsafe' }, 'friends-invalid')).status, 400);
  assert.equal((await f.request('/friends/commands', a.token, { action: 'enable' })).status, 400);
  assert.equal((await f.request('/friends?ownerId=another', a.token)).status, 400);
});

test('recipient-only acceptance, cross-requests and unrelated participants cannot manufacture friendships', async t => {
  const f = await fixture(t), a = await f.login('friends-request-a'), b = await f.login('friends-request-b'), c = await f.login('friends-request-c');
  const av = await f.enable(a), bv = await f.enable(b); await f.enable(c);
  assert.equal((await f.command(a, { action: 'request', code: bv.profile.code })).outcome, 'applied');
  const outgoing = (await f.view(a)).outgoing[0], incoming = (await f.view(b)).incoming[0];
  assert.equal((await f.command(a, { action: 'accept', peerId: outgoing.peerId })).code, 'REQUEST_NOT_FOUND');
  assert.equal((await f.command(c, { action: 'accept', peerId: incoming.peerId })).code, 'REQUEST_NOT_FOUND');
  assert.equal((await f.command(b, { action: 'request', code: av.profile.code })).code, 'ALREADY_PENDING');
  assert.equal((await f.view(a)).friends.length, 0);
  assert.equal((await f.command(b, { action: 'accept', peerId: incoming.peerId })).outcome, 'applied');
  assert.equal((await f.view(a)).friends.length, 1); assert.equal((await f.view(b)).friends.length, 1);
  assert.equal((await f.view(a)).version, 3); assert.equal((await f.view(b)).version, 3);
  assert.equal((await f.command(a, { action: 'request', code: av.profile.code })).code, 'PEER_UNAVAILABLE');
});

test('old request replay never revives a removed or blocked relationship, and receipts contain no peer data', async t => {
  const f = await fixture(t), a = await f.login('friends-replay-a'), b = await f.login('friends-replay-b');
  await f.enable(a); const bv = await f.enable(b), body = { action: 'request', code: bv.profile.code };
  const receipt = await f.command(a, body, 'friends-original-request');
  assert.deepEqual(Object.keys(receipt).sort(), ['friendsFormat', 'ownerId', 'environment', 'operationKey', 'action', 'outcome', 'code', 'completedAt'].sort());
  assert.equal(JSON.stringify(receipt).includes(bv.profile.code), false);
  const aPeer = (await f.view(b)).incoming[0].peerId;
  await f.command(b, { action: 'accept', peerId: aPeer }); await f.command(b, { action: 'remove', peerId: aPeer });
  assert.deepEqual(await f.command(a, body, 'friends-original-request'), receipt);
  assert.equal((await f.view(a)).outgoing.length, 0);
  await f.command(a, body); await f.command(b, { action: 'block', peerId: aPeer });
  assert.equal((await f.view(a)).outgoing.length, 0); assert.equal((await f.view(b)).blocked.length, 1);
  const unavailable = await f.command(a, body);
  assert.equal(unavailable.code, 'PEER_UNAVAILABLE');
  assert.equal((await f.command(a, { action: 'request', code: '0'.repeat(32) })).code, unavailable.code);
  await f.command(b, { action: 'unblock', peerId: aPeer });
  assert.deepEqual(await f.command(a, body, 'friends-original-request'), receipt);
  assert.equal((await f.view(a)).friends.length + (await f.view(a)).outgoing.length, 0);
  assert.equal((await f.command(a, { action: 'disable' }, 'friends-original-request')).code, 'IDEMPOTENCY_CONFLICT');
  const text = JSON.stringify(f.logs); assert.equal(text.includes(bv.profile.code), false); assert.equal(text.includes(aPeer), false);
});

test('disable rotates the code and clears both sides while daily request allowance survives re-enabling', async t => {
  const f = await fixture(t), a = await f.login('friends-limit-a'), b = await f.login('friends-limit-b');
  let av = await f.enable(a); const oldCode = av.profile.code, bv = await f.enable(b);
  for (let i = 0; i < 20; i++) {
    assert.equal((await f.command(a, { action: 'request', code: bv.profile.code })).outcome, 'applied');
    const peerId = (await f.view(a)).outgoing[0].peerId;
    await f.command(a, { action: 'cancel', peerId });
  }
  await f.command(a, { action: 'disable' }); av = await f.enable(a);
  assert.notEqual(av.profile.code, oldCode);
  assert.equal((await f.command(b, { action: 'request', code: oldCode })).code, 'PEER_UNAVAILABLE');
  assert.equal((await f.command(a, { action: 'request', code: bv.profile.code })).code, 'DAILY_REQUEST_LIMIT');
  f.time(NOW + 86400000); const auth = await f.login('friends-limit-a');
  assert.equal((await f.command(auth, { action: 'request', code: bv.profile.code })).outcome, 'applied');
});

test('production and non-sandbox identities cannot open friends', async t => {
  const f = await fixture(t, { mode: 'production', allowDevelopmentAuth: false });
  const a = f.app.store.createIdentity('weixin', 'synthetic-production-user', NOW);
  const v = await f.view(a); assert.equal(v.available, false); assert.equal(v.enabled, false);
  assert.equal((await f.command(a, { action: 'enable' })).code, 'FRIENDS_UNAVAILABLE');
});

test('a slowly completed command rechecks expiry and an expired session cannot create a social profile', async t => {
  const f = await fixture(t, { sessionTtlMs: 1000 }), a = await f.login('friends-slow-body');
  const observed = new Promise(resolve => {
    const listener = request => { if (request.url === '/api/v1/friends/commands') { f.app.server.off('request', listener); resolve(); } };
    f.app.server.on('request', listener);
  });
  let req;
  const completed = new Promise((resolve, reject) => {
    req = httpRequest(f.base + '/friends/commands', { method: 'POST', headers: { Authorization: `Bearer ${a.token}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'friend-slow-command' } }, incoming => {
      let text = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { text += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject);
  });
  req.write('{"action":"enable",'); await observed;
  f.time(NOW + 1000); req.end('"expectedVersion":0}');
  const response = await completed;
  assert.equal(response.status, 401);
  const current = await f.login('friends-slow-body');
  assert.equal((await f.view(current)).enabled, false);
});

test('decline, cancellation and disable clean both sides without exposing unrelated peer identities', async t => {
  const f = await fixture(t), a = await f.login('friends-directions-a'), b = await f.login('friends-directions-b'), c = await f.login('friends-directions-c');
  await f.enable(a); const bv = await f.enable(b); await f.enable(c);
  await f.command(a, { action: 'request', code: bv.profile.code });
  const ap = (await f.view(b)).incoming[0].peerId, bp = (await f.view(a)).outgoing[0].peerId;
  assert.equal((await f.command(b, { action: 'cancel', peerId: ap })).code, 'REQUEST_NOT_FOUND');
  assert.equal((await f.command(a, { action: 'decline', peerId: bp })).code, 'REQUEST_NOT_FOUND');
  assert.equal((await f.command(c, { action: 'remove', peerId: ap })).code, 'RELATION_NOT_FOUND');
  assert.equal((await f.command(c, { action: 'block', peerId: ap })).code, 'RELATION_NOT_FOUND');
  await f.command(b, { action: 'decline', peerId: ap });
  assert.equal((await f.view(a)).outgoing.length, 0); assert.equal((await f.view(b)).incoming.length, 0);
  await f.command(a, { action: 'request', code: bv.profile.code });
  await f.command(a, { action: 'disable' });
  assert.equal((await f.view(b)).incoming.length, 0);
  assert.deepEqual((await f.view(c)).friends, []); assert.deepEqual((await f.view(c)).incoming, []);
  const text = JSON.stringify(await f.view(c)); assert.equal(text.includes(ap), false); assert.equal(text.includes(bp), false);
});
