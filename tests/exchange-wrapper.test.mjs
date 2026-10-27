import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import * as appNavigation from '../apps/mobile/src/core/navigation.mjs';
import * as clientModule from '../apps/mobile/src/core/client.mjs';
import { createExchangePage, createExchangeDetail } from '../shared/exchanges.mjs';
import { mobileSnapshot } from './helpers/mobile-snapshot.mjs';

const scope = { ownerId: 'member-a', environment: 'development', serverTime: 1793044800000 };
const ok = data => ({ status: 200, data: { data } });
function purchase(n = 1) {
  const receiptId = `api-${n.toString(16).padStart(64, '0')}`;
  return { id: `shop-${receiptId}`, receiptId, day: '2026-10-27', items: [{ id: 'feed-pack', title: '历史饲料', art: 'feed', cost: 30, quantity: 1, lineTotal: 30, grant: { feed: 3 } }], count: 1, subtotal: 30, discount: 0, total: 30, couponId: null };
}
const page = (records = [purchase()], cursor = 'start') => createExchangePage(records, { ...scope, cursor });
const detail = () => createExchangeDetail(purchase(), scope);
async function harness() {
  const calls = [], replies = [], navigation = []; let pages = [{ route: 'pages/exchanges/index' }, { route: 'pages/exchange/index' }];
  const client = clientModule.createFarmClient({ baseURL: 'http://127.0.0.1:8787', generateKey: () => 'private-checkout-key-123', transport: async request => {
    calls.push(structuredClone(request)); const reply = replies.shift(); assert.ok(reply, 'explicit response required'); if (reply instanceof Error) throw reply; return reply;
  } });
  const source = await readFile(new URL('../apps/mobile/src/core/farm.ts', import.meta.url), 'utf8');
  const code = ts.transpile(source.replaceAll('import.meta.env', '__testEnv'), { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
  const imports = { vue, './client.mjs': { ...clientModule, createFarmClient: () => client }, './navigation.mjs': appNavigation };
  const core = new Function('require', 'exports', '__testEnv', 'uni', 'getCurrentPages', `${code}\nreturn exports;`)(name => { assert.ok(imports[name], `explicit import ${name}`); return imports[name]; }, {}, { DEV: true }, {
    navigateTo: options => navigation.push(['to', options.url]), navigateBack: options => navigation.push(['back', options.delta]), switchTab: options => navigation.push(['tab', options.url])
  }, () => pages);
  async function login(id = 'member-a', bootstrap = true) {
    replies.push(ok({ token: `token-${id}`, profile: { id } })); await client.loginDevelopment('synthetic-member');
    if (bootstrap) { replies.push(ok(mobileSnapshot({ profile: { id } }))); await client.load(); }
  }
  return { client, core, calls, replies, navigation, login, setPages(value) { pages = value; } };
}

test('exchange wrapper keeps all loaded pages and valid old data after a read failure', async () => {
  const h = await harness(); await h.login(); const records = Array.from({ length: 23 }, (_, i) => purchase(i + 1));
  h.replies.push(ok(page(records))); assert.equal(await h.core.loadExchangeHistory(), true);
  const cursor = h.core.farmState.exchangeHistory.nextCursor;
  h.replies.push(ok(page(records, cursor))); assert.equal(await h.core.loadExchangeHistory(cursor), true);
  assert.equal(h.core.farmState.exchangeHistory.items.length, 23);
  h.replies.push(new Error('offline')); assert.equal(await h.core.loadExchangeHistory(), false);
  assert.equal(h.core.farmState.exchangeHistory.items.length, 23); assert.ok(h.core.farmState.exchangeHistoryError); assert.equal(h.core.farmState.exchangeHistoryBusy, false);
});

for (const kind of ['history', 'record']) test(`obsolete exchange ${kind} bootstrap cannot cancel a newer selection`, async () => {
  const h = await harness(); await h.login('member-a', false); let older, current, read;
  h.replies.push(new Promise(resolve => { older = resolve; }), new Promise(resolve => { current = resolve; }), new Promise(resolve => { read = resolve; }));
  const load = () => kind === 'history' ? h.core.loadExchangeHistory() : h.core.loadExchangeRecord(purchase().id);
  const first = load(), second = load(); current(ok(mobileSnapshot())); await new Promise(resolve => setImmediate(resolve));
  older(ok(mobileSnapshot())); assert.equal(await first, false);
  assert.equal(h.calls.filter(call => /\/account\/exchange/.test(call.url)).length, 1);
  read(ok(kind === 'history' ? page() : detail())); assert.equal(await second, true);
});

test('exchange wrapper clears receipts, pages and shortcut on expired session and account change', async () => {
  const h = await harness(); await h.login();
  h.replies.push(ok(mobileSnapshot({ revision: 4 }))); await h.core.mutateFarm('/checkout');
  assert.equal(h.core.farmState.confirmedCheckout, true);
  h.replies.push(ok(page())); await h.core.loadExchangeHistory(); h.replies.push(ok(detail())); await h.core.loadExchangeRecord('last');
  h.replies.push({ status: 401, data: { error: { code: 'SESSION_EXPIRED', message: '会话已过期' } } }); await h.core.loadExchangeHistory();
  assert.equal(h.core.farmState.exchangeHistory, null); assert.equal(h.core.farmState.exchangeRecord, null); assert.equal(h.core.farmState.confirmedCheckout, false);
  await h.login('member-b'); h.replies.push(ok({ ...page([]), ownerId: 'member-b' })); await h.core.loadExchangeHistory();
  assert.equal(h.core.farmState.exchangeHistory.items.length, 0); assert.equal(h.core.farmState.exchangeRecordError, '');
});

test('late exchange detail and its error cannot leak into another account', async () => {
  const h = await harness(); await h.login(); let finish;
  h.replies.push(new Promise(resolve => { finish = resolve; })); const old = h.core.loadExchangeRecord(purchase().id);
  await h.login('member-b'); h.replies.push(ok({ ...page([]), ownerId: 'member-b' })); await h.core.loadExchangeHistory();
  finish(ok(detail())); assert.equal(await old, false);
  assert.equal(h.core.farmState.exchangeRecord, null); assert.equal(h.core.farmState.exchangeRecordError, ''); assert.equal(h.core.farmState.exchangeRecordBusy, false);
});

test('confirmed navigation contains no operation key and detail return preserves the stack', async () => {
  const h = await harness(); h.core.openConfirmedCheckout(); h.core.openExchangeRecord(purchase().id); h.core.openExchangeRecord('../other'); h.core.returnFromExchange();
  assert.deepEqual(h.navigation, [['to', '/pages/exchange/index?operation=last'], ['to', `/pages/exchange/index?id=${purchase().id}`], ['back', 1]]);
  h.setPages([{ route: 'pages/exchange/index' }]); h.core.returnFromExchange(); assert.deepEqual(h.navigation.at(-1), ['tab', '/pages/profile/index']);
});

test('history and inventory links reuse existing pages instead of growing navigation loops', async () => {
  const h = await harness(); h.core.openExchangeHistory();
  assert.deepEqual(h.navigation.at(-1), ['back', 1]);
  h.setPages([{ route: 'pages/profile/index' }, { route: 'pages/inventory/index' }, { route: 'pages/exchange/index' }]);
  h.core.openInventory(); assert.deepEqual(h.navigation.at(-1), ['back', 1]);
  h.setPages([{ route: 'pages/profile/index' }]); h.core.openExchangeHistory(); assert.deepEqual(h.navigation.at(-1), ['to', '/pages/exchanges/index']);
});
