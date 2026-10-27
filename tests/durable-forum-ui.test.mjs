import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as clientModule from '../apps/mobile/src/core/client.mjs';
import * as contract from '../shared/forum.mjs';
import * as navigation from '../apps/mobile/src/core/navigation.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const now = 1793044800000, id = 'a'.repeat(32), peerId = 'b'.repeat(32);
const ok = data => ({ status: 200, data: { data } });
const scope = { forumFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now };
const status = (extra = {}) => ({ ...scope, available: true, canPost: true, alias: '农友bbbbbbbb', limits: { posts: 10, comments: 50, reports: 20, active: 200 }, usage: { posts: 0, comments: 0, reports: 0 }, ...extra });
const content = (extra = {}) => ({ id, kind: 'post', parentId: null, circle: 'harvest', author: { peerId, alias: '农友bbbbbbbb', self: false }, title: '田间的新收获', body: '今天收到了新鲜的蔬菜。', state: 'published', version: 2, createdAt: now, updatedAt: now, publishedAt: now, reasonCode: null, ...extra });
const page = (extra = {}) => ({ ...scope, scope: 'public', circle: 'all', items: [], nextCursor: null, ...extra });
const receipt = (extra = {}) => ({ forumFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'forum-ui-operation', action: 'submit-post', outcome: 'applied', code: 'OK', contentId: id, completedAt: now, ...extra });
function evaluate(source, imports, globals = {}) {
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  return new Function('require', 'exports', ...Object.keys(globals), `${code}\nreturn exports;`)(name => { assert.ok(imports[name], `explicit import ${name}`); return name.endsWith('.vue') ? { default: imports[name] } : imports[name]; }, {}, ...Object.values(globals));
}
async function bridge() {
  const calls = [], replies = [], destinations = [];
  const client = clientModule.createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => 'forum-ui-operation', transport: async request => { calls.push(structuredClone(request)); const response = replies.shift(); assert.ok(response, 'explicit response required'); if (response instanceof Error) throw response; return await response; } });
  const source = (await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8')).replaceAll('import.meta.env', '__env');
  const core = evaluate(source, { vue, './client.mjs': { ...clientModule, createFarmClient: () => client }, './navigation.mjs': navigation }, { __env: { DEV: true }, uni: { navigateTo: options => destinations.push(options.url), switchTab: options => destinations.push(options.url) }, getCurrentPages: () => [] });
  async function login(ownerId = 'member-a') { replies.push(ok({ token: 'token-' + ownerId, profile: { id: ownerId } })); await client.loginDevelopment('synthetic'); replies.push(ok(mobileSnapshot({ profile: { id: ownerId } }))); await client.load(); }
  return { core, client, calls, replies, login, destinations };
}
test('forum bridge confirms before current reads and never resends after a failed refresh', async () => {
  const h = await bridge(); await h.login(); h.replies.push(ok(status()), ok(page())); await h.core.loadFarmForum();
  h.replies.push(ok(receipt()), new Error('offline')); assert.equal(await h.core.commandFarmForum({ action: 'submit-post', circle: 'harvest', title: '今天的新收获', body: '新鲜的蔬菜长得很不错。' }), true);
  assert.equal(h.core.farmState.pending, false); assert.equal(h.core.farmState.forumPage, null); assert.match(h.core.farmState.forumMessage, /提交审核/); assert.ok(h.core.farmState.forumError);
  h.replies.push(ok(status()), ok(page())); await h.core.loadFarmForum(); assert.equal(h.calls.filter(call => call.url.endsWith('/forum/commands')).length, 1);
});
test('forum bridge recovers original pending command and invalidates late and other-account reads', async () => {
  const h = await bridge(); await h.login(); h.replies.push(new Error('lost')); await h.core.commandFarmForum({ action: 'submit-post', circle: 'harvest', title: '今天的新收获', body: '新鲜的蔬菜长得很不错。' });
  h.replies.push(ok(receipt()), ok(status()), ok(page())); await h.core.retryFarmOperation(); assert.match(h.core.farmState.forumMessage, /提交审核/); assert.doesNotMatch(h.core.farmState.message, /资产/);
  let finish; h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.core.loadFarmForum(); await h.login('member-b');
  h.replies.push(ok(status({ ownerId: 'member-b' })), ok(page({ ownerId: 'member-b' }))); await h.core.loadFarmForum(); finish(ok(status())); assert.equal(await old, false); assert.equal(h.core.farmState.forumStatus.ownerId, 'member-b');
});

test('friend unblock clears stale forum content and old block feedback immediately, with refresh recovery while navigation is busy', async () => {
  const h = await bridge(); await h.login(); const peer = { peerId, alias: '农友bbbbbbbb', createdAt: now };
  const friends = { friendsFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, version: 8, available: true, enabled: true, profile: { code: 'c'.repeat(32), alias: '农友aaaaaaaa' }, friends: [], incoming: [], outgoing: [], blocked: [peer] };
  h.replies.push(ok(friends), ok(status()), ok(page({ items: [content()] }))); await h.core.loadFarmFriends(); await h.core.loadFarmForum();
  h.core.farmState.forumMessage = '已屏蔽该作者，双方的申请和关系已移除。'; let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const writing = h.core.commandFarmFriends({ action: 'unblock', peerId });
  assert.equal(h.core.farmState.forumMessage, ''); assert.equal(h.core.farmState.forumPage, null); assert.equal(h.core.farmState.forumStatus, null);
  assert.match(h.core.farmState.forumError, /刷新/); assert.equal(h.core.farmState.busy, true);
  h.replies.push(ok({ ...friends, version: 9, blocked: [] })); finish(ok({ friendsFormat: 1, ownerId: 'member-a', environment: 'development', operationKey: 'forum-ui-operation', action: 'unblock', outcome: 'applied', code: 'OK', completedAt: now })); await writing;
  assert.equal(h.core.farmState.forumPage, null); assert.equal(h.core.farmState.forumMessage, ''); assert.match(h.core.farmState.forumError, /刷新/);
  h.replies.push(ok(status()), ok(page({ items: [content()] }))); await h.core.loadFarmForum(); assert.equal(h.core.farmState.forumPage.items.length, 1); assert.equal(h.core.farmState.forumError, ''); assert.equal(h.core.farmState.forumMessage, '');
});

test('forum block clears stale friends and feedback before ack, leaving an explicit refresh path if the friends page was shown while busy', async () => {
  const h = await bridge(); await h.login(); const friends = { friendsFormat: 1, ownerId: 'member-a', environment: 'development', serverTime: now, version: 8, available: true, enabled: true, profile: { code: 'c'.repeat(32), alias: '农友aaaaaaaa' }, friends: [{ peerId, alias: '农友bbbbbbbb', createdAt: now }], incoming: [], outgoing: [], blocked: [] };
  h.replies.push(ok(friends)); await h.core.loadFarmFriends(); h.core.farmState.friendsMessage = '已接受申请，成为农友。'; let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const writing = h.core.commandFarmForum({ action: 'block-author', contentId: id, expectedVersion: 2 });
  assert.equal(h.core.farmState.friends, null); assert.equal(h.core.farmState.friendsMessage, ''); assert.match(h.core.farmState.friendsError, /刷新/);
  h.replies.push(ok(status()), ok(page())); finish(ok(receipt({ action: 'block-author' }))); await writing;
  assert.equal(h.core.farmState.friends, null); assert.equal(h.core.farmState.friendsMessage, ''); assert.match(h.core.farmState.friendsError, /刷新/);
});

const noop = () => {};
function initial(extra = {}) { return vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), busy: false, pending: false, forumStatus: status(), forumPage: page(), forumReports: null, forumDetail: { ...scope, post: content(), comments: [], nextCursor: null }, forumBusy: false, forumDetailBusy: false, forumError: '', forumDetailError: '', forumMessage: '', ...extra }); }
async function ui(path, state, extra = {}) {
  const shows = [], hides = [], loads = [], backs = [], unloads = [], commands = [], focused = [], destinations = [];
  const farm = { farmState: state, loadFarmForum: async () => true, loadFarmForumPost: async () => true, commandFarmForum: async command => { commands.push(command); return true; }, forumCircles: [{ id: 'all', title: '全部圈子' }, { id: 'harvest', title: '丰收分享' }, { id: 'questions', title: '种养问答' }, { id: 'chat', title: '田园闲聊' }], forumReasons: [{ id: 'spam', title: '广告刷屏' }], forumCircleLabel: () => '丰收分享', forumStateLabel: value => value, farmRecordDate: () => '北京时间', openFriends: () => destinations.push('friends'), openForumPost: value => destinations.push(value), returnFromFriends: () => destinations.push('home'), returnFromForumPost: () => destinations.push('community'), ...extra };
  const lifecycles = { onShow: fn => shows.push(fn), onHide: fn => hides.push(fn), onLoad: fn => loads.push(fn), onUnload: fn => unloads.push(fn), onBackPress: fn => backs.push(fn) };
  const documentState = { getElementById: value => ({ focus: () => focused.push(value), scrollIntoView() {} }), activeElement: null, body: {} };
  class TestElement { focus() { documentState.activeElement = this; focused.push(this.props?.id); } scrollIntoView() {} get isConnected() { return !!this.parent && this.parent.children.includes(this); } }
  const globals = { document: documentState, HTMLElement: TestElement, uni: { pageScrollTo() {}, hideTabBar() {}, showTabBar() {}, navigateBack: () => destinations.push('back') } };
  const draftSource = await readFile(new URL('../apps/mobile/src/core/forum-draft.ts', import.meta.url), 'utf8');
  const draft = evaluate(draftSource, { vue, '@dcloudio/uni-app': lifecycles, './farm': farm, './navigation.mjs': navigation }, globals);
  const pagination = evaluate(await readFile(new URL('../apps/mobile/src/core/pagination-focus.ts', import.meta.url), 'utf8'), { vue }, globals);
  const shared = { vue, '@dcloudio/uni-app': lifecycles, '../core/farm': farm, '../../core/farm': farm, '../core/navigation.mjs': navigation, '../../core/forum-draft': draft, '../../core/pagination-focus': pagination, '../../../../../shared/forum.mjs': contract };
  const shell = vue.defineComponent({ setup(_, { slots }) { return () => vue.h('main', {}, slots.default?.()); } });
  async function component(file) {
    const source = (await readFile(new URL('../apps/mobile/src/' + file, import.meta.url), 'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g, '');
    const content = compileScript(parse(source).descriptor, { id: file, inlineTemplate: true, templateOptions: { compilerOptions: { isCustomElement: tag => ['view', 'text', 'image'].includes(tag) } } }).content;
    return evaluate(content, shared, globals).default;
  }
  shared['./FarmButton.vue'] = shared['../../components/FarmButton.vue'] = await component('components/FarmButton.vue');
  shared['./FarmNavigation.vue'] = vue.defineComponent({ setup: () => () => null });
  shared['../../components/FarmScreen.vue'] = extra.realScreen ? await component('components/FarmScreen.vue') : shell;
  for (const name of ['FarmTextField', 'FarmDraftNotice', 'FarmForumActions']) shared[`../../components/${name}.vue`] = await component(`components/${name}.vue`);
  const subject = await component(path);
  const renderer = vue.createRenderer({ createElement: type => Object.assign(new TestElement(), { type, props: {}, children: [] }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment', text: '' }), setText: (node, value) => { node.text = value; }, setElementText: (node, value) => { node.text = value; node.children = []; }, parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null, patchProp: (node, name, before, value) => { node.props[name] = value; }, remove(node) { const index = node.parent?.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); }, insert(node, parent, anchor) { if (node.parent) { const index = node.parent.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); } node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node); } });
  const root = { children: [] }, app = renderer.createApp(subject), warnings = []; app.config.warnHandler = warning => warnings.push(warning); app.mount(root);
  const text = node => (node.type === '#comment' ? '' : node.text || '') + (node.children || []).map(text).join('');
  const nodes = () => { const result = []; function walk(node) { result.push(node); for (const child of node.children || []) walk(child); } walk(root); return result; };
  const findButton = value => nodes().find(node => node.type === 'button' && text(node) === value);
  const click = async (value, keyboard = false) => { const button = findButton(value); assert.ok(button, `button ${value}`); if (keyboard) documentState.activeElement = button; button.props.onClick({ currentTarget: button, detail: keyboard ? 0 : 1 }); await vue.nextTick(); };
  const input = async (fieldId, value) => { const field = nodes().find(node => node.props?.['data-field-key'] === fieldId || node.props?.id === fieldId); assert.ok(field, `field ${fieldId}`); field.props.onInput({ target: { value }, detail: 0 }); await vue.nextTick(); };
  return { state, root, text: () => text(root), nodes, findButton, click, input, commands, shows, hides, loads, backs, focused, destinations, warnings, document: documentState, close() { try { app.unmount(); } catch (failure) { assert.fail(warnings.join(" | ") + " " + failure.message); } for (const fn of unloads) fn(); } };
}
test('actual native H5 fields preserve draft on error, associate labels and only explicit tap submits trimmed text', async () => {
  const h = await ui('pages/community/index.vue', initial());
  try {
    await h.click('写一篇帖子'); await h.input('forum-post-title', '短'); await h.input('forum-post-body', '正文'); assert.equal(h.commands.length, 0);
    await h.click('提交审核'); assert.equal(h.commands.length, 0); assert.ok(h.focused.some(value => value.startsWith('forum-post-title-field-'))); assert.match(h.text(), /请填写4至40字/);
    const field = h.nodes().find(node => node.props?.['data-field-key'] === 'forum-post-title'); assert.equal(field.type, 'input'); assert.equal(field.props['aria-invalid'], true); assert.equal(field.props['aria-describedby'], `${field.props.id}-help ${field.props.id}-error`);
    assert.ok(h.nodes().some(node => node.type === 'label' && node.props.for === field.props.id));
    assert.equal(h.nodes().filter(node => node.type === 'textarea').length, 1);
    await h.input('forum-post-title', '  今天的新收获  '); await h.input('forum-post-body', '  新鲜的蔬菜长得很不错。  '); assert.equal(h.commands.length, 0);
    await h.click('提交审核'); assert.deepEqual(h.commands, [{ action: 'submit-post', circle: 'harvest', title: '今天的新收获', body: '新鲜的蔬菜长得很不错。' }]); assert.ok(!h.nodes().some(node => node.type === 'input')); assert.deepEqual(h.warnings, []);
  } finally { h.close(); }
});
test('failed submission keeps private draft and app-owned navigation confirmation defaults to return', async () => {
  const h = await ui('pages/community/index.vue', initial(), { commandFarmForum: async () => false });
  try {
    h.shows.forEach(fn => fn()); await h.click('写一篇帖子'); await h.input('forum-post-title', '今天的新收获'); await h.input('forum-post-body', '新鲜的蔬菜长得很不错。'); await h.click('提交审核');
    assert.equal(h.nodes().find(node => node.props?.['data-field-key'] === 'forum-post-title').props.value, '今天的新收获'); await h.click('返回田园主页'); assert.deepEqual(h.destinations, []); assert.ok(h.focused.includes('forum-leave-cancel'));
    await h.click('返回，继续填写'); assert.ok(!h.text().includes('要放弃未提交')); await h.click('返回田园主页'); await h.click('放弃草稿并离开'); assert.deepEqual(h.destinations, ['home']);
  } finally { h.close(); }
});
test('actual detail comment uses current parent version and renders user text as plain text', async () => {
  const state = initial(); state.forumDetail.post.body = '<img src=x onerror=alert(1)>'; const h = await ui('pages/forum-post/index.vue', state);
  try {
    h.loads.forEach(fn => fn({ id })); await vue.nextTick(); await h.input('forum-comment-body', '  我的新鲜评论  '); assert.equal(h.commands.length, 0); await h.click('提交评论审核');
    assert.deepEqual(h.commands, [{ action: 'submit-comment', postId: id, expectedVersion: 2, body: '我的新鲜评论' }]); assert.match(h.text(), /<img src=x onerror=alert\(1\)>/); assert.ok(!h.nodes().some(node => node.type === 'img'));
  } finally { h.close(); }
});
test('production closes all forum writes and disabled friend card keeps own withdraw available', async () => {
  const h = await ui('pages/community/index.vue', initial({ forumStatus: status({ environment: 'production', available: false, canPost: false, alias: null }) }));
  try { assert.match(h.text(), /社区暂未开放/); assert.equal(h.nodes().filter(node => ['input', 'textarea'].includes(node.type)).length, 0); assert.equal(h.findButton('写一篇帖子'), undefined); } finally { h.close(); }
  const own = content({ author: { peerId, alias: '农友bbbbbbbb', self: true }, state: 'pending', version: 1, publishedAt: null });
  const mine = await ui('pages/community/index.vue', initial({ forumStatus: status({ canPost: false, alias: null }), forumPage: page({ scope: 'mine', items: [own] }) }));
  try { await mine.click('撤回这条帖子'); assert.equal(mine.commands.length, 0); await mine.click('确认撤回内容'); assert.deepEqual(mine.commands, [{ action: 'withdraw', contentId: id, expectedVersion: 1 }]); } finally { mine.close(); }
});
test('account changes clear drafts; block/report wait for explicit confirmation and fixed reason', async () => {
  const state = initial({ forumPage: page({ items: [content()] }) }), h = await ui('pages/community/index.vue', state);
  try {
    await h.click('举报这条内容'); assert.equal(h.commands.length, 0); await h.click('提交举报'); assert.deepEqual(h.commands[0], { action: 'report', contentId: id, expectedVersion: 2, reason: 'spam' });
    await h.click('屏蔽这位作者'); assert.equal(h.commands.length, 1); await h.click('确认屏蔽作者'); assert.equal(h.commands[1].action, 'block-author');
    await h.click('写一篇帖子'); await h.input('forum-post-title', '仍在内存的草稿'); state.snapshot = mobileSnapshot({ profile: { id: 'member-b' } }); await vue.nextTick(); assert.ok(!h.nodes().some(node => node.type === 'input'));
  } finally { h.close(); }
});

for (const kind of ['post', 'comment']) test(`shared confirmed-receipt shortcut warns before losing a dirty ${kind}, including subsequent tab navigation`, async () => {
  const core = await bridge(), state = initial({ confirmedCheckout: true });
  const h = await ui(kind === 'post' ? 'pages/community/index.vue' : 'pages/forum-post/index.vue', state, { realScreen: true, openConfirmedCheckout: () => core.core.openConfirmedCheckout() });
  try {
    h.loads.forEach(fn => fn({ id })); h.shows.forEach(fn => fn()); await vue.nextTick();
    if (kind === 'post') { await h.click('写一篇帖子'); await h.input('forum-post-title', '没有提交的帖子草稿'); await h.input('forum-post-body', '没有提交的正文内容。'); }
    else await h.input('forum-comment-body', '没有提交的评论草稿');
    await h.click('查看最近确认的兑换收据');
    assert.deepEqual(core.destinations, [], 'receipt navigation must wait for the app-owned warning');
    assert.match(h.text(), /要放弃未提交的草稿/); await h.click('返回，继续填写');
    assert.equal(h.nodes().find(node => node.type === (kind === 'post' ? 'input' : 'textarea')).props.value.includes('草稿'), true);
    await h.click('查看最近确认的兑换收据'); await h.click('放弃草稿并离开');
    assert.deepEqual(core.destinations, ['/pages/exchange/index?operation=last']);
    h.hides.forEach(fn => fn()); core.core.openShop(); assert.deepEqual(core.destinations, ['/pages/exchange/index?operation=last', '/pages/shop/index']);
    assert.equal(h.commands.length, 0, 'navigation does not submit the private draft');
  } finally { h.close(); }
});

test('cached detail pages use independent native field ids and hiding a page removes its action confirmation', async () => {
  const a = await ui('pages/forum-post/index.vue', initial()), b = await ui('pages/forum-post/index.vue', initial());
  try {
    a.loads.forEach(fn => fn({ id })); b.loads.forEach(fn => fn({ id })); await vue.nextTick();
    const first = a.nodes().find(node => node.type === 'textarea'), second = b.nodes().find(node => node.type === 'textarea');
    assert.notEqual(first.props.id, second.props.id, 'cached fields must not share a document id');
    assert.ok(a.nodes().some(node => node.type === 'label' && node.props.for === first.props.id));
    await a.click('举报这条内容'); await b.click('举报这条内容');
    const firstCancel = a.findButton('返回，暂不操作'), secondCancel = b.findButton('返回，暂不操作'); assert.notEqual(firstCancel.props.id, secondCancel.props.id);
    a.hides.forEach(fn => fn()); await vue.nextTick(); assert.equal(a.findButton('提交举报'), undefined); assert.ok(b.findButton('提交举报'));
  } finally { a.close(); b.close(); }
});

test('keyboard loading the final community page moves removed-button focus to its result status', async () => {
  const state = initial({ forumPage: page({ items: [content()], nextCursor: id }) });
  const h = await ui('pages/community/index.vue', state, { loadFarmForum: async () => { state.forumPage = page({ items: [content()], nextCursor: null }); return true; } });
  try {
    await h.click('加载更早记录', true); await vue.nextTick(); await vue.nextTick();
    assert.equal(h.findButton('加载更早记录'), undefined); assert.ok(h.focused.some(value => value?.startsWith('forum-list-result')));
  } finally { h.close(); }
});

test('keyboard loading final comments moves focus to the matching detail result', async () => {
  const state = initial(); state.forumDetail.nextCursor = id;
  const h = await ui('pages/forum-post/index.vue', state, { loadFarmForumPost: async () => { state.forumDetail = { ...state.forumDetail, nextCursor: null }; return true; } });
  try {
    h.loads.forEach(fn => fn({ id })); await vue.nextTick(); await h.click('加载更早评论', true); await vue.nextTick(); await vue.nextTick();
    assert.equal(h.findButton('加载更早评论'), undefined); assert.ok(h.focused.some(value => value?.startsWith('forum-comments-result')));
  } finally { h.close(); }
});

for (const behavior of ['pointer', 'failed', 'nonfinal', 'moved']) test(`community pagination ${behavior} does not steal focus`, async () => {
  const state = initial({ forumPage: page({ items: [content()], nextCursor: id }) }); let finish;
  const h = await ui('pages/community/index.vue', state, { loadFarmForum: () => new Promise(resolve => { finish = () => {
    if (behavior !== 'failed') state.forumPage = page({ items: [content()], nextCursor: behavior === 'nonfinal' ? peerId : null });
    resolve(behavior !== 'failed');
  }; }) });
  try {
    await h.click('加载更早记录', behavior !== 'pointer'); if (behavior === 'moved') h.document.activeElement = {};
    finish(); await vue.nextTick(); await vue.nextTick(); await vue.nextTick();
    assert.ok(!h.focused.some(value => value?.startsWith('forum-list-result')));
  } finally { h.close(); }
});
