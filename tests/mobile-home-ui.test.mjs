import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';
import * as navigation from '../apps/mobile/src/core/navigation.mjs';

const sourceFile = path => new URL(`../apps/mobile/src/${path}`, import.meta.url);
function evaluate(source, imports, globals = {}) {
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  return new Function('require', 'exports', ...Object.keys(globals), `${code}\nreturn exports;`)(name => {
    assert.ok(imports[name], `explicit import ${name}`);
    return name.endsWith('.vue') ? { default: imports[name] } : imports[name];
  }, {}, ...Object.values(globals));
}
async function component(path, imports = {}, globals = {}) {
  const source = (await readFile(sourceFile(path), 'utf8')).replace(/<!-- #ifndef H5 -->[\s\S]*?<!-- #endif -->/g, '');
  const descriptor = parse(source).descriptor;
  const script = compileScript(descriptor, { id: path, inlineTemplate: true, templateOptions: { compilerOptions: { isCustomElement: tag => ['view', 'text', 'image'].includes(tag) } } }).content;
  return evaluate(script, { vue, '../core/navigation.mjs': navigation, ...imports }, { HTMLElement: class {}, document: { activeElement: null }, ...globals }).default;
}
function mount(component, props = {}) {
  const renderer = vue.createRenderer({
    createElement: type => ({ type, props: {}, children: [] }), createText: text => ({ type: '#text', text }), createComment: () => ({ type: '#comment', text: '' }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, name, oldValue, value) => { node.props[name] = value; },
    remove(node) { const index = node.parent?.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); },
    insert(node, parent, anchor) {
      if (node.parent) { const index = node.parent.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); }
      node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    }
  });
  const root = { type: 'root', children: [] }, app = renderer.createApp(component, props);
  const warnings = []; app.config.warnHandler = message => warnings.push(message); app.mount(root);
  const nodes = () => { const result = []; function walk(node) { result.push(node); for (const child of node.children || []) walk(child); } walk(root); return result; };
  const text = node => (node.type === '#comment' ? '' : node.text || '') + (node.children || []).map(text).join('');
  return { root, nodes, text, warnings, close: () => app.unmount(), buttons: () => nodes().filter(node => node.type === 'button') };
}
const invisible = vue.defineComponent({ setup: () => () => null });
const button = await component('components/FarmButton.vue');

async function home(overrides = {}) {
  const state = vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), busy: false, pending: false, message: '', error: '', confirmedCheckout: false, ...overrides });
  const mutations = [], actions = [];
  const farm = { farmState: state, onFarmPageShow() {}, mutateFarm: (...args) => mutations.push(args), rewardLabel: reward => `${reward.points}积分`, openShop: () => actions.push('shop'), openFriends: () => actions.push('friends'), openCommunity: () => actions.push('community'), openProfile: () => actions.push('profile'), refreshFarm: () => actions.push('refresh'), retryFarmOperation: () => actions.push('retry'), openConfirmedCheckout() {} };
  const screen = await component('components/FarmScreen.vue', { '../core/farm': farm, './FarmButton.vue': button, './FarmNavigation.vue': invisible });
  const signIn = await component('components/FarmSignIn.vue', { '../core/farm': farm, './FarmButton.vue': button });
  const empty = await component('components/EmptyPanel.vue');
  const page = await component('pages/activities/index.vue', { '@dcloudio/uni-app': { onShow() {} }, '../../core/farm': farm, '../../components/FarmButton.vue': button, '../../components/FarmScreen.vue': screen, '../../components/EmptyPanel.vue': empty, '../../components/FarmSignIn.vue': signIn });
  const ui = mount(page);
  return { ...ui, state, mutations, actions, findButton: match => ui.buttons().find(node => { const name = node.props['aria-label'] || ui.text(node); return typeof match === 'string' ? name === match : match.test(name); }) };
}
function activate(node) { assert.ok(node, 'action exists'); node.props.onClick?.({ currentTarget: node }); }

test('central Home navigation keeps the account activity route and does not re-enter the selected tab', async () => {
  let route = 'pages/farm/index'; const switches = [], shows = [];
  const navigation = await component('components/FarmNavigation.vue', { './FarmButton.vue': button, '@dcloudio/uni-app': { onShow: fn => shows.push(fn) } }, { getCurrentPages: () => [{ route }], uni: { hideTabBar() {}, switchTab: options => switches.push(options.url) } });
  const ui = mount(navigation);
  try {
    const homeButton = ui.buttons().find(node => ui.text(node).endsWith('主页'));
    assert.ok(homeButton, 'Home has a visible, named primary entry');
    assert.deepEqual(ui.nodes().filter(node => node.type === 'image' && /-selected\.png$/.test(node.props.src)).map(node => node.props.src), ['/static/navigation/farm-selected.png']);
    activate(homeButton); assert.deepEqual(switches, ['/pages/activities/index']);
    route = 'pages/activities/index'; shows[0](); await vue.nextTick();
    assert.equal(homeButton.props['aria-current'], 'page');
    assert.deepEqual(ui.nodes().filter(node => node.type === 'image' && /-selected\.png$/.test(node.props.src)).map(node => node.props.src), ['/static/navigation/home-selected.png']);
    activate(homeButton); assert.equal(switches.length, 1, 'selected Home does not request another tab switch');
    assert.equal(ui.buttons().length, 5); assert.deepEqual(ui.warnings, []);
  } finally { ui.close(); }
});

test('account sign-in uses the shared reward transaction and preserves unknown-result blocking', async () => {
  const state = vue.reactive({ authenticated: true, snapshot: mobileSnapshot(), busy: false, pending: false });
  const mutations = [];
  const farm = { farmState: state, mutateFarm: (...args) => mutations.push(args) };
  const signIn = await component('components/FarmSignIn.vue', { '../core/farm': farm, './FarmButton.vue': button });
  const ui = mount(signIn, { showProgress: true });
  try {
    assert.equal(ui.nodes().filter(node => /sign-day(?:\s|$)/.test(node.props?.class || '')).length, 7);
    activate(ui.buttons()[0]); assert.deepEqual(mutations.map(args => [args[0], args[1]]), [['/activities/sign-in', {}]]);
    state.pending = true; await vue.nextTick(); assert.equal(ui.buttons()[0].props.disabled, true);
    activate(ui.buttons()[0]); assert.equal(mutations.length, 1);
    state.pending = false; state.snapshot.signIn.todayClaimed = true; await vue.nextTick();
    assert.equal(ui.buttons()[0].props.disabled, true); activate(ui.buttons()[0]); assert.equal(mutations.length, 1);
    state.snapshot.capabilities.activities = false; await vue.nextTick(); assert.equal(ui.buttons().length, 0);
    assert.deepEqual(ui.warnings, []);
  } finally { ui.close(); }
});

test('Home renders its brand and a labeled farm avatar, and uses the existing account sign-in transaction once', async () => {
  const h = await home();
  try {
    assert.equal(h.nodes().find(node => node.props?.['aria-level'] === '1')?.text, '合耕小舍');
    assert.ok(h.nodes().some(node => node.type === 'image' && node.props.src === '/static/photos/farm-estate.webp' && node.props['aria-label'] === '农庄头像'));
    activate(h.findButton(/^签到领取 /));
    assert.deepEqual(h.mutations.map(args => [args[0], args[1]]), [['/activities/sign-in', {}]]);
    h.state.snapshot.signIn.todayClaimed = true; h.state.snapshot.signIn.streak = 1; await vue.nextTick();
    const claimed = h.findButton('今日已签到，明天再来'); assert.equal(claimed.props.disabled, true);
    activate(claimed); assert.equal(h.mutations.length, 1, 'confirmed sign-in is unavailable for a second tap');
    assert.match(h.text(h.root), /帖子与评论通过审核才公开/);
    assert.ok(h.text(h.root).indexOf('进入田园圈子') < h.text(h.root).indexOf('今日活动'));
    activate(h.findButton('查看我的农友')); assert.deepEqual(h.actions, ['friends']); assert.equal(h.mutations.length, 1, 'opening friends does not award points or submit a relation');
    assert.deepEqual(h.warnings, []);
  } finally { h.close(); }
});

test('unopened production activities offer only friends status navigation without reward or relation writes', async () => {
  const snapshot = mobileSnapshot({ environment: 'production' }); snapshot.capabilities.activities = false;
  const h = await home({ snapshot });
  try {
    assert.match(h.text(h.root), /活动暂未开放/);
    assert.match(h.text(h.root), /正式服务暂未开放/);
    assert.match(h.text(h.root), /帖子与评论通过审核才公开/);
    assert.equal(h.buttons().length, 2, 'only navigation to closed social status pages is available');
    activate(h.findButton('查看我的农友')); assert.deepEqual(h.actions, ['friends']);
    assert.deepEqual(h.mutations, []);
  } finally { h.close(); }
});

test('busy and unknown-result states block every activity reward while growth uses the same server endpoint', async () => {
  const snapshot = mobileSnapshot();
  snapshot.tasks = [{ id: 'browse', title: '逛田园', description: '已浏览商城', reward: { points: 10 }, progress: 1, target: 1, ready: true, claimed: false }];
  snapshot.achievements = [{ id: 'care', title: '第一次照料', description: '完成一次照料', reward: { points: 25 }, progress: 1, target: 1, ready: true, claimed: false }];
  snapshot.season = { count: 3, total: 3, ready: true, claimed: false };
  const h = await home({ snapshot });
  try {
    for (const blocker of ['busy', 'pending']) {
      h.state[blocker] = true; await vue.nextTick();
      for (const name of [/^签到领取 /, '领取奖励', '领取今日丰收礼']) {
        const action = h.findButton(name); assert.equal(action.props.disabled, true); activate(action);
      }
      activate(h.findButton('成长成就')); await vue.nextTick();
      const growth = h.findButton('领取成就奖励'); assert.equal(growth.props.disabled, true); activate(growth);
      assert.equal(h.mutations.length, 0);
      h.state[blocker] = false; activate(h.findButton('今日活动')); await vue.nextTick();
    }
    activate(h.findButton('成长成就')); await vue.nextTick(); activate(h.findButton('领取成就奖励'));
    assert.deepEqual(h.mutations.map(args => [args[0], args[1]]), [['/activities/achievements/care/claim', {}]]);
  } finally { h.close(); }
});

test('confirmed season and achievement claims stay unavailable even if an old ready flag remains set', async () => {
  const snapshot = mobileSnapshot(); snapshot.season = { count: 3, total: 3, ready: true, claimed: true };
  snapshot.achievements = [{ id: 'care', title: '第一次照料', description: '完成一次照料', reward: { points: 25 }, progress: 1, target: 1, ready: true, claimed: true }];
  const h = await home({ snapshot });
  try {
    const season = h.findButton('今日丰收礼已领取'); assert.equal(season.props.disabled, true); activate(season);
    activate(h.findButton('成长成就')); await vue.nextTick();
    const achievement = h.findButton('已领取'); assert.equal(achievement.props.disabled, true); activate(achievement);
    assert.equal(h.mutations.length, 0);
  } finally { h.close(); }
});

test('Home keeps shared guest, unavailable-data, loading and error recovery states', async () => {
  for (const [overrides, expected, action] of [
    [{ authenticated: false, snapshot: null }, /登录后查看认养/, '登录我的田园'],
    [{ authenticated: true, snapshot: null }, /暂未取得田园数据/, '重新加载'],
    [{ busy: true, error: '网络连接暂不可用' }, /正在同步田园数据/, '刷新田园数据']
  ]) {
    const h = await home(overrides);
    try {
      assert.match(h.text(h.root), expected); assert.ok(h.findButton(action));
      if (overrides.error) { assert.match(h.text(h.root), /网络连接暂不可用/); assert.equal(h.findButton(action).props.disabled, true); }
      if (overrides.snapshot === null) assert.ok(h.findButton(/^签到领取 /) === undefined, 'no sign-in action is available without an account snapshot');
    } finally { h.close(); }
  }
});
