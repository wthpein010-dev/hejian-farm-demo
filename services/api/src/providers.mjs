import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const OPENID = /^[A-Za-z0-9_-]{1,128}$/;
const credential = (value, max) => typeof value === 'string' && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const unavailable = () => new PlatformIdentityError(502);

export class PlatformIdentityError extends Error {
  constructor(status) {
    super(status === 401 ? '平台登录凭证无效，请重新发起登录' : '平台身份核验暂不可用，请稍后重新登录');
    this.name = 'PlatformIdentityError';
    this.status = status === 401 ? 401 : 502;
    this.code = status === 401 ? 'PLATFORM_CODE_REJECTED' : 'IDENTITY_PROVIDER_FAILED';
  }
}

async function limitedJSON(response, signal, limit) {
  if (!response || response.status !== 200) {
    if (response?.body) void response.body.cancel().catch(() => {});
    throw unavailable();
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) { abort(); throw unavailable(); }
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw unavailable();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { abort(); throw unavailable(); }
      chunks.push(Buffer.from(value));
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
    return parsed;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

function providerFor(platform, credentials, { fetchImpl, timeoutMs, maxResponseBytes }) {
  const { appId, secret } = credentials;
  const provider = async ({ code, signal: callerSignal } = {}) => {
    if (typeof code !== 'string' || code.length < 1 || code.length > 4096 || /[\u0000-\u001f]/.test(code)) throw new PlatformIdentityError(401);
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    let timer;
    try {
      const operation = async () => {
        signal.throwIfAborted();
        let target, init;
        if (platform === 'weixin') {
          // Weixin's documented server API requires credentials in this fixed HTTPS query.
          const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
          url.search = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: 'authorization_code' }).toString();
          target = url.toString();
          init = { method: 'GET', headers: { Accept: 'application/json' } };
        } else {
          target = 'https://developer.toutiao.com/api/apps/v2/jscode2session';
          init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ appid: appId, secret, code }) };
        }
        const upstream = await fetchImpl(target, { ...init, signal, redirect: 'error', cache: 'no-store' });
        const result = await limitedJSON(upstream, signal, maxResponseBytes);
        let openid;
        if (platform === 'weixin') {
          if (result.errcode !== undefined && (!Number.isSafeInteger(result.errcode) || result.errcode !== 0)) {
            if ([40029, 40163, 40226].includes(result.errcode)) throw new PlatformIdentityError(401);
            throw unavailable();
          }
          openid = result.openid;
        } else {
          if (!Number.isSafeInteger(result.err_no) || result.err_no !== 0) {
            if ([40018, 40019].includes(result.err_no)) throw new PlatformIdentityError(401);
            throw unavailable();
          }
          openid = result.data?.openid;
        }
        if (typeof openid !== 'string' || !OPENID.test(openid)) throw unavailable();
        // Persist only our app-scoped pseudonym. Never return session_key, unionid or raw openid.
        return { subject: digest(appId + '\0' + openid) };
      };
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
      })]);
    } catch (error) {
      if (error instanceof PlatformIdentityError) throw error;
      // Fetch exceptions can contain the credential-bearing URL. Do not retain their message or cause.
      throw unavailable();
    } finally { clearTimeout(timer); controller.abort(); }
  };
  Object.defineProperty(provider, 'identityNamespace', { value: digest(appId), writable: false, enumerable: false });
  return provider;
}

export function createPlatformProviders(configuration = {}, options = {}) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
    Object.keys(configuration).some(name => !['weixin', 'toutiao'].includes(name))) throw new TypeError('平台凭据配置无效');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000, maxResponseBytes = options.maxResponseBytes ?? 16 * 1024;
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > 64 * 1024) throw new TypeError('平台请求配置无效');
  const providers = {};
  for (const [platform, values] of Object.entries(configuration)) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(name => !['appId', 'secret'].includes(name)) ||
      !credential(values.appId, 128) || !credential(values.secret, 512)) throw new TypeError('平台AppID与Secret必须完整成对配置');
    providers[platform] = providerFor(platform, values, { fetchImpl, timeoutMs, maxResponseBytes });
  }
  return Object.freeze(providers);
}

export function platformProvidersFromEnvironment(env = process.env) {
  const configuration = {};
  for (const [platform, prefix] of [['weixin', 'FARM_WEIXIN'], ['toutiao', 'FARM_TOUTIAO']]) {
    const appId = env[prefix + '_APP_ID'], secret = env[prefix + '_APP_SECRET'];
    if (appId || secret) configuration[platform] = { appId, secret };
  }
  return createPlatformProviders(configuration);
}
