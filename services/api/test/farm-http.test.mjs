import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

const NOW = Date.parse('2026-10-27T04:00:00Z');
const record = (ownerId, n = 1, kind = 'plot') => ({ id: `${kind}-${String(n).padStart(8, '0')}`, ownerId, kind,
  name: kind === 'plot' ? '秋季试验蔬菜' : '试验圈舍', unitLabel: `合成区 ${n}`, cycleRef: `cycle-${n}`,
  status: 'growing', startedAt: NOW - 86400000, expectedHarvestAt: null, observedAt: NOW - 1000,
  measurements: kind === 'plot' ? { areaM2: 10, moisturePercent: 42 } : { weightKg: 18, headCount: 1 } });

async function fixture(t) {
  const logs = [], app = createApp({ databasePath: ':memory:', mode: 'development', allowDevelopmentAuth: true,
    clock: () => NOW, logger: entry => logs.push(entry), requestRateLimit: { maxRequests: 10000, windowMs: 60000 } });
  const port = await listenOnFetchSafePort(app.server), base = `http://127.0.0.1:${port}/api/v1`;
  t.after(() => app.close());
  const request = async (route, token, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  };
  const login = async name => (await request('/auth/development', '', 'POST', { account: name })).json.data;
  function put(batchId, entries) {
    assert.equal(typeof app.store.importFarmBatch, 'function', 'private Store farm imports must exist');
    return app.store.importFarmBatch({ formatVersion: 1, batchId, source: 'synthetic-field', entries }, NOW);
  }
  return { app, request, login, put, logs, base };
}

test('farm records require the existing bearer session and never expose a public import endpoint', async t => {
  const f = await fixture(t), auth = await f.login('farm-http-owner');
  assert.equal((await f.request('/farm/records/plots/start')).status, 401);
  assert.equal((await f.request('/farm/record/plot-00000001/0')).status, 401);
  assert.equal((await f.request('/farm/records/plots/start', auth.token)).status, 200);
  assert.equal((await f.request('/farm/records/plots/start', auth.token, 'POST', {})).status, 405);
  assert.notEqual((await f.request('/farm/import', auth.token, 'POST', { entries: [] })).status, 200);
});

test('real HTTP pages isolate owners and kind, page exactly, and leave financial assets and capabilities unchanged', async t => {
  const f = await fixture(t), a = await f.login('farm-http-a'), b = await f.login('farm-http-b');
  const before = (await f.request('/bootstrap', a.token)).json.data;
  f.put('batch-http-pages', [
    ...Array.from({ length: 23 }, (_, i) => ({ expectedVersion: 0, record: record(a.profile.id, i + 1) })),
    { expectedVersion: 0, record: record(a.profile.id, 90, 'animal') },
    { expectedVersion: 0, record: record(b.profile.id, 91) },
  ]);
  const first = await f.request('/farm/records/plots/start', a.token);
  assert.equal(first.status, 200); assert.equal(first.json.data.items.length, 20);
  assert.equal(first.json.data.nextCursor, first.json.data.items.at(-1).id);
  assert.ok(first.json.data.items.every(r => r.ownerId === a.profile.id && r.kind === 'plot'));
  assert.match(first.headers.get('cache-control'), /no-store/);
  const second = await f.request('/farm/records/plots/' + first.json.data.nextCursor, a.token);
  assert.equal(second.status, 200); assert.equal(second.json.data.items.length, 3); assert.equal(second.json.data.nextCursor, null);
  assert.equal(new Set([...first.json.data.items, ...second.json.data.items].map(r => r.id)).size, 23);
  assert.equal((await f.request('/farm/records/animals/start', a.token)).json.data.items.length, 1);
  assert.equal((await f.request('/farm/records/plots/start', b.token)).json.data.items.length, 1);
  const after = (await f.request('/bootstrap', a.token)).json.data;
  assert.deepEqual(after, before, 'import and reads cannot change financial revision, rewards, compatibility farm or capability flags');
});

test('farm detail 404 does not distinguish another owner from missing records and history uses exclusive version cursors', async t => {
  const f = await fixture(t), a = await f.login('farm-detail-a'), b = await f.login('farm-detail-b');
  const r = record(a.profile.id);
  for (let version = 0; version < 23; version++) f.put('batch-history-' + String(version).padStart(8, '0'), [
    { expectedVersion: version, record: { ...r, observedAt: NOW - 1000 + version, measurements: { moisturePercent: version } } },
  ]);
  const first = await f.request(`/farm/record/${r.id}/0`, a.token);
  assert.equal(first.status, 200); assert.equal(first.json.data.record.version, 23);
  assert.deepEqual(first.json.data.events.map(e => e.version), Array.from({ length: 20 }, (_, i) => 23 - i));
  assert.equal(first.json.data.nextBeforeVersion, 4);
  const second = await f.request(`/farm/record/${r.id}/4`, a.token);
  assert.deepEqual(second.json.data.events.map(e => e.version), [3, 2, 1]); assert.equal(second.json.data.nextBeforeVersion, null);
  const other = await f.request(`/farm/record/${r.id}/0`, b.token), missing = await f.request('/farm/record/plot-99999999/0', b.token);
  assert.equal(other.status, 404); assert.equal(missing.status, 404);
  assert.deepEqual(other.json.error, missing.json.error);
  assert.equal(JSON.stringify(other.json).includes(a.profile.id), false);
});

test('invalid farm routes and cursors are bounded and request logs retain only templates', async t => {
  const f = await fixture(t), auth = await f.login('farm-safe-log');
  const r = record(auth.profile.id, 31415926);
  f.put('batch-safe-routing', [{ expectedVersion: 0, record: r }]);
  assert.equal((await f.request('/farm/records/plots/start', auth.token)).status, 200);
  assert.equal((await f.request(`/farm/record/${r.id}/0`, auth.token)).status, 200);
  for (const route of ['/farm/records/plots/BAD', '/farm/records/plots/%20', `/farm/record/${r.id}/-1`,
    `/farm/record/${r.id}/9007199254740992`, `/farm/record/${r.id}/01`, '/farm/record/BAD/0',
    '/farm/records/plots/start?ownerId=elsewhere']) assert.equal((await f.request(route, auth.token)).status, 400, route);
  assert.equal((await f.request(`/farm/record/${r.id}/0`, auth.token, 'POST', {})).status, 405);
  const text = JSON.stringify(f.logs);
  assert.equal(text.includes(r.id), false); assert.equal(text.includes(auth.profile.id), false); assert.equal(text.includes(auth.token), false);
  assert.ok(f.logs.some(entry => entry.route === '/api/v1/farm/record/:recordId/:beforeVersion'));
  assert.ok(f.logs.some(entry => entry.route === '/api/v1/farm/records/:kind/:cursor'));
});

test('logout removes access to previously loaded farm records', async t => {
  const f = await fixture(t), auth = await f.login('farm-logout-a');
  f.put('batch-session-stop', [{ expectedVersion: 0, record: record(auth.profile.id) }]);
  assert.equal((await f.request('/farm/records/plots/start', auth.token)).status, 200);
  assert.equal((await f.request('/auth/logout', auth.token, 'POST', {})).status, 200);
  assert.equal((await f.request('/farm/records/plots/start', auth.token)).status, 401);
  assert.equal((await f.request('/farm/record/plot-00000001/0', auth.token)).status, 401);
});
