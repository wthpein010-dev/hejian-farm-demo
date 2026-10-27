import test from 'node:test';
import assert from 'node:assert/strict';

let createWeixinAppAuthorizer;
try {
  ({ createWeixinAppAuthorizer } = await import('../apps/mobile/src/core/weixin-app.mjs'));
} catch (failure) {
  if (failure.code !== 'ERR_MODULE_NOT_FOUND') throw failure;
}

test('import and construction leave the native SDK untouched until explicit authorization', () => {
  assert.equal(typeof createWeixinAppAuthorizer, 'function', 'the passive native authorizer factory is missing');
  let touched = 0;
  const oauth = Object.defineProperty({}, 'getServices', { get() { touched++; throw new Error('private-sdk-detail'); } });
  const authorizer = createWeixinAppAuthorizer({ oauth, appId: 'wx0123456789abcdef' });
  assert.equal(touched, 0);
  assert.equal(authorizer.busy, false);
  assert.equal(typeof authorizer.authorize, 'function');
  assert.equal(authorizer.cancel(), false);
  assert.equal(touched, 0);
});

const APP_ID = 'wx0123456789abcdef';
const STATE_ONE = '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const STATE_TWO = '6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b';
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

async function rejected(observed, suffix) {
  const result = await observed;
  assert.ok(result.error instanceof Error, 'the attempt must reject');
  assert.equal(result.error.name, 'WeixinAppAuthorizationError');
  assert.equal(result.error.code, `WEIXIN_APP_${suffix}`);
  assert.equal(Object.hasOwn(result.error, 'cause'), false);
  assert.doesNotMatch(result.error.message, /private|synthetic-code|5a5a|6b6b|wx0123/);
  return result.error;
}

function nativeHarness(overrides = {}) {
  let clock = 1000, timerId = 0, randomCalls = 0;
  const discovery = [], authorization = [], timers = new Map(), allTimers = [], cleared = [], randomSizes = [];
  const oauth = {
    getServices(success, fail) {
      assert.equal(this, oauth);
      discovery.push({ success, fail });
    }
  };
  const service = {
    id: 'weixin', nativeClient: true,
    authorize(success, fail, options) {
      assert.equal(this, service);
      authorization.push({ success, fail, options });
    },
    login() { assert.fail('code-only authorization must not fetch tokens'); },
    logout() { assert.fail('local cancellation must not logout native authorization'); },
    getUserInfo() { assert.fail('code-only authorization must not fetch profile data'); },
    closeAuthView() { assert.fail('the one-click auth API must not be used to close Weixin'); }
  };
  const crypto = {
    getRandomValues(bytes) {
      assert.equal(this, crypto);
      assert.ok(bytes instanceof Uint8Array);
      randomSizes.push(bytes.byteLength);
      bytes.fill(randomCalls++ === 0 ? 0x5a : 0x6b);
      return bytes;
    }
  };
  const dependencies = {
    oauth, appId: APP_ID, crypto,
    now: () => clock,
    setTimer(callback, delay) {
      const task = { id: ++timerId, callback, delay, at: clock + delay };
      timers.set(task.id, task); allTimers.push(task); return task.id;
    },
    clearTimer(id) { cleared.push(id); timers.delete(id); },
    ...overrides
  };
  const authorizer = createWeixinAppAuthorizer(dependencies);
  return {
    authorizer, oauth, service, crypto, discovery, authorization, timers, allTimers, cleared, randomSizes,
    setTime(value) { clock = value; },
    elapse(ms) { clock += ms; },
    fireDue() {
      for (const task of [...timers.values()]) {
        if (task.at <= clock) { timers.delete(task.id); task.callback(); }
      }
    },
    discover(services = [service], index = 0) {
      assert.ok(discovery[index], 'authorization must enumerate native services');
      discovery[index].success(services);
    },
    reply(code = 'synthetic-code-one', index = 0) {
      assert.ok(authorization[index], 'the unique Weixin service must be authorized');
      authorization[index].success({ code, state: authorization[index].options.state });
    }
  };
}

test('code-only authorization binds a 16-byte CSPRNG state and trusted AppID to the unique native service', async () => {
  const h = nativeHarness();
  const result = observe(h.authorizer.authorize());
  assert.equal(h.authorizer.busy, true);
  assert.deepEqual(h.randomSizes, [16]);
  assert.equal(h.allTimers[0]?.delay, 60000);
  h.discover([{ id: 'apple', authorize() { assert.fail('wrong provider'); } }, h.service]);
  assert.deepEqual(h.authorization[0].options, { scope: 'snsapi_userinfo', state: STATE_ONE, appid: APP_ID });
  h.reply();
  assert.deepEqual(await result, { value: 'synthetic-code-one' });
  assert.equal(h.authorizer.busy, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.authorizer.cancel(), false);
});

test('a busy attempt rejects a second request without replacing its state or native callbacks', async () => {
  const h = nativeHarness();
  const first = observe(h.authorizer.authorize());
  await rejected(observe(h.authorizer.authorize()), 'BUSY');
  assert.equal(h.discovery.length, 1);
  assert.deepEqual(h.randomSizes, [16]);
  h.discover(); h.reply();
  assert.equal((await first).value, 'synthetic-code-one');
  const second = observe(h.authorizer.authorize());
  h.discover([h.service], 1);
  assert.equal(h.authorization[1].options.state, STATE_TWO);
  h.reply('synthetic-code-two', 1);
  assert.equal((await second).value, 'synthetic-code-two');
});

for (const [label, services] of [
  ['no services', []], ['not an array', {}], ['no Weixin service', [{ id: 'apple' }]],
  ['duplicate Weixin services', [{ id: 'weixin', authorize() {} }, { id: 'weixin', authorize() {} }]],
  ['missing authorize method', [{ id: 'weixin' }]]
]) {
  test(`service discovery fails closed for ${label}`, async () => {
    const h = nativeHarness(); const result = observe(h.authorizer.authorize());
    h.discover(services);
    await rejected(result, 'UNAVAILABLE');
    assert.equal(h.authorizer.busy, false);
    assert.equal(h.authorization.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const [label, overrides, suffix] of [
  ['missing native module', { oauth: undefined }, 'UNAVAILABLE'],
  ['missing discovery method', { oauth: {} }, 'UNAVAILABLE'],
  ['missing CSPRNG', { crypto: null }, 'RANDOM_UNAVAILABLE'],
  ['non-callable CSPRNG', { crypto: { getRandomValues: true } }, 'RANDOM_UNAVAILABLE'],
  ['throwing CSPRNG', { crypto: { getRandomValues() { throw new Error('private-random-detail'); } } }, 'RANDOM_UNAVAILABLE'],
  ['missing AppID', { appId: undefined }, 'INVALID_CONFIGURATION'],
  ['control characters in AppID', { appId: 'wx\nprivate' }, 'INVALID_CONFIGURATION'],
  ['trailing LF in AppID', { appId: 'app\n' }, 'INVALID_CONFIGURATION'],
  ['trailing CR in AppID', { appId: 'app\r' }, 'INVALID_CONFIGURATION'],
  ['trailing line separator in AppID', { appId: 'app\u2028' }, 'INVALID_CONFIGURATION'],
  ['trailing paragraph separator in AppID', { appId: 'app\u2029' }, 'INVALID_CONFIGURATION'],
  ['oversized AppID', { appId: 'a'.repeat(129) }, 'INVALID_CONFIGURATION'],
  ['too short timeout', { timeoutMs: 99 }, 'INVALID_CONFIGURATION'],
  ['too long timeout', { timeoutMs: 120001 }, 'INVALID_CONFIGURATION'],
  ['non-numeric timeout', { timeoutMs: '100' }, 'INVALID_CONFIGURATION'],
  ['non-finite timeout', { timeoutMs: NaN }, 'INVALID_CONFIGURATION']
]) {
  test(`authorization fails with a fixed error for ${label}`, async () => {
    const h = nativeHarness(overrides);
    await rejected(observe(h.authorizer.authorize()), suffix);
    assert.equal(h.authorizer.busy, false);
    assert.equal(h.discovery.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const [label, makeEvent] of [
  ['missing state', () => ({ code: 'synthetic-code-one' })],
  ['wrong state', () => ({ code: 'synthetic-code-one', state: STATE_TWO })],
  ['non-string state', () => ({ code: 'synthetic-code-one', state: 5 })],
  ['empty code', () => ({ code: '', state: STATE_ONE })],
  ['over-budget code', () => ({ code: 'x'.repeat(4097), state: STATE_ONE })],
  ['non-string code', () => ({ code: 123, state: STATE_ONE })],
  ['C0 controls', () => ({ code: 'code\nprivate', state: STATE_ONE })],
  ['DEL control', () => ({ code: 'code\u007fprivate', state: STATE_ONE })],
  ['C1 controls', () => ({ code: 'code\u0085private', state: STATE_ONE })],
  ['null event', () => null],
  ['array event', () => Object.assign([], { code: 'synthetic-code-one', state: STATE_ONE })],
  ['inherited code', () => Object.assign(Object.create({ code: 'synthetic-code-one' }), { state: STATE_ONE })],
  ['inherited state', () => Object.assign(Object.create({ state: STATE_ONE }), { code: 'synthetic-code-one' })],
  ['throwing descriptors', () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private-descriptor-detail'); } })]
]) {
  test(`native success refuses ${label} without exposing a code`, async () => {
    const h = nativeHarness(); const result = observe(h.authorizer.authorize()); h.discover();
    h.authorization[0].success(makeEvent());
    await rejected(result, 'INVALID_RESPONSE');
    assert.equal(h.authorizer.busy, false);
    assert.equal(h.timers.size, 0);
  });
}

for (const field of ['code', 'state']) {
  test(`native success refuses the ${field} getter without evaluating it`, async () => {
    const h = nativeHarness(); const result = observe(h.authorizer.authorize()); h.discover();
    let reads = 0;
    const event = { code: 'synthetic-code-one', state: STATE_ONE };
    Object.defineProperty(event, field, { get() { reads++; throw new Error('private-getter-detail'); } });
    h.authorization[0].success(event);
    await rejected(result, 'INVALID_RESPONSE');
    assert.equal(reads, 0);
  });
}

for (const length of [1, 4096]) {
  test(`the accepted ${length}-character code is returned intact without an authResult or token`, async () => {
    const h = nativeHarness(); const result = observe(h.authorizer.authorize()); h.discover();
    const code = 'x'.repeat(length);
    const event = { code, state: STATE_ONE };
    Object.defineProperty(event, 'authResult', { get() { assert.fail('token data must not be inspected'); } });
    h.authorization[0].success(event);
    assert.deepEqual(await result, { value: code });
  });
}

test('local cancellation during discovery invalidates old callbacks and permits a new attempt', async () => {
  const h = nativeHarness(); const first = observe(h.authorizer.authorize());
  assert.equal(h.authorizer.cancel(), true);
  await rejected(first, 'CANCELLED');
  assert.equal(h.authorizer.busy, false);
  assert.equal(h.timers.size, 0);
  const second = observe(h.authorizer.authorize());
  h.discover();
  h.discovery[0].fail(new Error('private-old-discovery-detail'));
  h.allTimers[0].callback();
  assert.equal(h.authorizer.busy, true);
  assert.equal(h.authorization.length, 0);
  h.discover([h.service], 1); h.reply('synthetic-code-two');
  assert.equal((await second).value, 'synthetic-code-two');
});

test('local cancellation during native authorization cannot close Weixin and old callbacks cannot settle a new attempt', async () => {
  const h = nativeHarness(); const first = observe(h.authorizer.authorize()); h.discover();
  assert.equal(h.authorizer.cancel(), true);
  await rejected(first, 'CANCELLED');
  const second = observe(h.authorizer.authorize()); h.discover([h.service], 1);
  h.reply('synthetic-old-code');
  h.authorization[0].fail(new Error('private-old-native-detail'));
  h.allTimers[0].callback();
  assert.equal(h.authorizer.busy, true);
  assert.equal(h.timers.size, 1);
  h.reply('synthetic-code-two', 1);
  assert.equal((await second).value, 'synthetic-code-two');
});

test('duplicate service discovery authorizes once and duplicate native callbacks never affect the next attempt', async () => {
  const h = nativeHarness(); const first = observe(h.authorizer.authorize());
  h.discover(); h.discover();
  assert.equal(h.authorization.length, 1);
  h.reply(); assert.equal((await first).value, 'synthetic-code-one');
  const second = observe(h.authorizer.authorize()); h.discover([h.service], 1);
  h.reply('synthetic-duplicate-code'); h.authorization[0].fail({ message: 'private-duplicate-detail' });
  h.discovery[0].fail({ message: 'private-duplicate-discovery-detail' });
  assert.equal(h.authorizer.busy, true);
  h.reply('synthetic-code-two', 1);
  assert.equal((await second).value, 'synthetic-code-two');
});

for (const stage of ['discovery', 'authorization']) {
  test(`the default 60-second deadline includes ${stage} and releases busy on timeout`, async () => {
    const h = nativeHarness(); const result = observe(h.authorizer.authorize());
    if (stage === 'authorization') h.discover();
    h.elapse(59999); h.fireDue(); assert.equal(h.authorizer.busy, true);
    h.elapse(1); h.fireDue(); await rejected(result, 'TIMEOUT');
    assert.equal(h.authorizer.busy, false);
    assert.equal(h.timers.size, 0);
    if (stage === 'authorization') h.reply(); else h.discover();
    assert.equal(h.authorizer.busy, false);
  });
}

for (const stage of ['discovery', 'authorization', 'failure']) {
  test(`a late ${stage} callback cannot beat the deadline when the timer has not run`, async () => {
    const h = nativeHarness({ timeoutMs: 100 }); const result = observe(h.authorizer.authorize());
    if (stage !== 'discovery') h.discover();
    h.elapse(100);
    if (stage === 'discovery') h.discover();
    else if (stage === 'failure') h.authorization[0].fail({ message: 'private-late-detail' });
    else h.reply();
    await rejected(result, 'TIMEOUT');
    assert.equal(h.authorizer.busy, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.authorization.length, stage === 'discovery' ? 0 : 1);
  });
}

test('time consumed while generating the state is inside the overall attempt deadline', async () => {
  let clock = 1000;
  const h = nativeHarness({ timeoutMs: 100, now: () => clock, crypto: { getRandomValues(bytes) { bytes.fill(0x5a); clock += 100; return bytes; } } });
  await rejected(observe(h.authorizer.authorize()), 'TIMEOUT');
  assert.equal(h.discovery.length, 0);
  assert.equal(h.authorizer.busy, false);
});

for (const timeoutMs of [100, 120000]) {
  test(`the ${timeoutMs}ms allowed timeout boundary is scheduled and enforced`, async () => {
    const h = nativeHarness({ timeoutMs }); const result = observe(h.authorizer.authorize());
    assert.equal(h.allTimers[0]?.delay, timeoutMs);
    h.elapse(timeoutMs); h.fireDue(); await rejected(result, 'TIMEOUT');
  });
}

test('a timer fired early reschedules the remaining deadline rather than timing out a live attempt', async () => {
  const h = nativeHarness({ timeoutMs: 100 }); const result = observe(h.authorizer.authorize());
  h.elapse(40); h.allTimers[0].callback();
  assert.equal(h.authorizer.busy, true);
  assert.equal(h.allTimers.at(-1).delay, 60);
  h.discover(); h.reply(); assert.equal((await result).value, 'synthetic-code-one');
});

for (const stage of ['discovery', 'authorization']) {
  test(`native ${stage} failure never reads or exposes the upstream error and permits retry`, async () => {
    const h = nativeHarness(); const result = observe(h.authorizer.authorize());
    const upstream = new Proxy({}, { get() { assert.fail('native error fields must not be read'); } });
    if (stage === 'discovery') h.discovery[0]?.fail(upstream);
    else { h.discover(); h.authorization[0].fail(upstream); }
    await rejected(result, 'FAILED');
    assert.equal(h.authorizer.busy, false);
    const next = observe(h.authorizer.authorize()); h.discover([h.service], 1); h.reply('synthetic-code-two', stage === 'discovery' ? 0 : 1);
    assert.equal((await next).value, 'synthetic-code-two');
  });
}

test('synchronous native discovery exceptions are replaced with a fixed error', async () => {
  const h = nativeHarness({ oauth: { getServices() { throw new Error('private-native-detail'); } } });
  await rejected(observe(h.authorizer.authorize()), 'FAILED');
  assert.equal(h.authorizer.busy, false);
  assert.equal(h.timers.size, 0);
});

test('synchronous native authorization exceptions are replaced with a fixed error', async () => {
  const h = nativeHarness(); const result = observe(h.authorizer.authorize());
  h.discover([{ id: 'weixin', authorize() { throw new Error('private-native-detail'); } }]);
  await rejected(result, 'FAILED'); assert.equal(h.authorizer.busy, false);
});

test('a native implementation that calls success then throws or fails can settle only once', async () => {
  const service = { id: 'weixin', authorize(success, fail, options) {
    success({ code: 'synthetic-code-one', state: options.state });
    fail(new Error('private-after-success-detail'));
    throw new Error('private-after-success-detail');
  } };
  const h = nativeHarness({ oauth: { getServices(success, fail) {
    success([service]); fail({ message: 'private-after-discovery-detail' }); throw new Error('private-after-discovery-detail');
  } } });
  assert.deepEqual(await observe(h.authorizer.authorize()), { value: 'synthetic-code-one' });
  assert.equal(h.authorizer.busy, false); assert.equal(h.timers.size, 0);
});

test('throwing capability getters fail closed without leaking their error', async () => {
  const oauth = Object.defineProperty({}, 'getServices', { get() { throw new Error('private-capability-detail'); } });
  const h = nativeHarness({ oauth });
  await rejected(observe(h.authorizer.authorize()), 'UNAVAILABLE');
  const crypto = Object.defineProperty({}, 'getRandomValues', { get() { throw new Error('private-random-detail'); } });
  const other = nativeHarness({ crypto });
  await rejected(observe(other.authorizer.authorize()), 'RANDOM_UNAVAILABLE');
});

test('clock and timer exceptions fail closed and never leave the authorizer busy', async () => {
  for (const overrides of [
    { now() { throw new Error('private-clock-detail'); } },
    { now: () => NaN },
    { setTimer() { throw new Error('private-timer-detail'); } }
  ]) {
    const h = nativeHarness(overrides);
    await rejected(observe(h.authorizer.authorize()), 'FAILED');
    assert.equal(h.authorizer.busy, false);
    assert.equal(h.discovery.length, 0);
  }
});

test('timer cleanup exceptions cannot expose native data or change a settled result', async () => {
  const h = nativeHarness({ clearTimer() { throw new Error('private-cleanup-detail'); } });
  const result = observe(h.authorizer.authorize()); h.discover(); h.reply();
  assert.deepEqual(await result, { value: 'synthetic-code-one' });
  assert.equal(h.authorizer.busy, false);
});

test('the default clock prefers performance.now over wall-clock time', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let clock = 1000, wallReads = 0;
  const originalDateNow = Date.now;
  try {
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
    Date.now = () => { wallReads++; return 123; };
    const h = nativeHarness({ now: undefined, timeoutMs: 100 });
    const result = observe(h.authorizer.authorize()); h.discover(); clock += 100; h.reply();
    await rejected(result, 'TIMEOUT'); assert.equal(wallReads, 0);
  } finally {
    Date.now = originalDateNow;
    if (descriptor) Object.defineProperty(globalThis, 'performance', descriptor); else delete globalThis.performance;
  }
});
