/** Code-only App OAuth coordination. Import/construction never access the native SDK. */
const MESSAGES = Object.freeze({
  UNAVAILABLE: '当前安装包暂不支持微信授权，请稍后再试。',
  INVALID_CONFIGURATION: '微信授权配置尚未就绪，请稍后再试。',
  RANDOM_UNAVAILABLE: '当前环境无法安全发起微信授权，请稍后再试。',
  BUSY: '正在等待微信授权，请完成或取消本次尝试。',
  FAILED: '微信授权未完成，请重试。',
  INVALID_RESPONSE: '微信授权回复未能确认，请重新授权。',
  TIMEOUT: '等待微信授权超时，请返回应用后重试。',
  CANCELLED: '已取消本次本地授权等待。'
});

function authorizationError(kind) {
  const failure = new Error(MESSAGES[kind]);
  failure.name = 'WeixinAppAuthorizationError';
  failure.code = `WEIXIN_APP_${kind}`;
  return failure;
}

function defaultNow() {
  const performance = globalThis.performance;
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error();
  return descriptor.value;
}

export function createWeixinAppAuthorizer({
  oauth, appId, crypto, timeoutMs = 60000, now = defaultNow,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = handle => globalThis.clearTimeout(handle)
} = {}) {
  let active = null, generation = 0;
  const owns = attempt => active === attempt && generation === attempt.generation && !attempt.settled;

  function clearScheduled(attempt) {
    const timer = attempt.timer;
    attempt.timer = null;
    if (timer?.registered) {
      try { clearTimer(timer.handle); } catch { /* Local cleanup must not expose platform errors. */ }
    }
  }

  function settle(attempt, kind, code) {
    if (!owns(attempt)) return false;
    attempt.settled = true;
    active = null;
    generation++;
    attempt.state = null;
    clearScheduled(attempt);
    if (kind) attempt.reject(authorizationError(kind)); else attempt.resolve(code);
    return true;
  }

  function readClock() {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error();
    return value;
  }

  // Every native/timer callback checks elapsed time itself: a delayed JS timer
  // cannot let a late native reply succeed after the local deadline.
  function current(attempt) {
    if (!owns(attempt)) return false;
    let time;
    try { time = readClock(); }
    catch { settle(attempt, 'FAILED'); return false; }
    if (time < attempt.startedAt) { settle(attempt, 'FAILED'); return false; }
    if (time >= attempt.deadline) { settle(attempt, 'TIMEOUT'); return false; }
    return true;
  }

  function schedule(attempt) {
    if (!current(attempt)) return;
    clearScheduled(attempt);
    const timer = { registered: false, handle: undefined };
    attempt.timer = timer;
    try {
      timer.handle = setTimer(() => {
        if (!owns(attempt)) return;
        // A synchronous/broken timer cannot recursively extend the attempt.
        if (!timer.registered) { settle(attempt, 'FAILED'); return; }
        if (current(attempt)) schedule(attempt);
      }, Math.max(0, attempt.deadline - readClock()));
      timer.registered = true;
      if (!owns(attempt) || attempt.timer !== timer) {
        try { clearTimer(timer.handle); } catch { /* Already settled. */ }
      }
    } catch { settle(attempt, 'FAILED'); }
  }

  function succeed(attempt, event) {
    if (!current(attempt) || attempt.phase !== 'authorization') return;
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error();
      const code = ownData(event, 'code'), state = ownData(event, 'state');
      if (typeof code !== 'string' || code.length < 1 || code.length > 4096 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(code) || state !== attempt.state) throw new Error();
      if (current(attempt)) settle(attempt, null, code);
    } catch { if (current(attempt)) settle(attempt, 'INVALID_RESPONSE'); }
  }

  function discovered(attempt, services) {
    if (!current(attempt) || attempt.phase !== 'discovery') return;
    try {
      if (!Array.isArray(services)) { settle(attempt, 'UNAVAILABLE'); return; }
      const matches = services.filter(service => service?.id === 'weixin');
      if (matches.length !== 1) { settle(attempt, 'UNAVAILABLE'); return; }
      const service = matches[0], authorize = service.authorize;
      if (typeof authorize !== 'function') { settle(attempt, 'UNAVAILABLE'); return; }
      if (!current(attempt)) return;
      attempt.phase = 'authorization';
      authorize.call(service,
        event => succeed(attempt, event),
        () => { if (current(attempt)) settle(attempt, 'FAILED'); },
        { scope: 'snsapi_userinfo', state: attempt.state, appid: appId });
    } catch { if (current(attempt)) settle(attempt, 'FAILED'); }
  }

  function begin(attempt) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(appId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      settle(attempt, 'INVALID_CONFIGURATION'); return;
    }
    try {
      attempt.startedAt = readClock();
      attempt.deadline = attempt.startedAt + timeoutMs;
      if (!Number.isFinite(attempt.deadline)) throw new Error();
    } catch { settle(attempt, 'FAILED'); return; }
    let getServices;
    try {
      getServices = oauth?.getServices;
      if (typeof getServices !== 'function') throw new Error();
    } catch { settle(attempt, 'UNAVAILABLE'); return; }
    try {
      const random = crypto === undefined ? globalThis.crypto : crypto;
      const getRandomValues = random?.getRandomValues;
      if (typeof getRandomValues !== 'function') throw new Error();
      const bytes = new Uint8Array(16);
      getRandomValues.call(random, bytes);
      attempt.state = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { settle(attempt, 'RANDOM_UNAVAILABLE'); return; }
    if (!current(attempt)) return;
    schedule(attempt);
    if (!current(attempt)) return;
    try {
      getServices.call(oauth,
        services => discovered(attempt, services),
        () => { if (current(attempt) && attempt.phase === 'discovery') settle(attempt, 'FAILED'); });
    } catch { if (current(attempt)) settle(attempt, 'FAILED'); }
  }

  return {
    get busy() { return active !== null; },
    authorize() {
      if (active) return Promise.reject(authorizationError('BUSY'));
      return new Promise((resolve, reject) => {
        const attempt = { generation: ++generation, phase: 'discovery', settled: false, timer: null, state: null, resolve, reject };
        active = attempt;
        begin(attempt);
      });
    },
    // plus.oauth.authorize has no Weixin abort handle. This only abandons local
    // waiting; it does not close Weixin, logout a native session, or retry.
    cancel() { return active ? settle(active, 'CANCELLED') : false; }
  };
}
