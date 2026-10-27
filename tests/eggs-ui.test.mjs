import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as eggs from '../shared/eggs.mjs';
import * as navigationModule from '../apps/mobile/src/core/navigation.mjs';
const now = 1793044800000, id = 'a'.repeat(32), recordId = 'animal-eggs-001';
const scope = { eggFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
const record = { ...scope, recordId, recordVersion: 1, profileVersion: 1, cycleRef: 'cycle-1', name: '合成鸡群', unitLabel: '鸡舍1', enabled: true, maxDailyQuantity: 20, currentBatchId: null, permissions: { canRegister: true } };
const batch = { id, recordId, cycleRef: 'cycle-1', name: '合成鸡群', unitLabel: '鸡舍1', day: '2026-10-27', sourceRef: 'synthetic-001', quantity: 6, status: 'available', version: 1, createdAt: now, updatedAt: now, collectedAt: null, withdrawnAt: null };
async function ui(path, extra = {}, commandResult = true) {
  const state = vue.reactive({ authenticated: true, busy: false, pending: false, mutationBlocked: false, snapshot: { profile: { id: 'member-a' }, revision: 3 }, eggsRecord: record, eggsRecordAudience: 'staff', eggsRecordBusy: false, eggsRecordError: '', eggsDetail: { ...scope, batch, permissions: { canCollect: true, canWithdraw: false } }, eggsDetailAudience: 'customer', eggsDetailBusy: false, eggsMessage: '', eggsDetailError: '', ...extra });
  const loads = [], shows = [], hides = [], unloads = [], commands = [], navigation = [], focused = [];
  const farm = { farmState: state, commandFarmEggs: async (audience, command) => { commands.push({ audience, command }); return commandResult; }, loadFarmEggsRecord: async () => true, loadFarmEggsBatch: async () => true, loadFarmEggs: async () => true, loadFarmEggsRecords: async () => true, openEggs: audience => navigation.push(audience), openEggsBatch: () => navigation.push('batch'), openEggsRegister: () => navigation.push('register'), returnFromEggs() {}, eggsStateLabel: value => value, eggsDayLabel: value => value, farmRecordDate: () => '北京时间', ...extra.farm };
  const imports = { vue, '@dcloudio/uni-app': { onLoad: fn => loads.push(fn), onShow: fn => shows.push(fn), onHide: fn => hides.push(fn), onUnload: fn => unloads.push(fn), onBackPress() {} }, '../../core/farm': farm, '../core/farm': farm, './farm': farm, './navigation.mjs': navigationModule, '../../../../../shared/eggs.mjs': eggs };
  function evaluate(source, defaultOnly = true) { const module = new Function('require', 'exports', 'document', 'uni', 'HTMLElement', ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }) + ';return exports;')(name => { assert.ok(imports[name], name); return name.endsWith('.vue') ? { default: imports[name] } : imports[name]; }, {}, { getElementById: key => ({ focus: () => focused.push(key), scrollIntoView() {} }) }, { pageScrollTo() {}, hideTabBar() {}, showTabBar() {} }, class Element {}); return defaultOnly ? module.default : module; }
  imports['../../core/forum-draft'] = evaluate(await readFile(new URL('../apps/mobile/src/core/forum-draft.ts', import.meta.url), 'utf8'), false);
  imports['../../core/pagination-focus'] = evaluate(await readFile(new URL('../apps/mobile/src/core/pagination-focus.ts', import.meta.url), 'utf8'), false);
  async function component(file) { const source = (await readFile(new URL('../apps/mobile/src/' + file, import.meta.url), 'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g, ''); return evaluate(compileScript(parse(source).descriptor, { id: file, inlineTemplate: true, templateOptions: { compilerOptions: { isCustomElement: tag => ['view', 'text', 'image'].includes(tag) } } }).content); }
  imports['../../components/FarmButton.vue'] = imports['./FarmButton.vue'] = await component('components/FarmButton.vue');
  imports['../../components/FarmTextField.vue'] = await component('components/FarmTextField.vue');
  imports['../../components/FarmDraftNotice.vue'] = await component('components/FarmDraftNotice.vue');
  imports['../../components/FarmScreen.vue'] = vue.defineComponent({ props: ['title', 'allowGuest'], setup(_, { slots }) { return () => [vue.h('main', {}, slots.default?.()), vue.h('nav')]; } });
  const renderer = vue.createRenderer({ createElement: type => ({ type, props: {}, children: [] }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment' }), setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null, patchProp: (n, key, before, value) => { n.props[key] = value; }, insert(n, parent, anchor) { n.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(n); else parent.children.splice(i, 0, n); }, remove(n) { const i = n.parent?.children.indexOf(n); if (i >= 0) n.parent.children.splice(i, 1); } });
  const root = { children: [] }, app = renderer.createApp(await component(path), extra.props), warnings = []; app.config.warnHandler = message => warnings.push(message); app.mount(root);
  const text = n => (n.type === '#comment' ? '' : n.text || '') + (n.children || []).map(text).join('');
  const nodes = () => { const all = []; function walk(n) { all.push(n); (n.children || []).forEach(walk); } walk(root); return all; };
  return { state, loads, shows, hides, unloads, commands, navigation, focused, warnings, text: () => text(root), nodes, async click(label) { const target = nodes().find(n => n.type === 'button' && text(n) === label); assert.ok(target, label); target.props.onClick({ currentTarget: target }); await vue.nextTick(); }, async fill(key, value) { const input = nodes().find(n => n.props?.['data-field-key'] === key); assert.ok(input, key); input.props.onInput({ target: { value } }); await vue.nextTick(); }, close() { app.unmount(); unloads.forEach(fn => fn()); } };
}
test('staff registration uses labeled gray native placeholders and a numeric keyboard, failure preserves both inputs', async () => {
  const h = await ui('pages/egg-register/index.vue', {}, false);
  try { h.loads.forEach(fn => fn({ id: recordId })); await vue.nextTick();
    const number = h.nodes().find(n => n.props?.['data-field-key'] === 'egg-quantity'); assert.ok(number); assert.equal(number.props.inputmode, 'numeric'); assert.ok(number.props.placeholder);
    await h.fill('egg-quantity', '6'); await h.fill('egg-source', 'synthetic-001'); await h.click('登记今日产出');
    assert.equal(h.commands.length, 1); assert.deepEqual(h.commands[0], { audience: 'staff', command: { domain: 'eggs', action: 'register', recordId, expectedProfileVersion: 1, quantity: 6, sourceRef: 'synthetic-001' } });
    assert.equal(h.nodes().find(n => n.props?.['data-field-key'] === 'egg-quantity').props.value, '6');
    assert.equal(h.nodes().find(n => n.props?.['data-field-key'] === 'egg-source').props.value, 'synthetic-001');
    await h.fill('egg-quantity', '0'); await h.click('登记今日产出'); assert.equal(h.commands.length, 1); assert.match(h.text(), /1至20/); assert.ok(h.focused.length);
  } finally { h.close(); }
});
test('customer collection shows exact day and quantity without quantity entry and requires explicit confirmation', async () => {
  const h = await ui('pages/egg-batch/index.vue');
  try { h.loads.forEach(fn => fn({ id, audience: 'customer' })); await vue.nextTick(); assert.match(h.text(), /2026-10-27/); assert.match(h.text(), /6/); assert.equal(h.nodes().some(n => n.type === 'input'), false);
    await h.click('手动收取鸡蛋'); assert.equal(h.commands.length, 0); await h.click('确认收取6枚鸡蛋'); assert.equal(h.commands.length, 1);
    assert.deepEqual(h.commands[0], { audience: 'customer', command: { domain: 'eggs', action: 'collect', batchId: id, expectedBatchVersion: 1, expectedRevision: 3 } });
  } finally { h.close(); }
});
test('late staff registration result after page hide cannot clear draft or navigate', async () => {
  let finish; const h = await ui('pages/egg-register/index.vue', { farm: { commandFarmEggs: () => new Promise(resolve => { finish = resolve; }) } });
  try { h.loads.forEach(fn => fn({ id: recordId })); await vue.nextTick(); await h.fill('egg-quantity', '6'); await h.fill('egg-source', 'synthetic-001'); await h.click('登记今日产出'); h.hides.forEach(fn => fn()); finish(true); await vue.nextTick(); await vue.nextTick(); assert.equal(h.navigation.length, 0); assert.equal(h.nodes().find(n => n.props?.['data-field-key'] === 'egg-source').props.value, 'synthetic-001'); } finally { h.close(); }
});
test('all egg routes keep the shared My navigation owner', async () => {
  const source = (await readFile(new URL('../apps/mobile/src/components/FarmNavigation.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  let route = 'pages/eggs/index';
  const imports = { vue: { ...vue, onMounted() {} }, '@dcloudio/uni-app': { onShow() {} }, '../core/navigation.mjs': { requestNavigation: action => action() } };
  const core = new Function('require', 'exports', 'getCurrentPages', ts.transpile(source + '\nexports.test = { selected, syncRoute };', { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }) + ';return exports.test;')(name => imports[name], {}, () => [{ route }]);
  for (const page of ['eggs', 'egg-batch', 'egg-register']) { route = 'pages/' + page + '/index'; core.syncRoute(); assert.equal(core.selected.value, 'pages/profile/index'); }
});
test('egg registration reuses the sole draft guard for global receipt navigation and safe cancel', async () => {
  const h = await ui('pages/egg-register/index.vue', {}, false), destinations = [];
  try {
    h.loads.forEach(fn => fn({ id: recordId })); h.shows.forEach(fn => fn()); await vue.nextTick();
    await h.fill('egg-quantity', '6'); await h.fill('egg-source', 'synthetic-001');
    navigationModule.requestNavigation(() => destinations.push('receipt')); await vue.nextTick();
    assert.match(h.text(), /要放弃未提交的草稿吗/); assert.ok(h.focused.some(value => /^eggs-\d+-leave-cancel$/.test(value))); assert.deepEqual(destinations, []);
    await h.click('返回，继续填写'); assert.equal(h.nodes().find(n => n.props?.['data-field-key'] === 'egg-source').props.value, 'synthetic-001');
    navigationModule.requestNavigation(() => destinations.push('receipt')); await vue.nextTick(); await h.click('放弃草稿并离开'); assert.deepEqual(destinations, ['receipt']); assert.equal(h.nodes().find(n => n.props?.['data-field-key'] === 'egg-source').props.value, '');
  } finally { h.close(); }
});
test('staff withdraw uses only server permission and frozen batch version; permission refresh cancels the confirmation', async () => {
  const h = await ui('pages/egg-batch/index.vue', { eggsDetailAudience: 'staff', eggsDetail: { ...scope, batch, permissions: { canCollect: false, canWithdraw: true } } });
  try {
    h.loads.forEach(fn => fn({ id, audience: 'staff' })); await vue.nextTick(); await h.click('撤回这笔登记'); assert.equal(h.commands.length, 0); await h.click('确认撤回这笔登记'); assert.deepEqual(h.commands[0], { audience: 'staff', command: { domain: 'eggs', action: 'withdraw', batchId: id, expectedBatchVersion: 1 } });
    await h.click('撤回这笔登记'); h.state.eggsDetail = { ...scope, batch, permissions: { canCollect: false, canWithdraw: false } }; await vue.nextTick(); assert.doesNotMatch(h.text(), /确认撤回这笔登记/);
  } finally { h.close(); }
});
test('egg routes consume framework query attrs without leaking to the shared fragment screen', async () => {
  for (const page of ['eggs', 'egg-batch', 'egg-register']) {
    const h = await ui(`pages/${page}/index.vue`, { props: { id: page === 'egg-register' ? recordId : id, audience: 'staff' } });
    try { assert.deepEqual(h.warnings, []); } finally { h.close(); }
  }
});
test('egg list renders current staff objects and truthful empty state, invalid audience never grants staff access', async () => {
  const h = await ui('pages/eggs/index.vue', { eggsStatus: { ...scope, available: true, hasStaffAccess: true }, eggsAudience: 'staff', eggsPage: { ...scope, items: [], nextCursor: null }, eggsRecords: { ...scope, items: [record], nextCursor: null } });
  try { h.loads.forEach(fn => fn({ audience: 'staff' })); await vue.nextTick(); assert.match(h.text(), /当前授权登记对象/); assert.match(h.text(), /合成鸡群/); assert.match(h.text(), /还没有鸡蛋产出登记/); await h.click('查看今日登记'); assert.deepEqual(h.navigation, ['register']); h.loads.forEach(fn => fn({ audience: 'admin' })); await vue.nextTick(); assert.match(h.text(), /入口无效/); } finally { h.close(); }
});
