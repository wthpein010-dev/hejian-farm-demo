import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createApp } from '../src/server.mjs';
import { normalizeConfig, configFromEnvironment } from '../src/config.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';

const NOW = Date.parse('2026-10-27T08:00:00Z');
async function fixture(t, options = {}) {
  const app = createApp({ mode: 'development', allowDevelopmentAuth: true, databasePath: ':memory:', clock: () => NOW,
    developmentAuthLimit: { maxAttempts: 1, windowMs: 60000 }, ...options });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${await listenOnFetchSafePort(app.server)}`;
  const send = (headers = {}, route = '/api/v1/auth/development', target = base) => new Promise((resolve, reject) => {
    const body = route === '/api/v1/auth/development' ? JSON.stringify({ account: 'proxy-reviewer' }) : undefined;
    const outgoing = httpRequest(target + route, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers,
    }, signal: AbortSignal.timeout(5000) }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        json: JSON.parse(text), text }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
  return { app, base, send };
}

test('untrusted peers cannot change login buckets with any forwarding header', async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ 'X-Forwarded-For': '198.51.100.10' })).status, 200);
  const denied = await f.send({ 'X-Forwarded-For': 'malformed,injected', 'X-Real-IP': '198.51.100.11', Forwarded: 'for=198.51.100.12' });
  assert.equal(denied.status, 429);
  assert.equal(denied.json.error.code, 'RATE_LIMITED');
});

test('explicit trusted upstream separates clients while mapped addresses share one login bucket', async t => {
  const f = await fixture(t, { trustedProxyCidrs: ['127.0.0.1/32'] });
  assert.equal((await f.send({ 'X-Forwarded-For': '198.51.100.10' })).status, 200);
  assert.equal((await f.send({ 'X-Forwarded-For': '::ffff:198.51.100.10' })).status, 429);
  assert.equal((await f.send({ 'X-Forwarded-For': '198.51.100.11' })).status, 200);
});

test('rightmost untrusted hop determines both request limits and an attacker prefix cannot change it', async t => {
  const f = await fixture(t, { trustedProxyCidrs: ['127.0.0.1/32', '203.0.113.7/32'],
    requestRateLimit: { maxRequests: 2, windowMs: 60000 } });
  const request = value => f.send({ 'X-Forwarded-For': value }, '/api/v1/bootstrap');
  assert.equal((await request('192.0.2.20, 198.51.100.10, 203.0.113.7')).status, 401);
  assert.equal((await request('192.0.2.21, 198.51.100.10, 203.0.113.7')).status, 401);
  const limited = await request('192.0.2.22, 198.51.100.10, 203.0.113.7');
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await request('198.51.100.11, 203.0.113.7')).status, 401);
  for (let i = 0; i < 4; i++) assert.equal((await f.send({}, '/readyz')).status, 200);
});

test('malformed or duplicate trusted forwarding headers fail without echoing input or putting addresses in logs', async t => {
  const events = [];
  const f = await fixture(t, { trustedProxyCidrs: ['127.0.0.1/32'], logger: event => events.push(event) });
  for (const value of ['', 'private-proxy-input.invalid', '198.51.100.10:443', '198.51.100.10,,203.0.113.7',
    ['198.51.100.10', '198.51.100.11'], Array(33).fill('198.51.100.10').join(',')]) {
    const result = await f.send({ 'X-Forwarded-For': value });
    assert.equal(result.status, 400); assert.equal(result.json.error.code, 'INVALID_PROXY_HEADER');
    assert.ok(!result.text.includes('private-proxy-input') && !result.text.includes('198.51.100.10'));
  }
  assert.equal((await f.send()).status, 200, 'invalid headers do not consume a valid client login');
  const serialized = JSON.stringify(events);
  for (const marker of ['198.51.100.', '127.0.0.1', 'private-proxy-input', 'X-Forwarded-For']) assert.ok(!serialized.includes(marker));
});

test('actual forwarding server strips inbound spoofed identities and shares the real peer bucket', async t => {
  const f = await fixture(t, { trustedProxyCidrs: ['127.0.0.1/32'] });
  const proxy = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers };
    for (const field of ['x-forwarded-for', 'forwarded', 'x-real-ip']) delete headers[field];
    headers['x-forwarded-for'] = incoming.socket.remoteAddress;
    const forwarded = httpRequest(f.base + incoming.url, { method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forwarded.on('error', () => { outgoing.writeHead(502); outgoing.end('{}'); }); incoming.pipe(forwarded);
  });
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const proxyBase = `http://127.0.0.1:${await listenOnFetchSafePort(proxy)}`;
  assert.equal((await f.send({ 'X-Forwarded-For': '198.51.100.10' }, undefined, proxyBase)).status, 200);
  assert.equal((await f.send({ 'X-Forwarded-For': '198.51.100.11' }, undefined, proxyBase)).status, 429);
});

test('proxy configuration is explicit and environment configuration cannot silently accept invalid trust', () => {
  for (const trustedProxyCidrs of [null, '127.0.0.1', ['*'], ['0.0.0.0/0'], ['::/0'], ['127.0.0.2/24'], ['example.invalid']]) {
    assert.throws(() => normalizeConfig({ trustedProxyCidrs }), TypeError);
  }
  assert.throws(() => normalizeConfig(configFromEnvironment({ FARM_TRUSTED_PROXY_CIDRS: '127.0.0.1,garbage-proxy-input.invalid' })),
    e => e instanceof TypeError && !e.message.includes('garbage-proxy-input'));
  assert.doesNotThrow(() => normalizeConfig(configFromEnvironment({ FARM_TRUSTED_PROXY_CIDRS: '127.0.0.1/32, 2001:db8::/32' })));
});
