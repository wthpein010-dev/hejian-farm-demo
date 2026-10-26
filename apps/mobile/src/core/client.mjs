/** Account-scoped API client. Authentication and uncertain requests stay in memory. */
import { isFarmSnapshot } from './snapshot.mjs';
export class FarmApiError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'FarmApiError'; this.code = code; this.status = status; }
}

export function createFarmClient({ baseURL = '', transport, generateKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}` }) {
  const base = baseURL.replace(/\/$/, '');
  if (base && !/^(https:\/\/[a-zA-Z0-9.-]+(?::\d+)?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)(?:\/[a-zA-Z0-9_~.-]+)*$/.test(base)) {
    throw new Error('服务地址必须使用 HTTPS，本机联调仅允许 loopback HTTP');
  }
  let token = '', profile = null, snapshot = null, pending = null, generation = 0, loginAttempt = 0, activeLogins = 0, activeMutation = false;
  const error = (code, message, status) => new FarmApiError(code, message, status);
  function acceptSnapshot(value) {
    if (!isFarmSnapshot(value, profile?.id)) throw error('SERVER_UNAVAILABLE', '田园数据未能确认，请重新同步。');
    if (!snapshot || value.revision >= snapshot.revision) snapshot = value;
    return snapshot;
  }
  function requireSession() {
    if (!base) throw error('SERVICE_UNCONFIGURED', '农场服务尚未配置，请稍后再来。');
    if (!token) throw error('SESSION_REQUIRED', '请先登录，再查看自己的田园。');
  }
  async function send(path, method, body, authenticated = true, key = '') {
    if (!base) throw error('SERVICE_UNCONFIGURED', '农场服务尚未配置，请稍后再来。');
    if (authenticated) requireSession();
    const requestGeneration = generation, requestToken = token;
    const guard = () => { if (authenticated && (requestGeneration !== generation || requestToken !== token)) throw error('SESSION_CHANGED', '账户会话已变化，旧请求不会覆盖当前田园。'); };
    if (!/^\/[a-z0-9/-]+$/.test(path)) throw error('INVALID_ROUTE', '操作地址无效。');
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    let response;
    try { response = await transport({ url: `${base}/api/v1${path}`, method, headers, body, timeout: 15000 }); }
    catch { guard(); throw error('NETWORK_UNAVAILABLE', '连接未能确认，请检查网络后重试。'); }
    guard();
    if (!response || !Number.isInteger(response.status) || response.status >= 500) {
      if (response?.status === 503 && response.data?.error?.code) {
        throw error(response.data.error.code, response.data.error.message || '这项农场服务暂未开放。', 503);
      }
      throw error('SERVER_UNAVAILABLE', '农场服务暂时繁忙，请稍后重试。', response?.status || 0);
    }
    if (response.status >= 400) {
      if (response.status === 401 && authenticated) { token = ''; snapshot = null; generation++; }
      if (response.status === 409 && response.data?.data) acceptSnapshot(response.data.data);
      throw error(response.data?.error?.code || 'REQUEST_REJECTED', response.data?.error?.message || '操作未完成，请刷新后核对。', response.status);
    }
    if (!response.data || !Object.prototype.hasOwnProperty.call(response.data, 'data')) throw error('SERVER_UNAVAILABLE', '服务回复未能确认，请稍后重试。');
    return response.data.data;
  }
  async function login(path, body) {
    if (activeMutation) throw error('PENDING_OPERATION', '正在核对资产操作，请稍后再切换账户。');
    const attempt = ++loginAttempt;
    activeLogins++;
    try {
      const result = await send(path, 'POST', body, false);
      if (attempt !== loginAttempt) throw error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。');
      if (typeof result?.token !== 'string' || !result?.profile?.id) throw error('INVALID_SESSION', '登录回复不完整，请重试。');
      if (pending && pending.accountId !== result.profile.id) throw error('ACCOUNT_MISMATCH', '上次操作仍待核对，请登录操作时的原账户，再核对结果。');
      token = result.token; profile = result.profile; snapshot = null; generation++;
      return profile;
    } catch (failure) {
      if (attempt !== loginAttempt) throw error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。');
      throw failure;
    } finally { activeLogins--; }
  }
  async function submit(operation, retry = false) {
    activeMutation = true;
    try {
      const result = await send(operation.path, 'POST', operation.body, true, operation.key);
      acceptSnapshot(result); pending = null; return snapshot;
    } catch (failure) {
      if (['NETWORK_UNAVAILABLE', 'SERVER_UNAVAILABLE', 'SESSION_CHANGED'].includes(failure.code)) {
        pending = operation;
        throw error('RESULT_UNKNOWN', '这次操作的结果尚未确认。请使用“核对上次操作”，避免重复提交。');
      }
      if (!(retry && failure.status === 401)) pending = null;
      throw failure;
    } finally { activeMutation = false; }
  }
  return {
    get authenticated() { return !!token; },
    get profile() { return profile; },
    get snapshot() { return snapshot; },
    get configured() { return !!base; },
    hasPending() { return !!pending; },
    loginDevelopment(account) { return login('/auth/development', { account }); },
    loginPlatform(platform, code) { return login('/auth/platform', { platform, code }); },
    async load() {
      const requestGeneration = generation, result = await send('/bootstrap', 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      return acceptSnapshot(result);
    },
    async mutate(path, body = {}) {
      requireSession();
      if (pending || activeMutation || activeLogins) throw error('PENDING_OPERATION', '请先完成登录或核对上次操作的结果，再继续。');
      if (!snapshot || !Number.isSafeInteger(snapshot.revision)) throw error('SNAPSHOT_REQUIRED', '请先刷新田园数据。');
      if (body.expectedRevision !== undefined && body.expectedRevision !== snapshot.revision) throw error('VERSION_CONFLICT', '田园资产已更新，请重新核对本次明细。');
      const operation = { path, body: JSON.parse(JSON.stringify({ ...body, expectedRevision: snapshot.revision })), key: generateKey(), accountId: profile.id };
      return submit(operation);
    },
    async retryPending() {
      requireSession();
      if (activeMutation || activeLogins) throw error('PENDING_OPERATION', '正在登录或核对上次操作，请稍候。');
      if (!pending) throw error('NO_PENDING_OPERATION', '没有需要核对的操作。');
      if (pending.accountId !== profile.id) throw error('ACCOUNT_MISMATCH', '请登录原来的账户，再核对上次操作。');
      return submit(pending, true);
    },
    async logout() {
      if (pending || activeMutation) throw error('PENDING_OPERATION', '请先核对上次操作的结果，再退出账户。');
      const requestToken = token, accountId = profile?.id; loginAttempt++;
      try { if (token) await send('/auth/logout', 'POST', {}); }
      finally { if (token === requestToken || (!token && profile?.id === accountId)) { token = ''; profile = null; snapshot = null; generation++; } }
    }
  };
}
