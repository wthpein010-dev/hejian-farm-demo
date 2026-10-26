import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configFromEnvironment } from '../src/config.mjs';

let implementation = {};
try { implementation = await import('../src/providers.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const credentials = { appId: 'example-application-id', secret: 'example-secret-only' };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function providers(configuration, options) {
  assert.equal(typeof implementation.createPlatformProviders, 'function', 'fixed official HTTPS providers must exist');
  return implementation.createPlatformProviders(configuration, options);
}
const subject = (appId, openid) => createHash('sha256').update(appId + '\0' + openid).digest('hex');

test('Weixin exchanges only at its fixed HTTPS endpoint and discards code, session key and raw openid', async () => {
  let calls = 0;
  const p = providers({ weixin: credentials }, { fetchImpl: async (target, init) => {
    calls++;
    const url = new URL(target);
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.deepEqual(Object.fromEntries(url.searchParams), { appid: credentials.appId, secret: credentials.secret,
      js_code: 'example-one-time-code', grant_type: 'authorization_code' });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    return response({ openid: 'example-user-openid', session_key: 'example-sensitive-session-key', unionid: 'not-returned' });
  } });
  const result = await p.weixin({ code: 'example-one-time-code' });
  assert.deepEqual(result, { subject: subject(credentials.appId, 'example-user-openid') });
  assert.equal(calls, 1); assert.equal(Object.hasOwn(result, 'session_key'), false);
});

test('Toutiao uses the currently documented POST host and validates err_no plus non-anonymous openid', async () => {
  const p = providers({ toutiao: credentials }, { fetchImpl: async (target, init) => {
    assert.equal(String(target), 'https://developer.toutiao.com/api/apps/v2/jscode2session');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { appid: credentials.appId, secret: credentials.secret, code: 'example-toutiao-code' });
    return response({ err_no: 0, err_tips: 'success', data: { openid: 'example-toutiao-user', session_key: 'not-returned' } });
  } });
  assert.deepEqual(await p.toutiao({ code: 'example-toutiao-code' }), { subject: subject(credentials.appId, 'example-toutiao-user') });
});

test('openid identity is namespaced to its application instead of merging different apps', async () => {
  const options = { fetchImpl: async () => response({ errcode: 0, openid: 'same-provider-openid' }) };
  const a = providers({ weixin: credentials }, options);
  const b = providers({ weixin: { ...credentials, appId: 'second-example-application' } }, options);
  assert.notEqual((await a.weixin({ code: 'code-one' })).subject, (await b.weixin({ code: 'code-two' })).subject);
});

test('unconfigured providers stay absent and partial or endpoint-override credentials fail closed', () => {
  assert.deepEqual(providers({}), {});
  assert.throws(() => providers({ weixin: { appId: 'example-only-app-id' } }), /配置|凭据/);
  assert.throws(() => providers({ weixin: { ...credentials, url: 'http://untrusted.example' } }), /配置|凭据/);
  assert.throws(() => configFromEnvironment({ FARM_WEIXIN_APP_ID: 'example-only-app-id' }), /配置|凭据/);
  const configured = configFromEnvironment({ FARM_WEIXIN_APP_ID: credentials.appId, FARM_WEIXIN_APP_SECRET: credentials.secret });
  assert.equal(typeof configured.platformProviders.weixin, 'function');
  assert.equal(Object.hasOwn(configured, 'secret'), false);
});

test('official error codes and missing or malformed openid are rejected without exposing raw errors', async () => {
  const cases = [
    ['weixin', { errcode: 40029, errmsg: 'example-secret-only invalid-code-raw' }, 401],
    ['weixin', { errcode: 40226, errmsg: 'blocked-raw' }, 401],
    ['weixin', { errcode: -1, errmsg: 'example-secret-only' }, 502],
    ['weixin', { errcode: '0', openid: 'example-user' }, 502],
    ['weixin', { errcode: 0, session_key: 'not-an-identity' }, 502],
    ['weixin', { openid: '' }, 502],
    ['toutiao', { err_no: 40018, err_tips: 'example-secret-only code-raw' }, 401],
    ['toutiao', { err_no: 40017, err_tips: 'example-secret-only' }, 502],
    ['toutiao', { data: { openid: 'missing-status-code' } }, 502],
    ['toutiao', { err_no: 0, data: { anonymous_openid: 'anonymous-only' } }, 502],
    ['toutiao', { err_no: 0, data: { openid: '<script>' } }, 502],
  ];
  for (const [platform, payload, status] of cases) {
    const p = providers({ [platform]: credentials }, { fetchImpl: async () => response(payload) });
    await assert.rejects(p[platform]({ code: 'example-code' }), error => {
      assert.equal(error.status, status); assert.equal(error.message.includes('example-secret-only'), false);
      assert.equal(error.message.includes('raw'), false); assert.equal(error.cause, undefined); return true;
    });
  }
});

test('HTTP errors, redirects, invalid JSON and oversized declared or streamed responses fail safely', async () => {
  const responses = [
    () => new Response('upstream-secret-detail', { status: 500 }),
    () => new Response('', { status: 302, headers: { Location: 'http://untrusted.example' } }),
    () => new Response('{invalid-upstream-secret-detail'),
    () => new Response('{"openid":"example-user"}', { headers: { 'Content-Length': '999999' } }),
    () => new Response('x'.repeat(17000)),
    () => response(['unexpected-object']),
  ];
  for (const makeResponse of responses) {
    const p = providers({ weixin: credentials }, { fetchImpl: async () => makeResponse() });
    await assert.rejects(p.weixin({ code: 'example-code' }), error => {
      assert.equal(error.status, 502); assert.equal(error.message.includes('upstream-secret-detail'), false); return true;
    });
  }
});

test('provider timeout aborts an unresponsive fetch and a stalled response stream', async () => {
  let signal;
  const stalledFetch = providers({ weixin: credentials }, { timeoutMs: 100, fetchImpl: async (_url, init) => {
    signal = init.signal; return new Promise(() => {});
  } });
  await assert.rejects(stalledFetch.weixin({ code: 'example-code' }), error => error.status === 502);
  assert.equal(signal.aborted, true);
  const stalledBody = providers({ weixin: credentials }, { timeoutMs: 100, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
  })) });
  await assert.rejects(stalledBody.weixin({ code: 'another-example-code' }), error => error.status === 502);
});

test('fetch exceptions containing an official URL and credentials are replaced with safe public errors', async () => {
  const p = providers({ weixin: credentials }, { fetchImpl: async target => { throw new Error('secret URL: ' + String(target)); } });
  await assert.rejects(p.weixin({ code: 'example-private-code' }), error => {
    assert.equal(error.message.includes(credentials.secret), false); assert.equal(error.message.includes('example-private-code'), false);
    assert.equal(error.message.includes('api.weixin.qq.com'), false); assert.equal(error.cause, undefined); return true;
  });
});
