import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../services/api/src/server.mjs';
import { listenOnFetchSafePort } from '../services/api/test-support/listen-http.mjs';
import { createFarmClient } from '../apps/mobile/src/core/client.mjs';
import * as clientModule from '../apps/mobile/src/core/client.mjs';
import * as navigation from '../apps/mobile/src/core/navigation.mjs';
import * as vue from 'vue';
import ts from 'typescript';
import { parse, compileScript } from '@vue/compiler-sfc';
const NOW = Date.parse('2026-10-27T04:00:00Z'), recordId = 'animal-mobile-eggs';
async function fixture(t) {
  let dropExecute = false, blockBootstrap = false, blockEggsReads = false;
  const dir = await mkdtemp(path.join(tmpdir(), 'eggs-mobile-'));
  const app = createApp({ databasePath: path.join(dir, 'synthetic.sqlite'), mode: 'development', allowDevelopmentAuth: true, clock: () => NOW, requestRateLimit: { maxRequests: 10000, windowMs: 60000 } });
  const baseURL = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}`, calls = [];
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const create = () => createFarmClient({ baseURL, transport: async request => {
    calls.push(request);
    if (blockBootstrap && request.url.endsWith('/bootstrap')) return { status: 503, data: { error: { code: 'SYNTHETIC_UNAVAILABLE' } } };
    if (blockEggsReads && request.method === 'GET' && request.url.includes('/eggs/')) return { status: 503, data: { error: { code: 'SYNTHETIC_UNAVAILABLE' } } };
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    const reply = { status: response.status, data: await response.json() };
    if (dropExecute && request.url.endsWith('/account/recovery/execute')) { dropExecute = false; throw Error('synthetic dropped response after commit'); }
    return reply;
  } });
  const connect = async account => { const client = create(); await client.loginDevelopment(account); await client.load(); return client; };
  const owner = await connect('eggs-mobile-owner'), staff = await connect('eggs-mobile-staff');
  app.store.importFarmBatch({ formatVersion: 1, batchId: 'eggs-mobile-synthetic', source: 'synthetic', entries: [{ expectedVersion: 0, record: { id: recordId, ownerId: owner.profile.id, kind: 'animal', name: '合成蛋鸡', unitLabel: '鸡舍1', cycleRef: 'synthetic-cycle', status: 'growing', startedAt: NOW - 86400000, expectedHarvestAt: null, observedAt: NOW - 1000, measurements: { headCount: 10 } } }] }, NOW);
  app.store.provisionEggs({ recordId, expectedProfileVersion: 0, recordVersion: 1, profile: 'chicken-eggs', enabled: true, maxDailyQuantity: 20, staff: [{ accountId: staff.profile.id, role: 'record' }] }, NOW);
  const registered = await staff.commandEggs('staff', { domain: 'eggs', action: 'register', recordId, expectedProfileVersion: 1, sourceRef: 'synthetic-eggs-001', quantity: 6 });
  await staff.acknowledgeRecovery();
  function addRecord(id) {
    app.store.importFarmBatch({ formatVersion: 1, batchId: 'synthetic-' + id, source: 'synthetic', entries: [{ expectedVersion: 0, record: { id, ownerId: owner.profile.id, kind: 'animal', name: '合成蛋鸡', unitLabel: id, cycleRef: 'synthetic-cycle', status: 'growing', startedAt: NOW - 86400000, expectedHarvestAt: null, observedAt: NOW - 1000, measurements: { headCount: 10 } } }] }, NOW);
    app.store.provisionEggs({ recordId: id, expectedProfileVersion: 0, recordVersion: 1, profile: 'chicken-eggs', enabled: true, maxDailyQuantity: 20, staff: [{ accountId: staff.profile.id, role: 'record' }] }, NOW);
  }
  return { app, owner, staff, registered, create, connect, calls, addRecord, drop() { dropExecute = true; }, bootstrap(value) { blockBootstrap = !value; }, eggsReads(value) { blockEggsReads = !value; } };
}
async function bridge(client) {
  const source = (await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8')).replaceAll('import.meta.env', '__env');
  const imports = { vue, './client.mjs': { ...clientModule, createFarmClient: () => client }, './navigation.mjs': navigation };
  return new Function('require', 'exports', '__env', 'uni', 'getCurrentPages', ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }) + ';return exports;')(name => { assert.ok(imports[name], name); return imports[name]; }, {}, { DEV: true }, {}, () => []);
}
async function registrationPage(core, recordId) {
  const loads = [], imports = { vue, '@dcloudio/uni-app': { onLoad: fn => loads.push(fn), onShow() {}, onHide() {}, onUnload() {} }, '../../core/farm': { ...core, openEggsBatch() {} }, '../../core/forum-draft': { useDraftGuard: () => ({ leaving: vue.ref(false), cancelLeave() {}, discardLeave() {} }), requestNavigation: action => action() }, '../../../../../shared/eggs.mjs': await import('../shared/eggs.mjs') };
  async function component(file) {
    const source = (await readFile(new URL('../apps/mobile/src/' + file, import.meta.url), 'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g, '');
    const code = compileScript(parse(source).descriptor, { id: file, inlineTemplate: true, templateOptions: { compilerOptions: { isCustomElement: tag => ['view', 'text'].includes(tag) } } }).content;
    return new Function('require', 'exports', 'document', 'uni', 'HTMLElement', ts.transpile(code, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }) + ';return exports.default;')(name => { assert.ok(imports[name], name); return name.endsWith('.vue') ? { default: imports[name] } : imports[name]; }, {}, { getElementById: () => null }, {}, class Element {});
  }
  imports['./FarmButton.vue'] = imports['../../components/FarmButton.vue'] = await component('components/FarmButton.vue');
  for (const name of ['FarmTextField', 'FarmDraftNotice']) imports['../../components/' + name + '.vue'] = await component('components/' + name + '.vue');
  imports['../../components/FarmScreen.vue'] = vue.defineComponent({ props: ['title', 'allowGuest'], setup(_, { slots }) { return () => vue.h('main', {}, slots.default?.()); } });
  const renderer = vue.createRenderer({ createElement: type => ({ type, children: [], props: {} }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment' }), setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null, patchProp: (n, key, before, value) => { n.props[key] = value; }, insert(n, parent, anchor) { n.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(n); else parent.children.splice(i, 0, n); }, remove(n) { const i = n.parent?.children.indexOf(n); if (i >= 0) n.parent.children.splice(i, 1); } });
  const root = { children: [] }, app = renderer.createApp(await component('pages/egg-register/index.vue')); app.mount(root); loads.forEach(fn => fn({ id: recordId })); await vue.nextTick();
  const all = () => { const result = []; function walk(n) { result.push(n); (n.children || []).forEach(walk); } walk(root); return result; };
  const field = id => all().find(n => n.props?.['data-field-key'] === id);
  const text = n => (n.text || '') + (n.children || []).map(text).join('');
  return { field, close: () => app.unmount(), async fill(id, value) { const input = field(id); assert.ok(input, id); input.props.onInput({ target: { value } }); await vue.nextTick(); }, async submit() { const button = all().find(n => n.type === 'button' && text(n) === '登记今日产出'); assert.ok(button); assert.equal(!!button.props.disabled, false); button.props.onClick({ currentTarget: button }); await vue.nextTick(); for (let attempt = 0; attempt < 100 && core.farmState.busy; attempt++) await new Promise(resolve => setTimeout(resolve, 5)); await vue.nextTick(); assert.equal(core.farmState.busy, false); } };
}
test('real HTTP lost collect response is recovered by a cold client and never grants twice', async t => {
  const h = await fixture(t), id = h.registered.batchId, before = h.owner.snapshot;
  assert.equal((await h.staff.loadEggsRecords()).items[0].recordId, recordId);
  assert.equal((await h.owner.loadEggsPage()).items[0].status, 'available');
  h.drop(); await assert.rejects(h.owner.commandEggs('customer', { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: before.revision }), { code: 'RESULT_UNKNOWN' });
  const cold = await h.connect('eggs-mobile-owner');
  assert.equal(cold.pendingKind, 'eggs'); assert.equal(cold.recoveryIntent.receipt.quantity, 6); assert.equal(cold.snapshot.system.inventory.eggs, 6); assert.equal(cold.snapshot.level.xp, before.level.xp + 8);
  const original = structuredClone(cold.recoveryIntent.receipt); await cold.acknowledgeRecovery();
  assert.deepEqual(await h.owner.retryPending(), original); assert.equal(h.owner.hasPending(), false); assert.equal(h.owner.minimumConfirmedRevision, original.appliedRevision);
  await h.owner.load(); const second = await h.owner.commandEggs('customer', { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: h.owner.snapshot.revision });
  assert.equal(second.outcome, 'refused'); await h.owner.acknowledgeRecovery(); assert.equal((await h.owner.load()).system.inventory.eggs, 6);
});
test('real HTTP acknowledgement survives bootstrap 503 and read-only egg data remains accessible under asset floor', async t => {
  const h = await fixture(t), id = h.registered.batchId;
  const receipt = await h.owner.commandEggs('customer', { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: h.owner.snapshot.revision });
  h.bootstrap(false); await h.owner.acknowledgeRecovery(); await assert.rejects(h.owner.load(), { status: 503 });
  assert.equal(h.owner.hasPending(), false); assert.equal(h.owner.assetSyncRequired, true); assert.equal(h.owner.mutationBlocked, true);
  assert.equal((await h.owner.loadEggsDetail(id)).batch.status, 'collected'); assert.equal((await h.owner.loadEggsPage()).items.length, 1);
  await h.owner.loginDevelopment('eggs-mobile-owner'); assert.equal(h.owner.minimumConfirmedRevision, receipt.appliedRevision);
  await assert.rejects(h.owner.mutate('/checkout'), { code: 'ASSET_SYNC_REQUIRED' });
  h.bootstrap(true); await h.owner.load(); assert.equal(h.owner.assetSyncRequired, false);
});
test('real HTTP cold prepared egg intent only continues or abandons after an explicit decision', async t => {
  const h = await fixture(t), id = h.registered.batchId, actor = h.owner.profile.id;
  const prepare = () => { const slot = h.app.store.recoveryCurrent(actor, NOW); return h.app.store.recoveryPrepare(actor, { expectedEpoch: slot.epoch, expectedVersion: slot.version, audience: 'customer', command: { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: h.owner.snapshot.revision } }, NOW); };
  prepare(); const cold = await h.connect('eggs-mobile-owner'), executions = () => h.calls.filter(x => x.url.endsWith('/execute')).length, initial = executions();
  assert.equal(cold.pendingStage, 'prepared'); await cold.retryPending(); assert.equal(executions(), initial); await cold.abandonRecovery(); assert.equal(cold.hasPending(), false); assert.equal((await cold.load()).system.inventory.eggs, 0);
  prepare(); await cold.discoverRecovery(); await cold.continueRecovery(); assert.equal(cold.recoveryIntent.receipt.quantity, 6); await cold.acknowledgeRecovery(); await cold.load(); assert.equal(cold.snapshot.system.inventory.eggs, 6); assert.equal(executions(), initial + 1);
});
test('actual recovery notice refresh action drives the real bridge through 503 to a fresh SQLite asset snapshot', async t => {
  const h = await fixture(t), client = h.owner, id = h.registered.batchId;
  const core = await bridge(client);
  await core.loadFarmEggs(); h.bootstrap(false);
  assert.equal(await core.commandFarmEggs('customer', { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: client.snapshot.revision }), true);
  assert.equal(core.farmState.pending, false); assert.equal(core.farmState.assetSyncRequired, true); assert.equal(core.farmState.busy, false);
  const uiImports = { vue, '../core/farm': core };
  async function component(file) {
    const content = await readFile(new URL('../apps/mobile/src/components/' + file + '.vue', import.meta.url), 'utf8');
    const script = compileScript(parse(content).descriptor, { id: file, inlineTemplate: true, templateOptions: { compilerOptions: { isCustomElement: tag => ['view', 'text'].includes(tag) } } }).content;
    return new Function('require', 'exports', 'HTMLElement', ts.transpile(script, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }) + ';return exports.default;')(name => { assert.ok(uiImports[name], name); return name.endsWith('.vue') ? { default: uiImports[name] } : uiImports[name]; }, {}, class Element {});
  }
  uiImports['./FarmButton.vue'] = await component('FarmButton');
  const renderer = vue.createRenderer({ createElement: type => ({ type, children: [], props: {} }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment' }), setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null, patchProp: (n, key, before, value) => { n.props[key] = value; }, insert(n, parent) { n.parent = parent; parent.children.push(n); }, remove(n) { const i = n.parent?.children.indexOf(n); if (i >= 0) n.parent.children.splice(i, 1); } });
  const root = { children: [] }, app = renderer.createApp(await component('FarmRecoveryNotice')); app.mount(root); t.after(() => app.unmount());
  const text = n => (n.text || '') + (n.children || []).map(text).join('');
  const all = []; function walk(n) { all.push(n); (n.children || []).forEach(walk); } walk(root);
  const button = all.find(n => n.type === 'button' && text(n) === '重新同步田园资产'); assert.ok(button); assert.equal(!!button.props.disabled, false);
  h.bootstrap(true); const before = h.calls.filter(x => x.url.endsWith('/bootstrap')).length;
  button.props.onClick({ currentTarget: button }); await vue.nextTick(); assert.equal(core.farmState.busy, true);
  for (let attempt = 0; attempt < 100 && core.farmState.busy; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.calls.filter(x => x.url.endsWith('/bootstrap')).length, before + 1);
  assert.equal(core.farmState.busy, false); assert.equal(core.farmState.assetSyncRequired, false); assert.equal(core.farmState.snapshot.system.inventory.eggs, 6); assert.doesNotMatch(text(root), /资产待同步/);
});
test('ack preserves independently refreshed current collect and withdraw detail in the real farm bridge', async t => {
  const h = await fixture(t), id = h.registered.batchId, customer = await bridge(h.owner);
  await customer.loadFarmEggsBatch(id, 'customer');
  assert.equal(await customer.commandFarmEggs('customer', { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: h.owner.snapshot.revision }), true);
  assert.equal(customer.farmState.pending, false); assert.equal(customer.farmState.eggsDetail?.batch.status, 'collected'); assert.ok(customer.farmState.eggsPage);
  const secondRecord = 'animal-mobile-eggs-002'; h.addRecord(secondRecord);
  const added = await h.staff.commandEggs('staff', { domain: 'eggs', action: 'register', recordId: secondRecord, expectedProfileVersion: 1, sourceRef: 'synthetic-eggs-002', quantity: 4 }); await h.staff.acknowledgeRecovery();
  const staff = await bridge(h.staff); await staff.loadFarmEggsBatch(added.batchId, 'staff');
  assert.equal(await staff.commandFarmEggs('staff', { domain: 'eggs', action: 'withdraw', batchId: added.batchId, expectedBatchVersion: 1 }), true);
  assert.equal(staff.farmState.eggsDetail?.batch.status, 'withdrawn'); assert.ok(staff.farmState.eggsPage); assert.equal(staff.farmState.pending, false);
});
test('SOURCE_EXISTS refusal keeps real registration qualification and native page draft editable after ack', async t => {
  const h = await fixture(t), target = 'animal-mobile-eggs-002'; h.addRecord(target); const core = await bridge(h.staff);
  await core.loadFarmEggsRecord(target, 'staff');
  const page = await registrationPage(core, target); t.after(page.close);
  await page.fill('egg-quantity', '4'); await page.fill('egg-source', 'synthetic-eggs-001'); await page.submit();
  assert.equal(core.farmState.pending, false); assert.equal(core.farmState.eggsRecord?.recordId, target); assert.equal(core.farmState.eggsRecord?.permissions.canRegister, true); assert.match(core.farmState.eggsMessage, /来源编号已使用/);
  assert.equal(page.field('egg-quantity')?.props.value, '4'); assert.equal(page.field('egg-source')?.props.value, 'synthetic-eggs-001'); assert.equal(!!page.field('egg-source')?.props.disabled, false);
  assert.equal(await core.loadFarmEggsRecord(target, 'staff'), true); assert.match(core.farmState.eggsMessage, /来源编号已使用/);
  await page.fill('egg-source', 'synthetic-fixed-002'); await page.submit(); assert.match(core.farmState.eggsMessage, /产出已登记/);
  assert.equal(core.farmState.eggsRecord?.currentBatchId, core.farmState.eggsConfirmedBatchId);
});
test('confirmed command can ack when current eggs GETs fail; it never substitutes an old detail', async t => {
  const h = await fixture(t), id = h.registered.batchId, core = await bridge(h.staff);
  await core.loadFarmEggsBatch(id, 'staff'); h.eggsReads(false);
  assert.equal(await core.commandFarmEggs('staff', { domain: 'eggs', action: 'withdraw', batchId: id, expectedBatchVersion: 1 }), true);
  assert.equal(core.farmState.pending, false); assert.equal(core.farmState.eggsDetail, null); assert.ok(core.farmState.eggsDetailError); assert.match(core.farmState.eggsMessage, /已撤回/);
});
test('record and batch feedback never follows a different object or audience; same-object refresh preserves it', async t => {
  const h = await fixture(t), second = 'animal-mobile-eggs-002', third = 'animal-mobile-eggs-003'; h.addRecord(second); h.addRecord(third);
  const core = await bridge(h.staff); await core.loadFarmEggsRecord(second, 'staff');
  await core.commandFarmEggs('staff', { domain: 'eggs', action: 'register', recordId: second, expectedProfileVersion: 1, sourceRef: 'synthetic-eggs-002', quantity: 4 });
  const registered = core.farmState.eggsConfirmedBatchId; assert.match(core.farmState.eggsMessage, /产出已登记/);
  await core.loadFarmEggsRecord(second, 'staff'); assert.match(core.farmState.eggsMessage, /产出已登记/);
  await core.loadFarmEggsRecord(third, 'staff'); assert.equal(core.farmState.eggsMessage, ''); assert.equal(core.farmState.eggsRecord?.currentBatchId, null);
  await core.loadFarmEggsBatch(registered, 'staff'); await core.commandFarmEggs('staff', { domain: 'eggs', action: 'withdraw', batchId: registered, expectedBatchVersion: 1 }); assert.match(core.farmState.eggsMessage, /已撤回/);
  await core.loadFarmEggsBatch(registered, 'staff'); assert.match(core.farmState.eggsMessage, /已撤回/);
  await core.loadFarmEggsBatch(h.registered.batchId, 'staff'); assert.equal(core.farmState.eggsMessage, '');
  await core.commandFarmEggs('staff', { domain: 'eggs', action: 'withdraw', batchId: h.registered.batchId, expectedBatchVersion: 1 }); assert.match(core.farmState.eggsMessage, /已撤回/);
  await core.loadFarmEggsBatch(h.registered.batchId, 'customer'); assert.equal(core.farmState.eggsMessage, '');
});
test('an earlier command completion cannot label a newly selected record during its pending response', async t => {
  const h = await fixture(t), second = 'animal-mobile-eggs-002', third = 'animal-mobile-eggs-003'; h.addRecord(second); h.addRecord(third);
  const core = await bridge(h.staff); await core.loadFarmEggsRecord(second, 'staff');
  const writing = core.commandFarmEggs('staff', { domain: 'eggs', action: 'register', recordId: second, expectedProfileVersion: 1, sourceRef: 'synthetic-eggs-002', quantity: 4 });
  await core.loadFarmEggsRecord(third, 'staff'); await writing;
  assert.equal(core.farmState.eggsMessage, '');
});
