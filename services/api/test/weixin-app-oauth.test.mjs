import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformProviders, PlatformIdentityError } from '../src/providers.mjs';
import { configFromEnvironment, normalizeConfig } from '../src/config.mjs';

let implementation = {};
try { implementation = await import('../src/weixin-app-oauth.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

// All credentials, codes and identities in this file are synthetic.
const credentials = { appId: 'synthetic-native-app', secret: 'synthetic-native-secret' };
const code = 'synthetic-private-code';
const payload = {
  access_token: 'synthetic-access-token', expires_in: 7200, refresh_token: 'synthetic-refresh-token',
  openid: 'synthetic-openid', scope: 'snsapi_userinfo', unionid: 'synthetic-unionid',
};
const expectedIdentity = {
  provider: 'weixin-app', identityNamespace: 'ad1438b992370302ece44ee5b761c67734ba8ad42a37499d3684493cdccda48b',
  subject: '6de934fa403253528462dbd4b3ba326af11babb895821af2712e7befb138cd26',
  unionIdentity: { namespace: null, digest: 'd081ff24f75697bb6a7dce3bfc9f2035bc651c6fc74bbaf5c99b3b3573d990d2' },
};
const response = value => new Response(JSON.stringify(value));
function exchange(options = {}, values = credentials) {
  assert.equal(typeof implementation.createWeixinAppOAuthExchange, 'function', 'independent App OAuth exchange must exist');
  return implementation.createWeixinAppOAuthExchange(values, options);
}
function safeFailure(status = 502) {
  return error => {
    assert.ok(error instanceof PlatformIdentityError);
    assert.equal(error.status, status);
    assert.equal(error.code, status === 401 ? 'PLATFORM_CODE_REJECTED' : 'IDENTITY_PROVIDER_FAILED');
    assert.equal(error.cause, undefined);
    const serialized = error.message + JSON.stringify(error);
    for (const privateValue of [credentials.secret, code, payload.access_token, payload.refresh_token,
      payload.openid, payload.unionid, 'api.weixin.qq.com', 'raw-private-detail']) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
    return true;
  };
}

test('App OAuth exchanges only at its official endpoint and returns a private frozen identity projection', async () => {
  let calls = 0;
  const run = exchange({ fetchImpl: async (target, init) => {
    calls++;
    const url = new URL(target);
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/oauth2/access_token');
    assert.deepEqual([...url.searchParams].sort(), [
      ['appid', 'synthetic-native-app'], ['code', 'synthetic-private-code'],
      ['grant_type', 'authorization_code'], ['secret', 'synthetic-native-secret'],
    ]);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Accept, 'application/json'); assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return response({ ...payload, errcode: 0, extra_upstream: 'raw-private-detail' });
  } });
  assert.equal(calls, 0, 'construction must not contact a platform');
  assert.equal(run.identityNamespace, expectedIdentity.identityNamespace);
  const identity = await run({ code });
  assert.deepEqual(identity, expectedIdentity); assert.equal(calls, 1);
  assert.ok(Object.isFrozen(identity)); assert.ok(Object.isFrozen(identity.unionIdentity));
  assert.throws(() => { run.identityNamespace = 'replacement'; }, TypeError);
  for (const privateValue of [credentials.secret, code, payload.access_token, payload.refresh_token, payload.openid, payload.unionid]) {
    assert.equal(JSON.stringify(identity).includes(privateValue), false, privateValue);
  }
});

test('same openid in different App namespaces remains distinct even with matching unscoped UnionID', async () => {
  const a = await exchange({ fetchImpl: async () => response(payload) })({ code });
  const b = await exchange({ fetchImpl: async () => response(payload) }, { ...credentials, appId: 'synthetic-other-app' })({ code });
  assert.equal(b.identityNamespace, '7a9c6e1d47eaab4fa2b02db55c5970ad12ffd7871d2eab4bf8ed84e98aa098ae');
  assert.equal(b.subject, '04f7eece99fb47dd0bbfbff964de182f84b82cb4f56d4dd0ec476b337e6693dd');
  assert.notEqual(a.subject, b.subject); assert.deepEqual(a.unionIdentity, b.unionIdentity);
  assert.equal(b.unionIdentity.namespace, null, 'no verified Open Platform namespace or merge authorization');
});

test('platform tokens never select identity and a missing UnionID is explicitly represented as null', async () => {
  const { unionid: _discarded, ...withoutUnion } = payload;
  const identity = await exchange({ fetchImpl: async () => response({ ...withoutUnion,
    access_token: 'different-access-token', refresh_token: 'different-refresh-token', scope: 'snsapi_base,snsapi_userinfo' }) })({ code });
  assert.deepEqual(identity, { ...expectedIdentity, unionIdentity: null });
});

test('credentials are complete bounded ASCII data and cannot override the destination', () => {
  for (const values of [undefined, null, [], {}, { appId: credentials.appId }, { secret: credentials.secret },
    { ...credentials, appId: '' }, { ...credentials, secret: '' }, { ...credentials, appId: 'x'.repeat(129) },
    { ...credentials, secret: 'x'.repeat(513) }, { ...credentials, appId: '中文' }, { ...credentials, secret: 'space secret' },
    { ...credentials, secret: 'secret\n' }, { ...credentials, url: 'https://untrusted.invalid' },
    Object.create(credentials)]) {
    // Call the factory directly so an explicit undefined cannot use this test helper's default credentials.
    assert.equal(typeof implementation.createWeixinAppOAuthExchange, 'function', 'independent App OAuth exchange must exist');
    assert.throws(() => implementation.createWeixinAppOAuthExchange(values, { fetchImpl: async () => response(payload) }), TypeError);
  }
});

test('exchange options reject unknown keys and invalid request budgets before any exchange', () => {
  for (const options of [null, [], { url: 'https://untrusted.invalid' }, { retries: 1 }, { fetchImpl: false },
    { timeoutMs: 99 }, { timeoutMs: 10001 }, { timeoutMs: 100.5 }, { maxResponseBytes: 255 },
    { maxResponseBytes: 65537 }, { maxResponseBytes: NaN }]) {
    assert.throws(() => exchange(options), TypeError);
  }
});

test('invalid authorization code never sends a platform request', async () => {
  let calls = 0;
  const run = exchange({ fetchImpl: async () => { calls++; return response(payload); } });
  for (const value of [undefined, null, 1, '', 'x'.repeat(4097), 'line\ncode', 'zero\0code', 'delete\x7fcode']) {
    await assert.rejects(run({ code: value }), safeFailure(401));
  }
  assert.equal(calls, 0);
});

const malformedSuccesses = [
  ['missing openid', { openid: undefined }], ['empty openid', { openid: '' }], ['unsafe openid', { openid: '<openid>' }],
  ['long openid', { openid: 'x'.repeat(129) }], ['token is not openid', { openid: undefined, access_token: 'synthetic-openid' }],
  ['missing access token', { access_token: undefined }], ['empty access token', { access_token: '' }],
  ['nonstring access token', { access_token: {} }], ['control access token', { access_token: 'token\n' }],
  ['long access token', { access_token: 'x'.repeat(4097) }], ['missing refresh token', { refresh_token: undefined }],
  ['empty refresh token', { refresh_token: '' }], ['long refresh token', { refresh_token: 'x'.repeat(4097) }],
  ['missing expiry', { expires_in: undefined }], ['zero expiry', { expires_in: 0 }], ['negative expiry', { expires_in: -1 }],
  ['string expiry', { expires_in: '7200' }], ['fractional expiry', { expires_in: 1.5 }],
  ['unsafe expiry', { expires_in: Number.MAX_SAFE_INTEGER + 1 }], ['missing scope', { scope: undefined }],
  ['empty scope', { scope: '' }], ['different scope', { scope: 'snsapi_base' }],
  ['scope substring', { scope: 'prefix_snsapi_userinfo' }], ['malformed scope', { scope: 'snsapi_userinfo\n' }],
  ['long scope', { scope: 'snsapi_userinfo,' + 'x'.repeat(1024) }], ['null unionid', { unionid: null }],
  ['empty unionid', { unionid: '' }], ['unsafe unionid', { unionid: '<unionid>' }],
  ['long unionid', { unionid: 'x'.repeat(129) }], ['object unionid', { unionid: {} }],
];
for (const [name, changes] of malformedSuccesses) {
  test(`App OAuth rejects ${name} instead of issuing an identity`, async () => {
    await assert.rejects(exchange({ fetchImpl: async () => response({ ...payload, ...changes }) })({ code }), safeFailure());
  });
}

for (const [name, result, status] of [
  ['invalid code', { errcode: 40029, errmsg: 'raw-private-detail ' + credentials.secret }, 401],
  ['unknown upstream failure', { errcode: -1, errmsg: 'raw-private-detail' }, 502],
  ['mini-program classification not inherited', { errcode: 40226, errmsg: 'raw-private-detail' }, 502],
  ['used code classification not guessed', { errcode: 40163, errmsg: 'raw-private-detail' }, 502],
  ['string success marker', { ...payload, errcode: '0' }, 502],
  ['null success marker', { ...payload, errcode: null }, 502],
  ['fractional failure marker', { ...payload, errcode: 0.5 }, 502],
]) {
  test(`App OAuth handles ${name} with a sanitized fixed error and no retry`, async () => {
    let calls = 0;
    const run = exchange({ fetchImpl: async () => { calls++; return response(result); } });
    await assert.rejects(run({ code }), safeFailure(status)); assert.equal(calls, 1);
  });
}

test('HTTP errors, redirects, invalid JSON and partial or invalid UTF-8 responses fail closed', async () => {
  for (const makeResponse of [
    () => new Response('raw-private-detail', { status: 500 }),
    () => new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid' } }),
    () => new Response(null, { status: 200 }),
    () => new Response('{"openid":"partial'),
    () => new Response(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])),
    () => new Response(new Uint8Array([0x7b, 0x22, 0x65, 0xe5, 0x86])),
    () => response(null), () => response([]), () => response('not an object'),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('raw-private-detail')); } })),
  ]) {
    await assert.rejects(exchange({ fetchImpl: async () => makeResponse() })({ code }), safeFailure());
  }
});

test('declared and actual streaming budgets both reject oversized bodies and cancel unread content', async () => {
  let declaredCancelled = false, streamCancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { headers: { 'Content-Length': '16385' } });
  await assert.rejects(exchange({ fetchImpl: async () => declared })({ code }), safeFailure());
  assert.equal(declaredCancelled, true);
  const streamed = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(16385))); },
    cancel() { streamCancelled = true; },
  }));
  await assert.rejects(exchange({ fetchImpl: async () => streamed })({ code }), safeFailure());
  assert.equal(streamCancelled, true);
  for (const length of ['invalid', '-1', '999999999999999999999999999999']) {
    await assert.rejects(exchange({ fetchImpl: async () => new Response(JSON.stringify(payload), { headers: { 'Content-Length': length } }) })({ code }), safeFailure());
  }
  await assert.rejects(exchange({ maxResponseBytes: 256, fetchImpl: async () => response({ ...payload, extra: 'x'.repeat(256) }) })({ code }), safeFailure());
});

test('default response budget permits a bounded OAuth payload and explicitly configured budgets are honored', async () => {
  const large = { ...payload, extra: 'x'.repeat(17000) };
  await assert.rejects(exchange({ fetchImpl: async () => response(large) })({ code }), safeFailure());
  assert.deepEqual(await exchange({ maxResponseBytes: 20000, fetchImpl: async () => response(large) })({ code }), expectedIdentity);
});

test('deadline aborts an unresponsive fetch and never retries the code', async () => {
  let observedSignal, calls = 0;
  const run = exchange({ timeoutMs: 100, fetchImpl: async (_target, init) => {
    calls++; observedSignal = init.signal; return new Promise(() => {});
  } });
  await assert.rejects(run({ code }), safeFailure());
  assert.equal(observedSignal.aborted, true); assert.equal(calls, 1);
});

test('deadline covers a stalled body after successful response headers and cancels the reader', async () => {
  let cancelled = false;
  const run = exchange({ timeoutMs: 100, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(run({ code }), safeFailure()); assert.equal(cancelled, true);
});

test('already aborted caller does not send a platform request or expose its reason', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort(new Error('raw-private-detail ' + credentials.secret));
  const run = exchange({ fetchImpl: async () => { calls++; return response(payload); } });
  await assert.rejects(run({ code, signal: controller.signal }), safeFailure()); assert.equal(calls, 0);
});

test('caller abort promptly rejects even if a transport ignores its signal and late results cannot issue an identity', async () => {
  let finishFetch, enteredFetch;
  const entered = new Promise(resolve => { enteredFetch = resolve; });
  const controller = new AbortController();
  const run = exchange({ timeoutMs: 1000, fetchImpl: async () => {
    enteredFetch(); return new Promise(resolve => { finishFetch = resolve; });
  } });
  const result = run({ code, signal: controller.signal });
  await entered;
  const failure = assert.rejects(result, safeFailure());
  controller.abort(new Error('raw-private-detail'));
  const outcome = await Promise.race([failure.then(() => 'cancelled'), new Promise(resolve => setTimeout(() => resolve('waiting'), 100))]);
  assert.equal(outcome, 'cancelled');
  finishFetch(response(payload));
  await failure;
});

test('caller abort cancels response streaming and never returns a partially read identity', async () => {
  let enteredBody, cancelled = false;
  const entered = new Promise(resolve => { enteredBody = resolve; });
  const controller = new AbortController();
  const run = exchange({ timeoutMs: 1000, fetchImpl: async () => new Response(new ReadableStream({
    pull(stream) { stream.enqueue(new TextEncoder().encode('{')); enteredBody(); return new Promise(() => {}); },
    cancel() { cancelled = true; },
  })) });
  const result = run({ code, signal: controller.signal });
  await entered; const failure = assert.rejects(result, safeFailure()); controller.abort();
  await failure; assert.equal(cancelled, true);
});

test('transport exceptions and invalid caller signal never expose private URL or upstream exception details', async () => {
  const run = exchange({ fetchImpl: async target => { throw new Error('raw-private-detail ' + String(target), { cause: payload }); } });
  await assert.rejects(run({ code }), safeFailure());
  await assert.rejects(run({ code, signal: {} }), safeFailure());
});

test('App factory does not add a platform provider, environment fallback or account-capable route configuration', () => {
  exchange({ fetchImpl: async () => response(payload) });
  assert.deepEqual(createPlatformProviders({}), {});
  assert.throws(() => createPlatformProviders({ 'weixin-app': credentials }), TypeError);
  assert.throws(() => normalizeConfig({ platformProviders: { 'weixin-app': async () => expectedIdentity } }), TypeError);
  const config = configFromEnvironment({ FARM_WEIXIN_NATIVE_APP_ID: credentials.appId, FARM_WEIXIN_NATIVE_APP_SECRET: credentials.secret });
  assert.deepEqual(config.platformProviders, {});
});
