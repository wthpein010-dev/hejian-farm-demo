import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as clientModule from '../apps/mobile/src/core/client.mjs';
import * as navigation from '../apps/mobile/src/core/navigation.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';
const now = 1793044800000, id = 'a'.repeat(32), ref = 'b'.repeat(32), recordId = 'record-001';
const ok = data => ({ status: 200, data: { data } });
const scope = { plantingFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
const status = () => ({ ...scope, available: true, hasStaffAccess: true });
const page = () => ({ ...scope, items: [], nextCursor: null });
const order = (extra = {}) => ({ id, recordId, cycleRef: 'cycle-1', name: '合成番茄', unitLabel: '地块1', status: 'requested', version: 1, recordVersion: 1, notBefore: now, createdAt: now, updatedAt: now, startedAt: null, completedAt: null, assigneeRef: null, ...extra });
const permissions = (extra = {}) => ({ canCancel: false, canAccept: false, canAssign: false, canStart: false, canComplete: false, canCancelWork: false, ...extra });
const detail = (extra = {}) => ({ ...scope, order: order(), events: [{ version: 1, action: 'request', recordedAt: now, occurredAt: now, actorRef: 'customer' }], candidates: [], permissions: permissions({ canCancel: true }), ...extra });
const receipt = () => ({ plantingFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'planting-ui-operation', action: 'cancel', outcome: 'applied', code: 'OK', orderId: id, completedAt: now });
function evaluate(source, imports, globals = {}) {
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  return new Function('require', 'exports', ...Object.keys(globals), `${code}\nreturn exports;`)(name => { assert.ok(imports[name], `explicit import ${name}`); return name.endsWith('.vue') ? { default: imports[name] } : imports[name]; }, {}, ...Object.values(globals));
}
async function bridge() {
  const calls = [], replies = [];
  const client = clientModule.createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => 'planting-ui-operation', transport: async request => { calls.push(structuredClone(request)); const response = replies.shift(); assert.ok(response, 'explicit response required'); if (response instanceof Error) throw response; return await response; } });
  const source = (await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8')).replaceAll('import.meta.env', '__env');
  const core = evaluate(source, { vue, './client.mjs': { ...clientModule, createFarmClient: () => client }, './navigation.mjs': navigation }, { __env: { DEV: true }, uni: { navigateTo() {}, switchTab() {} }, getCurrentPages: () => [] });
  async function login(ownerId = 'member-a') { replies.push(ok({ token: 'token-' + ownerId, profile: { id: ownerId } })); await client.loginDevelopment('synthetic'); replies.push(ok(mobileSnapshot({ profile: { id: ownerId } }))); await client.load(); }
  return { core, client, calls, replies, login };
}
test('planting bridge removes permissions immediately; confirmed command survives independent GET failure without resending', async () => {
  const h = await bridge(); await h.login(); assert.equal(typeof h.core.loadFarmPlantingOrder, 'function');
  h.replies.push(ok(status()), ok(detail())); await h.core.loadFarmPlantingOrder(id);
  let finish; h.replies.push(new Promise(resolve => { finish = resolve; })); const writing = h.core.commandFarmPlanting({ action: 'cancel', orderId: id, expectedOrderVersion: 1 });
  assert.equal(h.core.farmState.plantingDetail, null); h.replies.push(new Error('offline'), new Error('offline')); finish(ok(receipt())); assert.equal(await writing, true);
  assert.equal(h.core.farmState.pending, false); assert.ok(h.core.farmState.plantingError); assert.match(h.core.farmState.plantingMessage, /取消/);
  h.replies.push(ok(status()), ok(detail())); await h.core.loadFarmPlantingOrder(id); assert.equal(h.calls.filter(call => call.url.endsWith('/planting/commands')).length, 1);
});
test('planting bridge invalidates prior account reads and retry settles original planting operation', async () => {
  const h = await bridge(); await h.login(); assert.equal(typeof h.core.loadFarmPlantingOrders, 'function');
  h.replies.push(ok(status()), ok(page())); await h.core.loadFarmPlantingOrders(); h.replies.push(new Error('lost')); await h.core.commandFarmPlanting({ action: 'cancel', orderId: id, expectedOrderVersion: 1 });
  h.replies.push(ok(receipt()), ok(status()), ok(page())); await h.core.retryFarmOperation(); assert.equal(h.core.farmState.pending, false); assert.doesNotMatch(h.core.farmState.message, /资产/);
  let finish; h.replies.push(new Promise(resolve => { finish = resolve; })); const reading = h.core.loadFarmPlantingOrders(); await h.login('member-b'); h.replies.push(ok({ ...status(), ownerId: 'member-b' }), ok({ ...page(), ownerId: 'member-b' })); await h.core.loadFarmPlantingOrders(); finish(ok(status()));
  assert.equal(await reading, false); assert.equal(h.core.farmState.plantingStatus.ownerId, 'member-b'); assert.equal(h.core.farmState.plantingMessage, '');
});
function initial(extra = {}) { return vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), busy: false, pending: false, plantingStatus: status(), plantingDetail: detail(), plantingPage: page(), plantingAudience: 'customer', plantingDetailAudience: 'customer', plantingBusy: false, plantingDetailBusy: false, plantingError: '', plantingDetailError: '', plantingMessage: '', ...extra }); }
async function ui(path, state, extra = {}) {
  const loads = [], shows = [], hides = [], commands = [], focused = [];
  const farm = { farmState: state, loadFarmPlantingOrder: async () => true, loadFarmPlantingOrders: async () => true, loadFarmPlantingRecord: async () => true, commandFarmPlanting: async (command, audience) => { commands.push({ command, audience }); return true; }, plantingStateLabel: x => x, plantingActionLabel: x => x, plantingNow: () => now + 2000, farmRecordDate: () => '北京时间', openPlantingOrder() {}, openPlantingOrders() {}, returnFromPlanting() {}, openFarmRecord() {}, ...extra };
  const documentState = { getElementById: value => ({ focus: () => focused.push(value), scrollIntoView() {} }), activeElement: null, body: {} };
  class Element { focus() { documentState.activeElement = this; } get isConnected() { let node = this; while (node.parent) node = node.parent; return node === documentState.root; } }
  const globals = { document: documentState, HTMLElement: Element, uni: { pageScrollTo() {} } };
  const imports = { vue, '@dcloudio/uni-app': { onLoad: fn => loads.push(fn), onShow: fn => shows.push(fn), onHide: fn => hides.push(fn) }, '../../core/farm': farm, '../core/farm': farm, '../../core/navigation.mjs': navigation };
  imports['../../core/pagination-focus'] = evaluate(await readFile(new URL('../apps/mobile/src/core/pagination-focus.ts', import.meta.url), 'utf8'), { vue }, globals);
  async function component(file) {
    const source = (await readFile(new URL('../apps/mobile/src/' + file, import.meta.url), 'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g, '');
    return evaluate(compileScript(parse(source).descriptor, { id: file, inlineTemplate: true, templateOptions: { compilerOptions: { isCustomElement: tag => ['view', 'text', 'image'].includes(tag) } } }).content, imports, globals).default;
  }
  imports['../../components/FarmButton.vue'] = imports['./FarmButton.vue'] = await component('components/FarmButton.vue');
  imports['../../components/FarmScreen.vue'] = vue.defineComponent({ props: ['title'], setup(_, { slots }) { return () => [vue.h('main', {}, slots.default?.()), vue.h('nav')]; } });
  const subject = await component(path), renderer = vue.createRenderer({ createElement: type => Object.assign(new Element(), { type, props: {}, style: {}, children: [] }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment', text: '' }), setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; }, parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null, patchProp: (node, name, before, value) => { node.props[name] = value; }, remove(node) { const index = node.parent?.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); node.parent = null; }, insert(node, parent, anchor) { if (node.parent) { const index = node.parent.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); } node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node); } });
  const root = { children: [] }, app = renderer.createApp(subject, extra.props), warnings = []; documentState.root = root; app.config.warnHandler = warning => warnings.push(warning); app.mount(root);
  const text = node => (node.type === '#comment' ? '' : node.text || '') + (node.children || []).map(text).join('');
  const nodes = () => { const all = []; function walk(node) { all.push(node); for (const child of node.children || []) walk(child); } walk(root); return all; };
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const click = async label => { const target = button(label); assert.ok(target, label); documentState.activeElement = target; target.props.onClick({ currentTarget: target }); await vue.nextTick(); };
  return { loads, shows, hides, commands, button, click, nodes, text: () => text(root), focused, warnings, document: documentState, close: () => app.unmount() };
}
test('customer cancel requires object confirmation, captures version, clears confirmation on permissions refresh', async () => {
  const state = initial(), h = await ui('pages/planting-order/index.vue', state);
  try { h.loads.forEach(fn => fn({ id, audience: 'customer' })); await vue.nextTick(); await h.click('取消播种申请'); assert.equal(h.commands.length, 0); assert.match(h.text(), /合成番茄/); await h.click('确认取消申请'); assert.deepEqual(h.commands, [{ command: { action: 'cancel', orderId: id, expectedOrderVersion: 1 }, audience: 'customer' }]); await h.click('取消播种申请'); state.plantingDetail = detail({ permissions: permissions() }); await vue.nextTick(); assert.equal(h.button('确认取消申请'), undefined); } finally { h.close(); }
});
test('staff complete and manual-stop use calibrated instant, frozen body and explicit non-device meaning', async () => {
  const state = initial({ plantingDetailAudience: 'staff', plantingDetail: detail({ order: order({ status: 'working', version: 4, assigneeRef: ref, startedAt: now }), permissions: permissions({ canComplete: true, canCancelWork: true }) }) });
  const h = await ui('pages/planting-order/index.vue', state);
  try { h.loads.forEach(fn => fn({ id, audience: 'staff' })); await vue.nextTick(); await h.click('回传播种完成'); assert.equal(h.commands.length, 0); await h.click('确认回传完成'); assert.deepEqual(h.commands[0], { command: { action: 'complete', orderId: id, expectedOrderVersion: 4, expectedRecordVersion: 1, performedAt: now + 2000 }, audience: 'staff' }); await h.click('核实人工停工'); assert.match(h.text(), /不是设备停止回执/); await h.click('确认已人工停工'); assert.equal(h.commands[1].command.reason, 'farm-confirmed-stop'); assert.equal(h.commands[1].command.stoppedAt, now + 2000); assert.equal(h.nodes().filter(node => ['input', 'textarea'].includes(node.type)).length, 0); } finally { h.close(); }
});
test('staff assignment accepts only current candidate refs, hides revoked controls, rejects invalid audience deep link', async () => {
  const state = initial({ plantingDetailAudience: 'staff', plantingDetail: detail({ order: order({ status: 'accepted', version: 2 }), permissions: permissions({ canAssign: true }), candidates: [{ ref, label: '农务员bbbbbb' }] }) }), h = await ui('pages/planting-order/index.vue', state);
  try { h.loads.forEach(fn => fn({ id, audience: 'staff' })); await vue.nextTick(); await h.click('安排农务员'); await h.click('农务员bbbbbb'); await h.click('确认派工'); assert.equal(h.commands[0].command.assigneeRef, ref); state.plantingDetail = null; await vue.nextTick(); assert.equal(h.button('安排农务员'), undefined); h.loads.forEach(fn => fn({ id, audience: 'admin' })); await vue.nextTick(); assert.match(h.text(), /入口无效/); } finally { h.close(); }
});
const farmRecord = { id: recordId, kind: 'plot', status: 'planned', startedAt: null, version: 1, name: '合成番茄', unitLabel: '地块1', cycleRef: 'cycle-1' };
test('record entry requests only eligible matching planned record; existing active order opens progress and stale version cannot submit', async () => {
  const state = initial({ plantingRecord: { ...scope, recordId, recordVersion: 1, enabled: true, notBefore: now, currentOrderId: null }, plantingRecordBusy: false, plantingRecordError: '' }), opened = [];
  const h = await ui('components/FarmPlantingRequest.vue', state, { props: { record: farmRecord }, openPlantingOrder: value => opened.push(value) });
  try { await h.click('申请本轮播种'); assert.equal(h.commands.length, 0); await h.click('确认申请播种'); assert.deepEqual(h.commands, [{ command: { action: 'request', recordId, expectedRecordVersion: 1 }, audience: 'customer' }]); state.plantingRecord = { ...state.plantingRecord, recordVersion: 2 }; await vue.nextTick(); assert.equal(h.button('申请本轮播种'), undefined); state.plantingRecord = { ...state.plantingRecord, currentOrderId: id, enabled: false }; await vue.nextTick(); await h.click('查看当前播种作业'); assert.deepEqual(opened, [id]); } finally { h.close(); }
});
test('list shows current audience only, recovery limitations, staff entry comes from explicit status authorization', async () => {
  const state = initial(), h = await ui('pages/planting/index.vue', state);
  try { h.loads.forEach(fn => fn({ audience: 'customer' })); await vue.nextTick(); assert.ok(h.button('进入农务工作台')); assert.match(h.text(), /原操作回执不能自动恢复/); state.plantingStatus = { ...status(), hasStaffAccess: false }; await vue.nextTick(); assert.equal(h.button('进入农务工作台'), undefined); state.plantingAudience = 'staff'; state.plantingPage = { ...page(), items: [order()] }; await vue.nextTick(); assert.equal(h.button('查看作业进展'), undefined); } finally { h.close(); }
});
test('framework route attributes do not leak into the fragment screen or emit Vue warnings', async () => {
  for (const path of ['pages/planting/index.vue', 'pages/planting-order/index.vue']) {
    const h = await ui(path, initial(), { props: { audience: 'staff', id } });
    try { h.loads.forEach(fn => fn({ audience: 'staff', id })); await vue.nextTick(); assert.deepEqual(h.warnings, []); } finally { h.close(); }
  }
});
test('cancelling an inline action restores keyboard focus to its surviving original trigger', async () => {
  const h = await ui('pages/planting-order/index.vue', initial());
  try { h.loads.forEach(fn => fn({ id })); await vue.nextTick(); const trigger = h.button('取消播种申请'); await h.click('取消播种申请'); await h.click('返回，暂不操作'); await vue.nextTick(); assert.equal(h.document.activeElement, trigger); assert.equal(trigger.isConnected, true); } finally { h.close(); }
});
