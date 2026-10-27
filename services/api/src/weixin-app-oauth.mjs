import { createHash } from 'node:crypto';
import { PlatformIdentityError, limitedJSON } from './platform-http.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new PlatformIdentityError(502);
const boundedASCII = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[^\x21-\x7e]/.test(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);

function configurationObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function userInfoScope(value) {
  if (typeof value !== 'string' || !value.length || value.length > 1024) return false;
  const scopes = value.split(',');
  return scopes.includes('snsapi_userinfo') && scopes.every(scope => scope.length > 0 && scope.length <= 64 && !/[^A-Za-z0-9_]/.test(scope));
}

// Private server-only exchange. It neither resolves a Farm account nor claims a
// code durably; a future login route must claim before exchange and apply its
// separately approved identity policy before issuing any Farm session.
export function createWeixinAppOAuthExchange(credentials, options = {}) {
  if (!configurationObject(credentials, ['appId', 'secret']) ||
    !Object.hasOwn(credentials, 'appId') || !Object.hasOwn(credentials, 'secret') ||
    !boundedASCII(credentials.appId, 128) || !boundedASCII(credentials.secret, 512)) {
    throw new TypeError('App微信AppID与Secret必须完整成对配置');
  }
  if (!configurationObject(options, ['fetchImpl', 'timeoutMs', 'maxResponseBytes'])) throw new TypeError('App微信请求配置无效');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000, maxResponseBytes = options.maxResponseBytes ?? 16 * 1024;
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > 64 * 1024) {
    throw new TypeError('App微信请求配置无效');
  }
  const { appId, secret } = credentials, identityNamespace = digest(appId);
  const exchange = async (input = {}) => {
    let timer, signal, abort;
    const controller = new AbortController();
    try {
      const { code, signal: callerSignal } = input;
      if (typeof code !== 'string' || code.length < 1 || code.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(code)) {
        throw new PlatformIdentityError(401);
      }
      if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) throw unavailable();
      signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(unavailable());
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const operation = async () => {
        signal.throwIfAborted();
        // The official OAuth endpoint requires secret/code in this fixed query.
        // Never retain its URL in logs, exceptions, public DTOs or command history.
        const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
        url.search = new URLSearchParams({ appid: appId, secret, code, grant_type: 'authorization_code' }).toString();
        const upstream = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json' },
          signal, redirect: 'error', cache: 'no-store' });
        const result = await limitedJSON(upstream, signal, maxResponseBytes);
        if (result.errcode !== undefined && (!Number.isSafeInteger(result.errcode) || result.errcode !== 0)) {
          if (result.errcode === 40029) throw new PlatformIdentityError(401);
          throw unavailable();
        }
        if (!identity(result.openid) || !boundedASCII(result.access_token, 4096) || !boundedASCII(result.refresh_token, 4096) ||
          !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0 || !userInfoScope(result.scope) ||
          (Object.hasOwn(result, 'unionid') && !identity(result.unionid))) throw unavailable();
        // Token credentials are validated then discarded. No verified Open
        // Platform namespace exists here, so UnionID cannot authorize a merge.
        const unionIdentity = Object.hasOwn(result, 'unionid')
          ? Object.freeze({ namespace: null, digest: digest('weixin-unionid\0' + result.unionid) }) : null;
        return Object.freeze({ provider: 'weixin-app', identityNamespace,
          subject: digest(appId + '\0' + result.openid), unionIdentity });
      };
      return await Promise.race([operation(), cancelled]);
    } catch (error) {
      if (error instanceof PlatformIdentityError) throw error;
      // Transport errors may include credentials in URL/message/cause.
      throw unavailable();
    } finally {
      clearTimeout(timer);
      if (signal && abort) signal.removeEventListener('abort', abort);
      controller.abort();
    }
  };
  Object.defineProperty(exchange, 'identityNamespace', { value: identityNamespace, writable: false, enumerable: false });
  return exchange;
}
