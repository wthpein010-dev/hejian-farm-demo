import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../test-support/listen-http.mjs';
import { createFarmClient } from '../../../apps/mobile/src/core/client.mjs';
import { parseSession } from '../../../shared/session.mjs';

for (const environment of ['development', 'production']) {
  test(`real Store ${environment} login wire passes the shared client boundary`, async t => {
    // Deliberately differs from the device clock. Session expiry remains a
    // server decision, including when a development environment uses a clock.
    const instant = 1000;
    const app = createApp({ databasePath: ':memory:', mode: environment,
      allowDevelopmentAuth: environment === 'development', clock: () => instant,
      platformProviders: environment === 'production' ? { weixin: async () => ({ subject: 'synthetic-verified-subject' }) } : {} });
    t.after(() => app.close());
    const port = await listenOnFetchSafePort(app.server);
    let session;
    const client = createFarmClient({ baseURL: `http://127.0.0.1:${port}`, transport: async request => {
      const response = await fetch(request.url, { method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      const data = await response.json();
      if (request.url.endsWith('/auth/development') || request.url.endsWith('/auth/platform')) session = data.data;
      return { status: response.status, data };
    } });
    if (environment === 'development') await client.loginDevelopment('synthetic-session-account');
    else await client.loginPlatform('weixin', 'synthetic-platform-code');
    const parsed = parseSession(session);
    assert.deepEqual(Object.keys(parsed).sort(), ['environment', 'expiresAt', 'profile', 'token']);
    assert.deepEqual(Object.keys(parsed.profile).sort(), ['displayName', 'id']);
    assert.match(parsed.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(parsed.profile.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(parsed.environment, environment); assert.equal(parsed.expiresAt, instant + 30 * 60_000);
    assert.notEqual(parsed, session); assert.notEqual(parsed.profile, session.profile);
    await client.load();
    assert.equal(client.authenticated, true); assert.equal(client.profile.id, parsed.profile.id);
    assert.equal(client.snapshot.environment, environment);
  });
}

test('null-prototype JSON data is accepted and projected into ordinary objects', () => {
  const profile = Object.assign(Object.create(null), { id: 'legacy_account:001', displayName: '合成旧账户' });
  const session = Object.assign(Object.create(null), { token: 'A'.repeat(43), expiresAt: 1000, environment: 'production', profile });
  const parsed = parseSession(session);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.profile), Object.prototype);
  assert.deepEqual(parsed.profile, { id: 'legacy_account:001', displayName: '合成旧账户' });
});

test('profile accessors and object traps cannot expose raw failures or run field getters', () => {
  let reads = 0;
  const profile = { id: 'member-a' };
  Object.defineProperty(profile, 'displayName', { enumerable: true, get() { reads++; throw new Error('synthetic-private-field'); } });
  for (const session of [
    { token: 'A'.repeat(43), expiresAt: 1000, environment: 'development', profile },
    new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-trap'); } })
  ]) {
    assert.throws(() => parseSession(session), failure => failure.code === 'SESSION_DATA_INVALID' &&
      !failure.message.includes('synthetic-private') && failure.cause === undefined);
  }
  assert.equal(reads, 0);
});
