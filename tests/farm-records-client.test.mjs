import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import test from 'node:test';
import { syntheticSession } from './helpers/session-fixture.mjs';
import assert from 'node:assert/strict';
import { createFarmClient as actualCreateFarmClient } from '../apps/mobile/src/core/client.mjs';
const createFarmClient = options => actualCreateFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport) });
import * as farmClient from '../apps/mobile/src/core/client.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';
import * as navigation from '../apps/mobile/src/core/navigation.mjs';

const now = 1793044800000;
const ok = data => ({ status: 200, data: { data } });
function record(id = 'record-0001', overrides = {}) {
  return { id, ownerId: 'member-a', environment: 'development', kind: 'plot', name: '白菜', unitLabel: '东田一号',
    cycleRef: 'cycle-2026', status: 'growing', startedAt: now - 10000, expectedHarvestAt: null,
    observedAt: now - 1000, measurements: { areaM2: 12, moisturePercent: 32 }, version: 1,
    createdAt: now - 1000, updatedAt: now - 1000, ...overrides };
}
const page = (overrides = {}) => ({ recordFormat: 1, ownerId: 'member-a', environment: 'development', kind: 'plots', items: [record()], nextCursor: null, serverTime: now, ...overrides });
function detail(overrides = {}) {
  const current = record();
  return { recordFormat: 1, ownerId: 'member-a', environment: 'development', record: current,
    events: [{ version: current.version, recordedAt: current.updatedAt, source: 'farm-source', record: current }], nextBeforeVersion: null, serverTime: now, ...overrides };
}
function harness() {
  const calls = [], replies = [];
  const client = createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => 'fixed-operation-123', transport: async request => {
    calls.push(structuredClone(request));
    const reply = replies.shift(); assert.ok(reply, 'explicit response required');
    if (reply instanceof Error) throw reply;
    return reply;
  } });
  return { client, calls, replies };
}
async function login(h, id = 'member-a', environment = 'development') {
  h.replies.push(ok(syntheticSession({ environment: 'development', token: `token-${id}`, profile: { id, displayName: '合成测试账户' } })));
  await h.client.loginDevelopment('synthetic-account');
  h.replies.push(ok(mobileSnapshot({ profile: { id }, environment })));
  await h.client.load();
}
function evaluateTypeScript(source, imports, globals = {}, exposed = '') {
  const code = ts.transpile(source.replaceAll('import.meta.env', '__testEnv') + exposed, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  const exports = {};
  return new Function('require', 'exports', '__testEnv', ...Object.keys(globals), `${code}\nreturn exports;`)(
    name => { if (name === '../core/navigation.mjs') return navigation; assert.ok(imports[name], `explicit import ${name}`); return imports[name]; }, exports,
    { VITE_API_BASE_URL: 'http://127.0.0.1:8787', DEV: true }, ...Object.values(globals));
}
async function coreHarness(h, globals = {}) {
  const source = await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8');
  return evaluateTypeScript(source, { vue, './client.mjs': { ...farmClient, createFarmClient: () => h.client }, './navigation.mjs': navigation }, globals);
}
function historyPage(version, eventVersions, nextBeforeVersion = null) {
  const current = record('record-0001', { version });
  return detail({ record: current, events: eventVersions.map(v => ({ version: v, recordedAt: current.updatedAt, source: 'farm-source', record: { ...current, version: v } })), nextBeforeVersion });
}

test('farm reads require a confirmed account environment and send only the fixed read route', async () => {
  const h = harness();
  h.replies.push(ok(syntheticSession({ environment: 'development', token: 'private-token', profile: { id: 'member-a' } }))); await h.client.loginDevelopment('synthetic');
  await assert.rejects(() => h.client.loadFarmPage('plots'), { code: 'SNAPSHOT_REQUIRED' });
  h.replies.push(ok(mobileSnapshot())); await h.client.load();
  h.replies.push(ok(page())); assert.deepEqual(await h.client.loadFarmPage('plots'), page());
  h.replies.push(ok(detail())); assert.deepEqual(await h.client.loadFarmDetail('record-0001'), detail());
  assert.equal(h.calls[2].url, 'http://127.0.0.1:8787/api/v1/farm/records/plots/start');
  assert.equal(h.calls[3].url, 'http://127.0.0.1:8787/api/v1/farm/record/record-0001/0');
  assert.equal(h.calls[2].method, 'GET'); assert.equal(h.calls[2].body, undefined);
  assert.equal(h.calls[2].headers.Authorization, 'Bearer ' + syntheticSession({ token: 'private-token', profile: { id: 'member-a' } }).token);
});

for (const [name, change] of [
  ['owner', p => { p.ownerId = 'member-b'; }], ['nested owner', p => { p.items[0].ownerId = 'member-b'; }],
  ['environment', p => { p.environment = 'production'; p.items[0].environment = 'production'; }],
  ['kind', p => { p.kind = 'animals'; }], ['unknown field', p => { p.customerAddress = 'must not render'; }],
  ['unknown measurement', p => { p.items[0].measurements.email = 'must not render'; }],
  ['invalid date', p => { p.items[0].observedAt = now + 1; }], ['bad cursor', p => { p.nextCursor = 'record-9999'; }],
  ['duplicate ids', p => { p.items.push(structuredClone(p.items[0])); }],
]) test(`farm page rejects strict ${name} corruption without replacing the last valid page`, async () => {
  const h = harness(); await login(h); h.replies.push(ok(page())); await h.client.loadFarmPage('plots');
  const corrupt = page(); change(corrupt); h.replies.push(ok(corrupt));
  await assert.rejects(() => h.client.loadFarmPage('plots'), { code: 'SERVER_UNAVAILABLE' });
  assert.deepEqual(h.client.farmPage, page()); assert.equal(h.client.hasPending(), false);
});

for (const [name, change] of [
  ['foreign record', d => { d.record.id = 'record-0002'; }],
  ['foreign event', d => { d.events[0].record = record('record-0002'); }],
  ['event version', d => { d.events[0].version = 2; }],
  ['event timestamp', d => { d.events[0].recordedAt = now; }],
  ['unknown field', d => { d.events[0].privateNote = 'hidden'; }],
  ['wrong environment', d => { d.environment = 'production'; }],
]) test(`farm detail rejects strict ${name} corruption`, async () => {
  const h = harness(); await login(h); const corrupt = detail(); change(corrupt); h.replies.push(ok(corrupt));
  await assert.rejects(() => h.client.loadFarmDetail('record-0001'), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.farmDetail, null);
});

test('page reads validate requested cursor boundaries rather than accepting a repeated or preceding page', async () => {
  const h = harness(); await login(h);
  h.replies.push(ok(page({ nextCursor: 'record-0001' }))); await h.client.loadFarmPage('plots');
  h.replies.push(ok(page())); await assert.rejects(() => h.client.loadFarmPage('plots', 'record-0001'), { code: 'SERVER_UNAVAILABLE' });
  h.replies.push(ok(page({ items: [record('record-0002')] }))); await h.client.loadFarmPage('plots', 'record-0001');
  assert.equal(h.client.farmPage.items[0].id, 'record-0002');
  assert.equal(h.calls.at(-1).url.endsWith('/plots/record-0001'), true);
});
test('history reads validate the exclusive beforeVersion boundary', async () => {
  const h = harness(); await login(h); h.replies.push(ok(detail()));
  await assert.rejects(() => h.client.loadFarmDetail('record-0001', 1), { code: 'SERVER_UNAVAILABLE' });
  h.replies.push(ok(detail())); await h.client.loadFarmDetail('record-0001', 2);
  assert.equal(h.calls.at(-1).url.endsWith('/record-0001/2'), true);
});
test('invalid farm arguments do not enter transport', async () => {
  const h = harness(); await login(h);
  for (const args of [['wrong'], ['plots', '../private'], ['animals', null]]) await assert.rejects(() => h.client.loadFarmPage(...args), { code: 'INVALID_REQUEST' });
  for (const args of [['../private'], ['record-0001', -1], ['record-0001', 1.5], ['record-0001', Number.MAX_SAFE_INTEGER + 1]]) await assert.rejects(() => h.client.loadFarmDetail(...args), { code: 'INVALID_REQUEST' });
  assert.equal(h.calls.length, 2);
});
test('a newer same-account page read wins even when a valid older response arrives last', async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loadFarmPage('plots');
  h.replies.push(ok(page({ items: [record('record-0002')] }))); await h.client.loadFarmPage('plots');
  finish(ok(page())); await assert.rejects(() => old, { code: 'READ_SUPERSEDED' });
  assert.equal(h.client.farmPage.items[0].id, 'record-0002');
});
test('a classification change supersedes an older classification read', async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loadFarmPage('plots');
  h.replies.push(ok(page({ kind: 'animals', items: [] }))); await h.client.loadFarmPage('animals');
  finish(ok(page())); await assert.rejects(() => old, { code: 'READ_SUPERSEDED' });
  assert.equal(h.client.farmPage.kind, 'animals');
});
test('detail reads have their own sequence and cannot replace a newer selected object', async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loadFarmDetail('record-0001');
  const current = record('record-0002'); h.replies.push(ok(detail({ record: current, events: [{ version: 1, recordedAt: current.updatedAt, source: 'farm-source', record: current }] })));
  await h.client.loadFarmDetail('record-0002');
  h.replies.push(ok(page())); await h.client.loadFarmPage('plots');
  finish(ok(detail())); await assert.rejects(() => old, { code: 'READ_SUPERSEDED' });
  assert.equal(h.client.farmDetail.record.id, 'record-0002'); assert.ok(h.client.farmPage);
});
test('login, logout, and current-session 401 clear both private caches', async () => {
  const h = harness(); await login(h);
  async function populate() { h.replies.push(ok(page())); await h.client.loadFarmPage('plots'); h.replies.push(ok(detail())); await h.client.loadFarmDetail('record-0001'); }
  await populate(); await login(h); assert.equal(h.client.farmPage, null); assert.equal(h.client.farmDetail, null);
  await populate(); h.replies.push({ status: 401, data: { error: { code: 'SESSION_EXPIRED' } } });
  await assert.rejects(() => h.client.loadFarmPage('plots'), { code: 'SESSION_EXPIRED' });
  assert.equal(h.client.farmPage, null); assert.equal(h.client.farmDetail, null); assert.equal(h.client.authenticated, false);
  await login(h); await populate(); h.replies.push(ok({})); await h.client.logout();
  assert.equal(h.client.farmPage, null); assert.equal(h.client.farmDetail, null);
});
for (const status of [200, 401]) test(`an old account farm ${status} response cannot affect a newly logged-in account`, async () => {
  const h = harness(); await login(h); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.client.loadFarmPage('plots');
  await login(h, 'member-b');
  finish(status === 200 ? ok(page()) : { status, data: { error: { code: 'SESSION_EXPIRED' } } });
  await assert.rejects(() => old, { code: 'SESSION_CHANGED' });
  assert.equal(h.client.profile.id, 'member-b'); assert.equal(h.client.authenticated, true); assert.equal(h.client.farmPage, null);
});
test('farm read errors do not discard an uncertain financial operation or its exact key', async () => {
  const h = harness(); await login(h); h.replies.push(new Error('lost checkout'));
  await assert.rejects(() => h.client.mutate('/checkout'), { code: 'RESULT_UNKNOWN' });
  h.replies.push(ok(page({ ownerId: 'member-b' }))); await assert.rejects(() => h.client.loadFarmPage('plots'), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(h.client.hasPending(), true); await assert.rejects(() => h.client.logout(), { code: 'PENDING_OPERATION' });
  h.replies.push(ok(mobileSnapshot({ revision: 4 }))); await h.client.retryPending();
  assert.deepEqual(h.calls[2], h.calls[4]);
});

test('display pagination preserves every item and uses only the response nextCursor', () => {
  assert.equal(typeof farmClient.mergeFarmPages, 'function');
  let merged = farmClient.mergeFarmPages(null, page({ nextCursor: 'record-0001' }), 'start');
  const next = page({ items: [record('record-0002'), record('record-0003')], nextCursor: 'record-0003' });
  merged = farmClient.mergeFarmPages(merged, next, 'record-0001');
  assert.deepEqual(merged.items.map(r => r.id), ['record-0001', 'record-0002', 'record-0003']);
  assert.equal(merged.nextCursor, next.nextCursor);
  assert.throws(() => farmClient.mergeFarmPages(merged, next, 'record-0001'), { code: 'READ_SUPERSEDED' });
  const refreshed = farmClient.mergeFarmPages(merged, page({ items: [] }), 'start');
  assert.deepEqual(refreshed.items, []); assert.equal(refreshed.nextCursor, null);
});
test('display history pagination retains all versions and stops at the response nextBeforeVersion', () => {
  assert.equal(typeof farmClient.mergeFarmDetails, 'function');
  const current = record('record-0001', { version: 3 });
  const event = version => ({ version, recordedAt: current.updatedAt, source: 'farm-source', record: { ...current, version } });
  let merged = farmClient.mergeFarmDetails(null, detail({ record: current, events: [event(3), event(2)], nextBeforeVersion: 2 }), 0);
  merged = farmClient.mergeFarmDetails(merged, detail({ record: current, events: [event(1)], nextBeforeVersion: null }), 2);
  assert.deepEqual(merged.events.map(e => e.version), [3, 2, 1]); assert.equal(merged.nextBeforeVersion, null);
  assert.throws(() => farmClient.mergeFarmDetails(merged, detail(), 2), { code: 'READ_SUPERSEDED' });
});

test('a changed current version cannot produce an apparently complete history with the new event missing', async () => {
  const h = harness(); await login(h);
  h.replies.push(ok(historyPage(3, [3, 2], 2))); const first = await h.client.loadFarmDetail('record-0001');
  h.replies.push(ok(historyPage(4, [1]))); const next = await h.client.loadFarmDetail('record-0001', 2);
  assert.throws(() => farmClient.mergeFarmDetails(first, next, 2), { code: 'FARM_RECORD_CHANGED' });
  assert.equal(first.record.version, 3); assert.deepEqual(first.events.map(e => e.version), [3, 2]);
});
test('core refreshes the latest history page exactly once when a continuation observes a new version', async () => {
  const h = harness(); await login(h); const core = await coreHarness(h);
  h.replies.push(ok(historyPage(3, [3, 2], 2))); assert.equal(await core.loadFarmRecord('record-0001'), true);
  h.replies.push(ok(historyPage(4, [1])), ok(historyPage(4, [4, 3], 3)));
  assert.equal(await core.loadFarmRecord('record-0001', 2), true);
  assert.equal(core.farmState.farmRegistryDetail.record.version, 4);
  assert.deepEqual(Array.from(core.farmState.farmRegistryDetail.events, e => e.version), [4, 3]);
  assert.equal(core.farmState.farmRegistryDetail.nextBeforeVersion, 3);
  assert.deepEqual(h.calls.filter(c => c.url.includes('/farm/record/')).map(c => c.url.split('/').at(-1)), ['0', '2', '0']);
  assert.match(core.farmState.farmRecordMessage, /已刷新/);
});
test('a failed automatic history refresh preserves the previous consistent view and retries only on a new user request', async () => {
  const h = harness(); await login(h); const core = await coreHarness(h);
  h.replies.push(ok(historyPage(3, [3, 2], 2))); await core.loadFarmRecord('record-0001');
  h.replies.push(ok(historyPage(4, [1])), new Error('refresh unavailable'));
  assert.equal(await core.loadFarmRecord('record-0001', 2), false);
  assert.equal(core.farmState.farmRegistryDetail.record.version, 3);
  assert.equal(core.farmState.farmRegistryDetail.nextBeforeVersion, 2);
  assert.equal(h.calls.filter(c => c.url.includes('/farm/record/')).length, 3);
  assert.match(core.farmState.farmRecordError, /刷新|网络|连接/);
});
test('a new selected object cannot be replaced by a late automatic history refresh', async () => {
  const h = harness(); await login(h); const core = await coreHarness(h); let finishRefresh;
  h.replies.push(ok(historyPage(3, [3, 2], 2))); await core.loadFarmRecord('record-0001');
  h.replies.push(ok(historyPage(4, [1])), new Promise(resolve => { finishRefresh = resolve; }));
  const old = core.loadFarmRecord('record-0001', 2); await new Promise(resolve => setImmediate(resolve));
  const selected = record('record-0002'); h.replies.push(ok(detail({ record: selected, events: [{ version: 1, recordedAt: selected.updatedAt, source: 'farm-source', record: selected }] })));
  assert.equal(await core.loadFarmRecord('record-0002'), true);
  finishRefresh(ok(historyPage(4, [4, 3], 3))); assert.equal(await old, false);
  assert.equal(core.farmState.farmRegistryDetail.record.id, 'record-0002'); assert.equal(core.farmState.farmRecordError, '');
});
test('an automatic history refresh 401 clears account data instead of retaining the old view', async () => {
  const h = harness(); await login(h); const core = await coreHarness(h);
  h.replies.push(ok(historyPage(3, [3, 2], 2))); await core.loadFarmRecord('record-0001');
  h.replies.push(ok(historyPage(4, [1])), { status: 401, data: { error: { code: 'SESSION_EXPIRED', message: '会话已过期' } } });
  assert.equal(await core.loadFarmRecord('record-0001', 2), false);
  assert.equal(core.farmState.authenticated, false); assert.equal(core.farmState.farmRegistryDetail, null);
  assert.equal(core.farmState.snapshot, null); assert.equal(h.client.farmDetail, null);
});
test('a different account cannot receive an old automatic history refresh or its error', async () => {
  const h = harness(); await login(h); const core = await coreHarness(h); let finishRefresh;
  h.replies.push(ok(historyPage(3, [3, 2], 2))); await core.loadFarmRecord('record-0001');
  h.replies.push(ok(historyPage(4, [1])), new Promise(resolve => { finishRefresh = resolve; }));
  const old = core.loadFarmRecord('record-0001', 2); await new Promise(resolve => setImmediate(resolve));
  await login(h, 'member-b'); h.replies.push(ok(page({ ownerId: 'member-b', items: [] })));
  assert.equal(await core.loadFarmRegistry('plots'), true);
  finishRefresh({ status: 401, data: { error: { code: 'SESSION_EXPIRED' } } }); assert.equal(await old, false);
  assert.equal(core.farmState.authenticated, true); assert.equal(core.farmState.snapshot.profile.id, 'member-b');
  assert.equal(core.farmState.farmRegistryDetail, null); assert.equal(core.farmState.farmRecordError, '');
});
for (const type of ['page', 'detail']) test(`an obsolete ${type} bootstrap does not dispatch a farm read that cancels the newer wrapper`, async () => {
  const h = harness(); h.replies.push(ok(syntheticSession({ environment: 'development', token: 'token-member-a', profile: { id: 'member-a' } }))); await h.client.loginDevelopment('synthetic');
  const core = await coreHarness(h); let finishOldBootstrap, finishNewBootstrap, finishRead;
  h.replies.push(new Promise(resolve => { finishOldBootstrap = resolve; }), new Promise(resolve => { finishNewBootstrap = resolve; }), new Promise(resolve => { finishRead = resolve; }));
  const read = () => type === 'page' ? core.loadFarmRegistry('plots') : core.loadFarmRecord('record-0001');
  const old = read(), current = read();
  finishNewBootstrap(ok(mobileSnapshot())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(c => c.url.includes('/farm/')).length, 1);
  finishOldBootstrap(ok(mobileSnapshot())); assert.equal(await old, false);
  assert.equal(h.calls.filter(c => c.url.includes('/farm/')).length, 1, 'obsolete wrapper never sends a second farm read');
  finishRead(ok(type === 'page' ? page() : detail())); assert.equal(await current, true);
  assert.ok(type === 'page' ? core.farmState.farmRegistryPage : core.farmState.farmRegistryDetail);
});
test('returning to the farm preserves the loaded classification and all 23 items until explicit refresh', async () => {
  const source = (await readFile(new URL('../apps/mobile/src/pages/farm/index.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const items = Array.from({ length: 23 }, (_, i) => record(`record-${String(i + 1).padStart(4, '0')}`, { kind: 'animal', measurements: { headCount: 1 } }));
  const state = vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), farmRegistryPage: page({ kind: 'animals', items }) }), loads = [], shows = [];
  const component = evaluateTypeScript(source, { vue, '@dcloudio/uni-app': { onShow: fn => shows.push(fn) }, '../../core/farm': {
    farmState: state, onFarmPageShow() {}, loadFarmRegistry: (...args) => loads.push(args)
  } }, {}, '\nexports.pageTest = { area, load, selectArea };');
  assert.equal(component.pageTest.area.value, 'animals');
  shows[0](); assert.equal(loads.length, 0); assert.equal(state.farmRegistryPage.items.length, 23);
  component.pageTest.selectArea('animals'); assert.equal(loads.length, 0, 'reselecting the current classification preserves the loaded page and scroll context');
  component.pageTest.load(); assert.deepEqual(loads, [['animals', 'start']]);
  state.farmRegistryPage = null; shows[0](); assert.equal(loads.length, 2);
});
test('detail return uses the existing page stack and a direct URL falls back to the farm tab', async () => {
  const h = harness(), actions = []; let pages = [{ route: 'pages/farm/index' }, { route: 'pages/farm-record/index' }];
  const core = await coreHarness(h, { getCurrentPages: () => pages, uni: { navigateBack: options => actions.push(['back', options]), switchTab: options => actions.push(['tab', options]) } });
  core.openFarmRegistry(); assert.equal(actions[0][0], 'back'); assert.equal(actions[0][1].delta, 1);
  pages = [{ route: 'pages/farm-record/index' }]; core.openFarmRegistry(); assert.deepEqual(actions[1], ['tab', { url: '/pages/farm/index' }]);
});
test('the farm record navigation belongs to the farm entry', async () => {
  const source = (await readFile(new URL('../apps/mobile/src/components/FarmNavigation.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const component = evaluateTypeScript(source, { vue: { ...vue, onMounted() {} }, '@dcloudio/uni-app': { onShow() {} } }, { getCurrentPages: () => [{ route: 'pages/farm-record/index' }], uni: {} }, '\nexports.navigationTest = { selected, syncRoute };');
  component.navigationTest.syncRoute(); assert.equal(component.navigationTest.selected.value, 'pages/farm/index');
});

test('Beijing date presentation remains valid at the full contract date boundary', async () => {
  // Execute the actual exported presenter without bootstrapping the uni runtime.
  const source = await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function farmRecordDate('), end = source.indexOf('\nexport function farmMeasurements(', start);
  const presenter = ts.transpile(source.slice(start, end).replace('export function', 'function'), { target: ts.ScriptTarget.ES2020 });
  const format = vm.runInNewContext(`${presenter}; farmRecordDate`, { Date, String });
  assert.equal(format(null), '农场暂未记录');
  assert.equal(format(Date.UTC(2026, 9, 26, 18, 5)), '2026年10月27日 02:05');
  assert.equal(format(0), '1970年01月01日 08:00');
  assert.equal(format(Date.UTC(2024, 1, 28, 18)), '2024年02月29日 02:00');
  assert.equal(format(Date.UTC(2025, 1, 28, 18)), '2025年03月01日 02:00');
  assert.equal(format(Date.UTC(2025, 11, 31, 18)), '2026年01月01日 02:00');
  assert.equal(format(8640000000000000), '275760年09月13日 08:00');
  assert.equal(format(8640000000000000 - 3 * 3600000), '275760年09月13日 05:00');
});
