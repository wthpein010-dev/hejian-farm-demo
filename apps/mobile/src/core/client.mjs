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
  let privacy = null, deletionProposal = null, deletionAttempt = 0;
  const confirmedMutationRefusals = new WeakSet();
  const error = (code, message, status) => new FarmApiError(code, message, status);
  function acceptSnapshot(value) {
    if (!isFarmSnapshot(value, profile?.id)) throw error('SERVER_UNAVAILABLE', '田园数据未能确认，请重新同步。');
    if (!snapshot || value.revision >= snapshot.revision) snapshot = value;
    if (deletionProposal && deletionProposal.revision !== snapshot.revision) cancelAccountDeletion();
    return snapshot;
  }
  function requireSession() {
    if (!base) throw error('SERVICE_UNCONFIGURED', '农场服务尚未配置，请稍后再来。');
    if (!token) throw error('SESSION_REQUIRED', '请先登录，再查看自己的田园。');
  }
  function responseFailure(response, authenticated, key, fallback) {
    const code = response.data?.error?.code || 'REQUEST_REJECTED';
    const failure = error(code, response.data?.error?.message || fallback, response.status);
    // These exact Store refusals follow the successful-receipt lookup. A
    // generic gateway/status code cannot establish an earlier attempt's result.
    const afterReceiptLookup = (response.status === 409 && ['IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT'].includes(code)) ||
      (response.status === 422 && code === 'BUSINESS_RULE') || (response.status === 503 && code === 'CAPABILITY_UNAVAILABLE');
    if (authenticated && key && afterReceiptLookup && isFarmSnapshot(response.data?.data, profile?.id)) {
      acceptSnapshot(response.data.data); confirmedMutationRefusals.add(failure);
    }
    return failure;
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
        throw responseFailure(response, authenticated, key, '这项农场服务暂未开放。');
      }
      throw error('SERVER_UNAVAILABLE', '农场服务暂时繁忙，请稍后重试。', response?.status || 0);
    }
    if (response.status >= 400) {
      if (response.status === 401 && authenticated) { token = ''; snapshot = null; privacy = null; cancelAccountDeletion(); generation++; }
      if (response.status === 409 && response.data?.data) acceptSnapshot(response.data.data);
      throw responseFailure(response, authenticated, key, '操作未完成，请刷新后核对。');
    }
    if (!response.data || !Object.prototype.hasOwnProperty.call(response.data, 'data')) throw error('SERVER_UNAVAILABLE', '服务回复未能确认，请稍后重试。');
    return response.data.data;
  }
  async function login(path, body) {
    if (activeMutation || pending?.kind === 'deletion') throw error('PENDING_OPERATION', '正在核对上次操作，请核对完成后再登录或切换账户。');
    const attempt = ++loginAttempt;
    activeLogins++;
    try {
      const result = await send(path, 'POST', body, false);
      if (attempt !== loginAttempt) throw error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。');
      if (typeof result?.token !== 'string' || !result?.profile?.id) throw error('INVALID_SESSION', '登录回复不完整，请重试。');
      if (pending && pending.accountId !== result.profile.id) throw error('ACCOUNT_MISMATCH', '上次操作仍待核对，请登录操作时的原账户，再核对结果。');
      token = result.token; profile = result.profile; snapshot = null; privacy = null; cancelAccountDeletion(); generation++;
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
      if (!confirmedMutationRefusals.has(failure) && (failure.status >= 500 ||
        ['NETWORK_UNAVAILABLE', 'SERVER_UNAVAILABLE', 'SESSION_CHANGED'].includes(failure.code) || (retry && failure.status !== 401))) {
        pending = operation;
        throw error('RESULT_UNKNOWN', '这次操作的结果尚未确认。请使用“核对上次操作”，避免重复提交。');
      }
      if (!(retry && failure.status === 401)) pending = null;
      throw failure;
    } finally { activeMutation = false; }
  }
  function cancelAccountDeletion() { deletionProposal = null; deletionAttempt++; }
  function requireIdle() {
    if (pending || activeMutation || activeLogins) throw error('PENDING_OPERATION', '请先完成登录或核对上次操作的结果，再继续。');
  }
  async function submitDeletion(operation) {
    activeMutation = true;
    try {
      const receipt = await send(operation.path, 'POST', operation.body, false);
      if (receipt?.deleted !== true || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < 0) throw error('SERVER_UNAVAILABLE', '注销结果尚未确认。');
      token = ''; profile = null; snapshot = null; privacy = null; pending = null;
      cancelAccountDeletion(); generation++; loginAttempt++;
      return { deleted: true, completedAt: receipt.completedAt };
    } catch (failure) {
      const refused = (failure.status === 410 && ['DELETION_INVALID', 'DELETION_EXPIRED'].includes(failure.code)) ||
        (failure.status === 401 && failure.code === 'REAUTH_REQUIRED') ||
        (failure.status === 409 && failure.code === 'DELETION_STATE_CHANGED');
      if (!refused) {
        pending = operation;
        throw error('RESULT_UNKNOWN', '注销结果尚未确认。请核对上次操作，确认前不要重新注册账户。');
      }
      pending = null;
      if (failure.status === 401) { token = ''; snapshot = null; privacy = null; generation++; }
      throw failure;
    } finally { activeMutation = false; }
  }
  return {
    get authenticated() { return !!token; },
    get profile() { return profile; },
    get snapshot() { return snapshot; },
    get configured() { return !!base; },
    get privacy() { return privacy; },
    get deletionPrepared() { return !!deletionProposal; },
    get pendingCanRetryWithoutAuth() { return pending?.kind === 'deletion'; },
    hasPending() { return !!pending; },
    loginDevelopment(account) { return login('/auth/development', { account }); },
    loginPlatform(platform, code) { return login('/auth/platform', { platform, code }); },
    async load() {
      const requestGeneration = generation, result = await send('/bootstrap', 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      return acceptSnapshot(result);
    },
    async loadPrivacy() {
      const value = await send('/account/privacy', 'GET');
      const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
      if (value?.profile?.id !== profile?.id || !text(value?.profile?.displayName, 128) ||
        !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt ||
        value.deletionSupported !== true || !Array.isArray(value.dataCategories) || value.dataCategories.length < 1 || value.dataCategories.length > 20 ||
        !value.dataCategories.every(v => typeof v?.id === 'string' && /^[a-z-]{1,40}$/.test(v.id) && text(v?.title, 200) && text(v?.description, 2000)) ||
        new Set(value.dataCategories.map(v => v.id)).size !== value.dataCategories.length) throw error('SERVER_UNAVAILABLE', '账户数据说明未能确认，请重新同步。');
      privacy = { profile: { id: value.profile.id, displayName: value.profile.displayName }, createdAt: value.createdAt, updatedAt: value.updatedAt,
        deletionSupported: true, dataCategories: value.dataCategories.map(({ id, title, description }) => ({ id, title, description })) };
      return privacy;
    },
    async prepareAccountDeletion() {
      requireSession(); requireIdle();
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先刷新田园数据，再核对注销。');
      const attempt = ++deletionAttempt; deletionProposal = null; activeMutation = true;
      try {
        const result = await send('/account/deletion/prepare', 'POST', { expectedRevision: snapshot.revision });
        if (attempt !== deletionAttempt) throw error('SESSION_CHANGED', '已取消这次注销准备，请重新核对后再操作。');
        if (typeof result?.confirmationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.confirmationToken) ||
          !Number.isSafeInteger(result.serverTime) || result.serverTime < 0 || !Number.isSafeInteger(result.expiresAt) ||
          result.expiresAt <= result.serverTime || result.expiresAt - result.serverTime > 120000) throw error('SERVER_UNAVAILABLE', '注销准备未能确认，请重新核对。');
        deletionProposal = { confirmationToken: result.confirmationToken, revision: snapshot.revision, accountId: profile.id };
        return { expiresAt: result.expiresAt, serverTime: result.serverTime };
      } finally { activeMutation = false; }
    },
    cancelAccountDeletion,
    async deleteAccount() {
      requireSession(); requireIdle();
      if (!deletionProposal || deletionProposal.accountId !== profile.id) throw error('DELETION_NOT_PREPARED', '请先查看注销说明，再重新核对。');
      const operation = { kind: 'deletion', accountId: profile.id, path: '/account/deletion/confirm', body: { confirmationToken: deletionProposal.confirmationToken } };
      cancelAccountDeletion(); return submitDeletion(operation);
    },
    async mutate(path, body = {}) {
      requireSession();
      requireIdle();
      if (!snapshot || !Number.isSafeInteger(snapshot.revision)) throw error('SNAPSHOT_REQUIRED', '请先刷新田园数据。');
      if (body.expectedRevision !== undefined && body.expectedRevision !== snapshot.revision) throw error('VERSION_CONFLICT', '田园资产已更新，请重新核对本次明细。');
      cancelAccountDeletion();
      const operation = { path, body: JSON.parse(JSON.stringify({ ...body, expectedRevision: snapshot.revision })), key: generateKey(), accountId: profile.id };
      return submit(operation);
    },
    async retryPending() {
      if (activeMutation || activeLogins) throw error('PENDING_OPERATION', '正在登录或核对上次操作，请稍候。');
      if (pending?.kind === 'deletion') return submitDeletion(pending);
      requireSession();
      if (!pending) throw error('NO_PENDING_OPERATION', '没有需要核对的操作。');
      if (pending.accountId !== profile.id) throw error('ACCOUNT_MISMATCH', '请登录原来的账户，再核对上次操作。');
      return submit(pending, true);
    },
    async logout() {
      if (pending || activeMutation) throw error('PENDING_OPERATION', '请先核对上次操作的结果，再退出账户。');
      const requestToken = token, accountId = profile?.id; loginAttempt++;
      try { if (token) await send('/auth/logout', 'POST', {}); }
      finally { if (token === requestToken || (!token && profile?.id === accountId)) { token = ''; profile = null; snapshot = null; privacy = null; cancelAccountDeletion(); generation++; } }
    }
  };
}
