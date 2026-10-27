import { recoveryFixtureTransport } from './helpers/recovery-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as actualClientModule from '../apps/mobile/src/core/client.mjs';
const clientModule = { ...actualClientModule, createFarmClient: options => actualClientModule.createFarmClient({ ...options, transport: recoveryFixtureTransport(options.transport) }) };
import * as friends from '../shared/friends.mjs';
import * as appNavigation from '../apps/mobile/src/core/navigation.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const now = 1793044800000, code = 'c'.repeat(32), peerId = 'b'.repeat(32);
const ok = data => ({ status: 200, data: { data } });
const view = (extra = {}) => ({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, version: 1,
  available: true, enabled: true, profile: { code, alias: '农友aaaaaaaa' }, friends: [], incoming: [], outgoing: [], blocked: [], ...extra });
const receipt = (extra = {}) => ({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'friends-operation-1', action: 'request', outcome: 'applied', code: 'OK', completedAt: now, ...extra });
async function wrapper() {
  const calls = [], replies = [], navigation = [];
  const client = clientModule.createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => 'friends-operation-1', transport: async request => {
    calls.push(structuredClone(request)); const reply = replies.shift(); assert.ok(reply, 'explicit response required'); if (reply instanceof Error) throw reply; return await reply;
  } });
  const source = await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8');
  const code = ts.transpile(source.replaceAll('import.meta.env', '__testEnv'), { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  const imports = { vue, './client.mjs': { ...clientModule, createFarmClient: () => client }, './navigation.mjs': appNavigation };
  const core = new Function('require', 'exports', '__testEnv', 'uni', 'getCurrentPages', `${code}\nreturn exports;`)(name => { assert.ok(imports[name], `explicit import ${name}`); return imports[name]; }, {}, { DEV: true }, {
    navigateTo: options => navigation.push(options.url), navigateBack() {}, switchTab: options => navigation.push(options.url)
  }, () => []);
  async function login(id = 'member-a') {
    replies.push(ok({ environment: 'development', token: `token-${id}`, profile: { id } })); await client.loginDevelopment('synthetic-account');
    replies.push(ok(mobileSnapshot({ profile: { id } }))); await client.load();
  }
  return { core, client, calls, replies, navigation, login };
}
test('bridge confirms minimal result before its separate GET; failed refresh does not repeat the command', async () => {
  const h = await wrapper(); await h.login(); h.replies.push(ok(view())); assert.equal(await h.core.loadFarmFriends(), true);
  h.replies.push(ok(receipt()), new Error('refresh offline'));
  assert.equal(await h.core.commandFarmFriends({ action: 'request', code }), true);
  assert.equal(h.core.farmState.pending, false); assert.equal(h.core.farmState.friends, null);
  assert.match(h.core.farmState.friendsMessage, /申请已发送/); assert.ok(h.core.farmState.friendsError);
  h.replies.push(ok(view({ version: 2 }))); await h.core.loadFarmFriends();
  assert.equal(h.calls.filter(call => call.url.endsWith('/friends/commands')).length, 1);
});
test('bridge recovery uses the original friends command then refreshes and never labels it an asset success', async () => {
  const h = await wrapper(); await h.login(); h.replies.push(ok(view())); await h.core.loadFarmFriends();
  h.replies.push(new Error('lost')); assert.equal(await h.core.commandFarmFriends({ action: 'request', code }), false);
  h.replies.push(ok(receipt()), ok(view({ version: 2 }))); assert.equal(await h.core.retryFarmOperation(), true);
  assert.equal(h.core.farmState.friends.version, 2); assert.match(h.core.farmState.friendsMessage, /申请已发送/); assert.doesNotMatch(h.core.farmState.message, /资产/);
});
test('bridge removes stale friends and errors after login; old reads cannot overwrite a newer command result', async () => {
  const h = await wrapper(); await h.login(); h.replies.push(ok(view())); await h.core.loadFarmFriends(); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.core.loadFarmFriends();
  h.replies.push(ok(receipt()), ok(view({ version: 3 }))); await h.core.commandFarmFriends({ action: 'request', code });
  finish(ok(view())); assert.equal(await old, false); assert.equal(h.core.farmState.friends.version, 3); assert.equal(h.core.farmState.friendsError, '');
  await h.login('member-b'); h.replies.push(ok(view({ ownerId: 'member-b', version: 0, enabled: false, profile: null }))); await h.core.loadFarmFriends();
  assert.equal(h.core.farmState.friends.ownerId, 'member-b'); assert.equal(h.core.farmState.friendsMessage, '');
});

async function page(state, extra = {}) {
  const source = (await readFile(new URL('../apps/mobile/src/pages/friends/index.vue', import.meta.url), 'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const commands = [], shows = [], hides = [], copies = [], focus = [];
  const farm = { farmState: state, loadFarmFriends() {}, commandFarmFriends: async command => { commands.push(command); return true; }, returnFromFriends() {}, ...extra };
  const imports = { vue, '@dcloudio/uni-app': { onShow: fn => shows.push(fn), onHide: fn => hides.push(fn) }, '../../core/farm': farm, '../../../../../shared/friends.mjs': friends };
  const code = ts.transpile(source + '\nexports.page={draft,submitCode,clearCode,copyCode,pasteCode,copyMessage,ask,confirmAction,cancelAction,confirmation,codeFocused,updateNativeCode};', { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  const result = new Function('require', 'exports', 'uni', 'document', 'HTMLElement', 'defineOptions', `${code}\nreturn exports;`)(name => imports[name] || {}, {}, {
    setClipboardData: options => { copies.push(options.data); options.success(); }, pageScrollTo() {}, ...extra.uni
  }, { getElementById: id => ({ focus: () => focus.push(id), scrollIntoView() {} }) }, class {}, () => {});
  return { ...result.page, commands, shows, hides, copies, focus };
}
test('friends code submits only by explicit action, preserves failures, clears on success and copies only own code', async () => {
  const state = vue.reactive({ authenticated: true, friends: view(), friendsBusy: false, busy: false, pending: false });
  const h = await page(state); h.draft.value = code; assert.equal(h.commands.length, 0); await h.submitCode();
  assert.deepEqual(h.commands, [{ action: 'request', code }]); assert.equal(h.draft.value, ''); await h.copyCode(); assert.deepEqual(h.copies, [code]);
  h.draft.value = 'bad'; await h.submitCode(); assert.equal(h.commands.length, 1); h.clearCode(); assert.equal(h.draft.value, '');
  const failed = await page(state, { commandFarmFriends: async () => false }); failed.draft.value = code; await failed.submitCode(); assert.equal(failed.draft.value, code);
});
test('native code input updates only the private draft and invalid submit requests platform input focus', async () => {
  const state = vue.reactive({ authenticated: true, friends: view(), friendsBusy: false, busy: false, pending: false });
  const h = await page(state); h.updateNativeCode({ target: { value: 'bad' } }); assert.equal(h.draft.value, 'bad'); assert.equal(h.commands.length, 0);
  await h.submitCode(); assert.equal(h.codeFocused.value, true); assert.ok(h.focus.includes('friend-code-input')); assert.equal(h.commands.length, 0);
});
test('clipboard callbacks from a prior account or hidden page cannot repopulate private input or feedback', async () => {
  const state = vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), friends: view(), friendsBusy: false, busy: false, pending: false });
  let paste, copy;
  const h = await page(state, { uni: { getClipboardData: options => { paste = options; }, setClipboardData: options => { copy = options; } } });
  h.pasteCode(); h.copyCode(); state.snapshot = mobileSnapshot({ profile: { id: 'member-b' } }); state.friends = view({ ownerId: 'member-b' }); await vue.nextTick();
  paste.success({ data: code }); copy.fail(); assert.equal(h.draft.value, ''); assert.equal(h.copyMessage.value, '');
  h.pasteCode(); h.hides[0](); paste.success({ data: code }); assert.equal(h.draft.value, '');
});
test('a refreshed relationship invalidates an open removal confirmation instead of silently using the new version', async () => {
  const state = vue.reactive({ authenticated: true, friends: view(), friendsBusy: false, busy: false, pending: false });
  const h = await page(state); await h.ask('remove', { peerId, alias: '农友bbbbbbbb', createdAt: now });
  state.friends = view({ version: 3 }); await h.confirmAction(); assert.equal(h.commands.length, 0); assert.equal(h.confirmation.value, null);
});
test('destructive friends actions require confirmation and account change removes draft and confirmation', async () => {
  const state = vue.reactive({ authenticated: true, friends: view(), friendsBusy: false, busy: false, pending: false });
  const h = await page(state); await h.ask('block', { peerId, alias: '农友bbbbbbbb', createdAt: now }); assert.equal(h.commands.length, 0);
  h.cancelAction(); assert.equal(h.confirmation.value, null); await h.ask('remove', { peerId, alias: '农友bbbbbbbb', createdAt: now }); await h.confirmAction();
  assert.deepEqual(h.commands, [{ action: 'remove', peerId }]); h.draft.value = code; await h.ask('disable');
  state.authenticated = false; await vue.nextTick(); assert.equal(h.draft.value, ''); assert.equal(h.confirmation.value, null);
});

async function compileComponent(path, imports) {
  const source = (await readFile(new URL(`../apps/mobile/src/${path}`, import.meta.url), 'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g, '');
  const content = compileScript(parse(source).descriptor, { id: path, inlineTemplate: true }).content;
  const code = ts.transpile(content, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  return new Function('require', 'exports', `${code}\nreturn exports.default;`)(name => {
    assert.ok(imports[name], `explicit import ${name}`); return name.endsWith('.vue') ? { default: imports[name] } : imports[name];
  }, {});
}
async function renderPage(state, path = 'pages/friends/index.vue') {
  const shell = vue.defineComponent({ setup(_, { slots }) { return () => vue.h('main', {}, slots.default?.()); } });
  const button = vue.defineComponent({ props: { disabled: Boolean }, setup(props, { slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled }, slots.default?.()); } });
  const farm = { farmState: state, loadFarmFriends() {}, commandFarmFriends() {}, returnFromFriends() {}, openFriends() {}, onFarmPageShow() {}, rewardLabel() {}, mutateFarm() {} };
  const signIn = await compileComponent('components/FarmSignIn.vue', { vue, '../core/farm': farm, './FarmButton.vue': button });
  const imports = { vue, '@dcloudio/uni-app': { onShow() {}, onHide() {} }, '../../components/FarmScreen.vue': shell, '../../components/FarmButton.vue': button,
    '../../components/EmptyPanel.vue': shell, '../../components/FarmSignIn.vue': signIn, '../../../../../shared/friends.mjs': friends,
    '../../core/farm': farm };
  const component = await compileComponent(path, imports);
  const renderer = vue.createRenderer({
    createElement: type => ({ type, tagName: type.toUpperCase(), props: {}, children: [], addEventListener() {}, removeEventListener() {} }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment', text: '' }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: () => null, patchProp: (node, name, previous, value) => { node.props[name] = value; },
    remove() {}, insert(node, parent) { node.parent = parent; parent.children.push(node); }
  });
  const root = { children: [] }, app = renderer.createApp(component); app.mount(root);
  const text = node => (node.type === '#comment' ? '' : node.text || '') + (node.children || []).map(text).join('');
  const collect = (node, type) => (node.type === type ? [node] : []).concat((node.children || []).flatMap(child => collect(child, type)));
  const nodes = node => [node].concat((node.children || []).flatMap(nodes));
  const result = { text: text(root), nodes: nodes(root), textOf: text, buttons: collect(root, 'button').map(node => ({ label: text(node), ...node.props })), inputs: collect(root, 'input'), labels: collect(root, 'label') };
  app.unmount(); return result;
}
test('actual friends template closes production writes and explains empty sandbox lists', async () => {
  const state = vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), friends: view({ environment: 'production', available: false, enabled: false, profile: null, version: 0 }), friendsBusy: false, busy: false, pending: false });
  let rendered = await renderPage(state); assert.match(rendered.text, /农友功能暂未开放/); assert.equal(rendered.inputs.length, 0); assert.ok(!rendered.buttons.some(button => button.label.includes('开通农友名片')));
  state.friends = view(); rendered = await renderPage(state);
  assert.match(rendered.text, /还没有收到申请/); assert.match(rendered.text, /还没有农友/); assert.match(rendered.text, /没有已屏蔽的农友/);
  assert.equal(rendered.inputs[0].props['aria-describedby'], 'friend-code-help');
  assert.equal(rendered.inputs.length, 1, 'H5 renders one native input without a competing uni input');
  assert.equal(rendered.labels.find(label => label.props.for === 'friend-code-input')?.props.for, rendered.inputs[0].props.id);
  assert.equal(typeof rendered.inputs[0].props.onInput, 'function', 'the native input owns the real input event instead of component v-model');
});
test('actual template disables relation and code actions during unknown operation recovery', async () => {
  const state = vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), friends: view({ incoming: [{ peerId, alias: '农友bbbbbbbb', createdAt: now }] }), friendsBusy: false, busy: false, pending: true });
  const rendered = await renderPage(state);
  for (const label of ['接受申请', '婉拒申请', '屏蔽这位农友', '复制自己的农友码', '发送农友申请', '刷新农友列表']) assert.equal(rendered.buttons.find(button => button.label === label).disabled, true, label);
});
test('actual homepage places friends directly after the photo and before activity content', async () => {
  const rendered = await renderPage(vue.reactive({ snapshot: mobileSnapshot() }), 'pages/activities/index.vue');
  const avatar = rendered.nodes.find(node => node.type === 'image' && node.props.src === '/static/photos/farm-estate.webp');
  const friendButton = rendered.nodes.find(node => node.type === 'button' && rendered.textOf(node).includes('查看我的农友'));
  assert.equal(avatar?.props['aria-label'], '农庄头像'); assert.ok(friendButton);
  assert.ok(rendered.nodes.indexOf(avatar) < rendered.nodes.indexOf(friendButton));
  assert.ok(rendered.text.indexOf('查看我的农友') < rendered.text.indexOf('今日活动'));
});
