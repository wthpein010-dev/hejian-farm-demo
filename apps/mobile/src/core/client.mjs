/** Account-scoped API client. Authentication and uncertain requests stay in memory. */
import { isFarmSnapshot } from './snapshot.mjs';
import { isFarmPage, isFarmDetail } from '../../../../shared/farm-records.mjs';
import { isExchangeId, isExchangePage, isExchangeDetail } from '../../../../shared/exchanges.mjs';
import { isFriendsView, isFriendCommandReceipt, isFriendCommand } from '../../../../shared/friends.mjs';
import { isForumStatus, isForumPage, isForumDetail, isForumReports, isForumCommand, isForumCommandReceipt, isForumId } from '../../../../shared/forum.mjs';
import { isPlantingStatus, isPlantingRecord, isPlantingPage, isPlantingDetail, isPlantingReceipt, isPlantingCommand, isPlantingId } from '../../../../shared/planting.mjs';
import { isRecoveryView, isRecoveryDetail, isRecoveryResult, isRecoveryCommand } from '../../../../shared/recovery.mjs';
import { isEggsId, isEggsStatus, isEggsRecord, isEggsRecordsPage, isEggsPage, isEggsDetail } from '../../../../shared/eggs.mjs';
import { parseSession } from '../../../../shared/session.mjs';
export { isEggsId };
export { isPlantingId };
export { isForumId };
export { isExchangeId };
export class FarmApiError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'FarmApiError'; this.code = code; this.status = status; }
}

// Display aggregates are deliberately separate from the strict wire-page cache.
// A continuation may only append to the exact server cursor it was requested for.
export function mergeFarmPages(previous, page, cursor = 'start') {
  if (cursor === 'start') return { ...page, items: [...page.items] };
  if (!previous || previous.ownerId !== page.ownerId || previous.environment !== page.environment ||
    previous.kind !== page.kind || previous.nextCursor !== cursor) throw new FarmApiError('READ_SUPERSEDED', '档案列表已更新，请重新加载。');
  return { ...page, items: [...previous.items, ...page.items] };
}
export function mergeFarmDetails(previous, detail, beforeVersion = 0) {
  if (beforeVersion === 0) return { ...detail, events: [...detail.events] };
  if (!previous || previous.ownerId !== detail.ownerId || previous.environment !== detail.environment ||
    previous.record.id !== detail.record.id || previous.nextBeforeVersion !== beforeVersion) throw new FarmApiError('READ_SUPERSEDED', '观测记录已更新，请重新加载。');
  if (previous.record.version !== detail.record.version) throw new FarmApiError('FARM_RECORD_CHANGED', '农场观测已更新，需要重新读取最新记录。');
  return { ...detail, events: [...previous.events, ...detail.events] };
}

export function mergeExchangePages(previous, page, cursor = 'start') {
  if (cursor === 'start') return { ...page, items: [...page.items] };
  const seen = new Set(previous?.items.map(item => item.id));
  if (!previous || previous.ownerId !== page.ownerId || previous.environment !== page.environment ||
    previous.nextCursor !== cursor || page.items.some(item => seen.has(item.id))) {
    throw new FarmApiError('READ_SUPERSEDED', '兑换记录已更新，请刷新后继续查看。');
  }
  return { ...page, items: [...previous.items, ...page.items] };
}

export function createFarmClient({ baseURL = '', transport, generateKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}` }) {
  const base = baseURL.replace(/\/$/, '');
  if (base && !/^(https:\/\/[a-zA-Z0-9.-]+(?::\d+)?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)(?:\/[a-zA-Z0-9_~.-]+)*$/.test(base)) {
    throw new Error('服务地址必须使用 HTTPS，本机联调仅允许 loopback HTTP');
  }
  let token = '', profile = null, snapshot = null, pending = null, generation = 0, loginAttempt = 0, activeLogins = 0, activeMutation = false;
  let authorizationWait = null;
  let authEnvironment = null;
  let minimumConfirmedRevision = 0, confirmedAccountId = '', confirmedEnvironment = null;
  let recoveryDiscovery = 'unknown', recoveryError = '', recoveryMeta = null, recoveryRead = 0;
  let privacy = null, deletionProposal = null, deletionAttempt = 0;
  let farmPage = null, farmDetail = null, farmPageRead = 0, farmDetailRead = 0;
  let exchangePage = null, exchangeDetail = null, exchangePageRead = 0, exchangeDetailRead = 0;
  let confirmedCheckout = null, exchangeDetailOperationKey = '';
  let friendsView = null, friendsRead = 0, friendsVersion = -1;
  let forumStatus = null, forumPage = null, forumDetail = null, forumReports = null;
  let forumStatusRead = 0, forumPageRead = 0, forumDetailRead = 0, forumReportsRead = 0;
  let plantingStatus = null, plantingRecord = null, plantingPage = null, plantingDetail = null;
  let plantingStatusRead = 0, plantingRecordRead = 0, plantingPageRead = 0, plantingDetailRead = 0;
  let eggsStatus = null, eggsRecord = null, eggsRecords = null, eggsPage = null, eggsDetail = null;
  let eggsStatusRead = 0, eggsRecordRead = 0, eggsRecordsRead = 0, eggsPageRead = 0, eggsDetailRead = 0;
  function clearEggs() {
    eggsStatus = null; eggsRecord = null; eggsRecords = null; eggsPage = null; eggsDetail = null;
    eggsStatusRead++; eggsRecordRead++; eggsRecordsRead++; eggsPageRead++; eggsDetailRead++;
  }
  function clearPlanting() {
    plantingStatus = null; plantingRecord = null; plantingPage = null; plantingDetail = null;
    plantingStatusRead++; plantingRecordRead++; plantingPageRead++; plantingDetailRead++;
  }
  function clearFriendsView() { friendsView = null; friendsRead++; }
  function clearForum() {
    forumStatus = null; forumPage = null; forumDetail = null; forumReports = null;
    forumStatusRead++; forumPageRead++; forumDetailRead++; forumReportsRead++;
  }
  function clearFarmRecords() {
    farmPage = null; farmDetail = null; farmPageRead++; farmDetailRead++;
    exchangePage = null; exchangeDetail = null; exchangePageRead++; exchangeDetailRead++;
    confirmedCheckout = null; exchangeDetailOperationKey = '';
    friendsView = null; friendsRead++; friendsVersion = -1;
    clearForum();
    clearPlanting();
    clearEggs();
  }
  const confirmedMutationRefusals = new WeakSet();
  const error = (code, message, status) => new FarmApiError(code, message, status);
  const assetSyncRequired = () => minimumConfirmedRevision > 0 && (!snapshot || snapshot.revision < minimumConfirmedRevision);
  function acceptSnapshot(value, historical = false) {
    if (!isFarmSnapshot(value, profile?.id) || value.environment !== authEnvironment) throw error('SERVER_UNAVAILABLE', '田园数据未能确认，请重新同步。');
    if (!historical && value.revision < minimumConfirmedRevision) throw error('ASSET_SYNC_REQUIRED', '原收蛋结果已确认，当前资产尚未同步到该结果。请重新同步，确认前暂不能提交新操作。');
    if (historical && value.revision < minimumConfirmedRevision) return snapshot;
    if (!snapshot || value.revision >= snapshot.revision) snapshot = value;
    if (deletionProposal && deletionProposal.revision !== snapshot.revision) cancelAccountDeletion();
    return snapshot;
  }
  function requireSession() {
    if (!base) throw error('SERVICE_UNCONFIGURED', '农场服务尚未配置，请稍后再来。');
    if (!token) throw error('SESSION_REQUIRED', '请先登录，再查看自己的田园。');
  }
  function responseFailure(response, authenticated, key, fallback, financial = true) {
    const code = response.data?.error?.code || 'REQUEST_REJECTED';
    const failure = error(code, response.data?.error?.message || fallback, response.status);
    // These exact Store refusals follow the successful-receipt lookup. A
    // generic gateway/status code cannot establish an earlier attempt's result.
    const afterReceiptLookup = (response.status === 409 && ['IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT'].includes(code)) ||
      (response.status === 422 && code === 'BUSINESS_RULE') || (response.status === 503 && code === 'CAPABILITY_UNAVAILABLE');
    if (financial && authenticated && key && afterReceiptLookup && isFarmSnapshot(response.data?.data, profile?.id)) {
      acceptSnapshot(response.data.data, true); confirmedMutationRefusals.add(failure);
    }
    return failure;
  }
  async function send(path, method, body, authenticated = true, key = '', financial = true) {
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
        throw responseFailure(response, authenticated, key, '这项农场服务暂未开放。', financial);
      }
      throw error('SERVER_UNAVAILABLE', '农场服务暂时繁忙，请稍后重试。', response?.status || 0);
    }
    if (response.status >= 400) {
      if (response.status === 401 && authenticated) { token = ''; snapshot = null; privacy = null; recoveryDiscovery = 'unknown'; recoveryMeta = null; recoveryRead++; clearFarmRecords(); cancelAccountDeletion(); generation++; }
      if (financial && response.status === 409 && response.data?.data) acceptSnapshot(response.data.data, true);
      throw responseFailure(response, authenticated, key, '操作未完成，请刷新后核对。', financial);
    }
    if (!response.data || !Object.prototype.hasOwnProperty.call(response.data, 'data')) throw error('SERVER_UNAVAILABLE', '服务回复未能确认，请稍后重试。');
    return response.data.data;
  }
  function invalidateAuthorization() {
    const wait = authorizationWait;
    if (wait) wait.invalidate();
  }
  function awaitAuthorization(requestCode, attempt) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const wait = { invalidate: () => finish(error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。')) };
      function finish(failure, code) {
        if (settled) return;
        settled = true;
        if (authorizationWait === wait) authorizationWait = null;
        if (failure) reject(failure); else resolve(code);
      }
      authorizationWait = wait;
      Promise.resolve().then(() => {
        if (settled || attempt !== loginAttempt) throw error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。');
        return requestCode();
      }).then(code => finish(null, code), () => finish(error('PLATFORM_AUTHORIZATION_FAILED', '平台授权未能完成，请返回后重新尝试。')));
    });
  }
  async function login(path, body, requestCode = null) {
    if (activeMutation || pending?.kind === 'deletion') throw error('PENDING_OPERATION', '正在核对上次操作，请核对完成后再登录或切换账户。');
    const attempt = ++loginAttempt;
    invalidateAuthorization();
    activeLogins++;
    try {
      let requestBody = body;
      if (requestCode) {
        const code = await awaitAuthorization(requestCode, attempt);
        // Authorizing outside this attempt would let a code returned after
        // logout start a fresh HTTP login and revive the departed account.
        if (attempt !== loginAttempt) throw error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。');
        if (typeof code !== 'string' || code.length < 1 || code.length > 4096 || /[\u0000-\u001f]/u.test(code)) {
          throw error('INVALID_PLATFORM_CODE', '平台未返回有效登录凭证，请重新授权。');
        }
        requestBody = { ...body, code };
      }
      const raw = await send(path, 'POST', requestBody, false);
      if (attempt !== loginAttempt) throw error('SESSION_CHANGED', '登录请求已更新，请以当前账户为准。');
      let result;
      try { result = parseSession(raw); }
      catch { throw error('INVALID_SESSION', '登录回复不完整，请重试。'); }
      if (pending && (pending.accountId !== result.profile.id || (pending.environment && pending.environment !== result.environment))) throw error('ACCOUNT_MISMATCH', '上次操作仍待核对，请登录操作时的原账户，再核对结果。');
      if (confirmedAccountId !== result.profile.id || confirmedEnvironment !== result.environment) minimumConfirmedRevision = 0;
      confirmedAccountId = result.profile.id; confirmedEnvironment = result.environment;
      token = result.token; profile = result.profile; authEnvironment = result.environment; snapshot = null; privacy = null; clearFarmRecords(); cancelAccountDeletion(); generation++;
      recoveryDiscovery = 'checking'; recoveryMeta = null; recoveryError = '';
      try { await discoverRecovery(); }
      catch (failure) { if (attempt !== loginAttempt || !token) throw failure; recoveryDiscovery = 'error'; recoveryError = failure.message; }
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
      // A historical financial replay settles its original key even if a
      // later confirmed egg receipt establishes a newer asset revision floor.
      acceptSnapshot(result, true);
      if (operation.path === '/checkout') {
        confirmedCheckout = { key: operation.key, accountId: operation.accountId, environment: result.environment };
        exchangePage = null; exchangePageRead++;
      }
      pending = null; return snapshot;
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
    if (recoveryDiscovery !== 'clear') throw error('RECOVERY_REQUIRED', '请先检查并核对上次操作，再继续新的操作。');
    if (assetSyncRequired()) throw error('ASSET_SYNC_REQUIRED', '原收蛋结果已确认，请先同步最新田园资产，再继续新的操作。');
  }
  async function submitFriends(operation) {
    activeMutation = true; clearFriendsView(); clearForum();
    try {
      const receipt = await send('/friends/commands', 'POST', operation.body, true, operation.key, false);
      if (!isFriendCommandReceipt(receipt, operation.accountId, operation.environment, operation.key, operation.body.action)) {
        throw error('SERVER_UNAVAILABLE', '农友操作回执未能确认。');
      }
      // A historical receipt only settles its original command. Current social
      // data is read independently; it must never enter financial state.
      pending = null; clearFriendsView(); clearForum();
      return receipt;
    } catch (failure) {
      pending = operation;
      if (failure.status === 401) throw failure;
      throw error('RESULT_UNKNOWN', '农友操作的结果尚未确认。请核对上次操作，避免重复申请。');
    } finally { activeMutation = false; }
  }
  async function submitForum(operation) {
    activeMutation = true; clearForum();
    if (operation.body.action === 'block-author') clearFriendsView();
    try {
      const receipt = await send('/forum/commands', 'POST', operation.body, true, operation.key, false);
      if (!isForumCommandReceipt(receipt, operation.accountId, operation.environment, operation.key, operation.body.action)) throw error('SERVER_UNAVAILABLE', '社区操作回执未能确认。');
      pending = null; clearForum();
      if (operation.body.action === 'block-author') clearFriendsView();
      return receipt;
    } catch (failure) {
      pending = operation;
      if (failure.status === 401) throw failure;
      throw error('RESULT_UNKNOWN', '社区操作结果尚未确认。请核对上次操作，避免重复提交。');
    } finally { activeMutation = false; }
  }
  function forumReadContext(cursor = 'start') {
    requireSession();
    if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步当前田园，再查看社区。');
    if (activeMutation) throw error('PENDING_OPERATION', '正在核对操作，请稍后刷新社区。');
    if (cursor !== 'start' && !isForumId(cursor)) throw error('INVALID_REQUEST', '社区分页位置无效，请刷新。');
    return { ownerId: profile.id, environment: snapshot.environment, generation };
  }
  function plantingReadContext(audience = 'customer', cursor = 'start') {
    requireSession();
    if (!['customer', 'staff'].includes(audience) || (cursor !== 'start' && !isPlantingId(cursor))) throw error('INVALID_REQUEST', '作业入口或分页位置无效，请返回重新选择。');
    if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步当前田园，再查看播种作业。');
    if (activeMutation) throw error('PENDING_OPERATION', '正在核对操作，请稍后刷新作业。');
    return { ownerId: profile.id, environment: snapshot.environment, generation };
  }
  function eggsReadContext(audience = 'customer', cursor = 'start') {
    requireSession();
    if (!['customer', 'staff'].includes(audience) || (cursor !== 'start' && !isEggsId(cursor))) throw error('INVALID_REQUEST', '收蛋入口或分页位置无效，请返回重新选择。');
    if (activeMutation) throw error('PENDING_OPERATION', '正在核对操作，请稍后刷新产出。');
    return { ownerId: profile.id, environment: authEnvironment, generation };
  }
  const sameCommand = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const isRecoveryOperation = operation => operation?.kind === 'planting' || operation?.kind === 'eggs';
  function observeReceipt(receipt) {
    if (receipt?.eggFormat === 1 && receipt.action === 'collect' && receipt.outcome === 'applied') {
      minimumConfirmedRevision = Math.max(minimumConfirmedRevision, receipt.appliedRevision);
      cancelAccountDeletion();
    }
  }
  function hydrateIntent(intent, operation = null, cold = true) {
    if (!intent || intent.phase === 'abandoned' || intent.closedAt !== null) return null;
    const previous = operation?.intent;
    if (previous && (intent.id !== previous.id || intent.version < previous.version ||
      !sameCommand(intent.command, previous.command) || intent.operationKey !== previous.operationKey)) {
      throw error('SERVER_UNAVAILABLE', '原操作记录未能确认，请保留并重新核对。');
    }
    observeReceipt(intent.receipt);
    return { kind: intent.command.domain === 'eggs' ? 'eggs' : 'planting', accountId: profile.id, environment: authEnvironment,
      audience: intent.audience, body: intent.command, key: intent.operationKey, intent,
      attempt: operation?.attempt || null, cold: operation?.cold ?? cold,
      stage: intent.phase === 'settled' ? 'receipt-review' : intent.phase };
  }
  async function discoverRecovery() {
    requireSession();
    const read = ++recoveryRead, session = generation;
    recoveryDiscovery = 'checking'; recoveryError = '';
    try {
      const value = await send('/account/recovery', 'GET', undefined, true, '', false);
      if (read !== recoveryRead || session !== generation) throw error('SESSION_CHANGED', '账户恢复检查已更新。');
      if (!isRecoveryView(value, profile.id, authEnvironment) ||
        (recoveryMeta?.epoch === value.epoch && value.version < recoveryMeta.version)) throw error('SERVER_UNAVAILABLE', '上次操作检查回复未能确认，请重试检查。');
      recoveryMeta = { epoch: value.epoch, version: value.version, available: value.available };
      // An existing unknown operation is the only command slot. Never replace
      // it with a different device's open intent, nor forget a late prepare.
      if (!pending) pending = hydrateIntent(value.intent);
      // Even when another unknown command owns the one local slot, a valid
      // remote original receipt is evidence of the same account's asset floor.
      observeReceipt(value.intent?.receipt);
      recoveryDiscovery = value.intent || isRecoveryOperation(pending) ? 'open' : 'clear';
      return value;
    } catch (failure) {
      if (read === recoveryRead && session === generation) { recoveryDiscovery = 'error'; recoveryError = failure.message; }
      throw failure;
    }
  }
  async function recoveryPost(operation, action) {
    activeMutation = true;
    // Acknowledgement only closes the original receipt. It cannot change the
    // independently read current business views, including an unknown ack.
    if (action !== 'ack') { clearPlanting(); clearEggs(); }
    cancelAccountDeletion();
    pending = operation; recoveryDiscovery = 'open';
    const unknown = { prepare: 'prepare-unknown', execute: 'execute-unknown', ack: 'ack-unknown', abandon: 'abandon-unknown' };
    operation.stage = unknown[action];
    try {
      const value = await send('/account/recovery/' + action, 'POST', action === 'prepare' ? operation.attempt : { intentId: operation.intent.id }, true, '', false);
      if (!isRecoveryResult(value, operation.accountId, operation.environment, action, action === 'prepare' ? operation.attempt : undefined) ||
        (action !== 'prepare' && value.intent?.id !== operation.intent.id)) throw error('SERVER_UNAVAILABLE', '原操作恢复回复未能确认。');
      const target = value.intent;
      // Result.intent is always the original target; currentIntentId may refer
      // to a newer operation and must be discovered separately, never hydrated
      // from this historical command's response.
      if (target && operation.intent && (target.version < operation.intent.version || !sameCommand(target.command, operation.intent.command))) throw error('SERVER_UNAVAILABLE', '原操作版本未能确认。');
      recoveryMeta = { epoch: value.epoch, version: value.version, available: recoveryMeta?.available ?? true };
      if (action === 'prepare' && value.code !== 'OK') {
        pending = null; await discoverRecovery();
        throw error(value.code, '操作准备状态已变化，请核对恢复项后重新决定。');
      }
      if (!target) throw error('SERVER_UNAVAILABLE', '原操作记录缺失。');
      const originalReceipt = target.receipt;
      observeReceipt(originalReceipt);
      if (target.closedAt !== null) {
        pending = null; await discoverRecovery();
      } else {
        pending = hydrateIntent(target, operation, false);
        if (!pending) throw error('SERVER_UNAVAILABLE', '原操作阶段未能确认。');
      }
      return originalReceipt;
    } catch (failure) {
      // Explicit prepare refusal has already been validated and discovered.
      if (pending !== operation) throw failure;
      if (failure.status === 401) throw failure;
      throw error('RESULT_UNKNOWN', action === 'ack' ? '原结果已取得，确认状态尚待核对。请重试原确认。' : '原操作状态尚未确认，请核对上次操作。');
    } finally { activeMutation = false; }
  }
  async function inspectPlanting(operation) {
    activeMutation = true;
    try {
      const value = await send('/account/recovery/intent/' + operation.intent.id, 'GET', undefined, true, '', false);
      if (!isRecoveryDetail(value, operation.accountId, operation.environment, operation.intent.id)) throw error('SERVER_UNAVAILABLE', '原操作记录未能确认。');
      if (value.intent.version < operation.intent.version) throw error('SERVER_UNAVAILABLE', '原操作版本未能确认。');
      const receipt = value.intent.receipt;
      observeReceipt(receipt);
      if (value.intent.closedAt !== null) { pending = null; await discoverRecovery(); }
      else pending = hydrateIntent(value.intent, operation);
      return receipt;
    } finally { activeMutation = false; }
  }
  function requirePlantingStage(stages) {
    requireSession();
    if (activeMutation || activeLogins || !isRecoveryOperation(pending) || !stages.includes(pending.stage)) throw error('PENDING_OPERATION', '请先核对当前恢复项。');
    return pending;
  }
  async function submitDeletion(operation) {
    activeMutation = true;
    try {
      const receipt = await send(operation.path, 'POST', operation.body, false);
      if (receipt?.deleted !== true || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < 0) throw error('SERVER_UNAVAILABLE', '注销结果尚未确认。');
      token = ''; profile = null; snapshot = null; privacy = null; pending = null; clearFarmRecords();
      minimumConfirmedRevision = 0; confirmedAccountId = ''; confirmedEnvironment = null;
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
      if (failure.status === 401) { token = ''; snapshot = null; privacy = null; clearFarmRecords(); generation++; }
      throw failure;
    } finally { activeMutation = false; }
  }
  return {
    get authenticated() { return !!token; },
    get profile() { return profile; },
    get snapshot() { return snapshot; },
    get configured() { return !!base; },
    get privacy() { return privacy; },
    get farmPage() { return farmPage; },
    get farmDetail() { return farmDetail; },
    get exchangePage() { return exchangePage; },
    get exchangeDetail() { return exchangeDetail; },
    get friendsView() { return friendsView; },
    get forumStatus() { return forumStatus; },
    get forumPage() { return forumPage; },
    get forumDetail() { return forumDetail; },
    get forumReports() { return forumReports; },
    get plantingStatus() { return plantingStatus; },
    get plantingRecord() { return plantingRecord; },
    get plantingPage() { return plantingPage; },
    get plantingDetail() { return plantingDetail; },
    get eggsStatus() { return eggsStatus; },
    get eggsRecord() { return eggsRecord; },
    get eggsRecords() { return eggsRecords; },
    get eggsPage() { return eggsPage; },
    get eggsDetail() { return eggsDetail; },
    get recoveryDiscovery() { return recoveryDiscovery; },
    get recoveryError() { return recoveryError; },
    get recoveryIntent() { return isRecoveryOperation(pending) ? pending.intent || null : null; },
    get pendingStage() { return isRecoveryOperation(pending) ? pending.stage : null; },
    get minimumConfirmedRevision() { return minimumConfirmedRevision; },
    get assetSyncRequired() { return assetSyncRequired(); },
    get mutationBlocked() { return recoveryDiscovery !== 'clear' || !!pending || activeMutation || activeLogins > 0 || assetSyncRequired(); },
    discoverRecovery,
    async continuePlanting() { return recoveryPost(requirePlantingStage(['prepared']), 'execute'); },
    async acknowledgePlanting(intentId = pending?.intent?.id) { const operation = requirePlantingStage(['receipt-review', 'ack-unknown']); if (operation.intent.id !== intentId) throw error('PENDING_OPERATION', '待确认结果已变化，请查看当前原结果后再确认。'); return recoveryPost(operation, 'ack'); },
    async abandonPlanting() { return recoveryPost(requirePlantingStage(['prepared', 'abandon-unknown']), 'abandon'); },
    async continueRecovery() { return recoveryPost(requirePlantingStage(['prepared']), 'execute'); },
    async acknowledgeRecovery(intentId = pending?.intent?.id) { const operation = requirePlantingStage(['receipt-review', 'ack-unknown']); if (operation.intent.id !== intentId) throw error('PENDING_OPERATION', '待确认结果已变化，请查看当前原结果后再确认。'); return recoveryPost(operation, 'ack'); },
    async abandonRecovery() { return recoveryPost(requirePlantingStage(['prepared', 'abandon-unknown']), 'abandon'); },
    get pendingKind() { return pending?.kind || (pending ? 'assets' : null); },
    get hasConfirmedCheckout() { return !!confirmedCheckout && !!token && confirmedCheckout.accountId === profile?.id; },
    get deletionPrepared() { return !!deletionProposal; },
    get pendingCanRetryWithoutAuth() { return pending?.kind === 'deletion'; },
    hasPending() { return !!pending; },
    loginDevelopment(account) { return login('/auth/development', { account }); },
    loginPlatform(platform, code) { return login('/auth/platform', { platform, code }); },
    async authorizePlatform(platform, requestCode) {
      if (!['weixin', 'toutiao', 'weixin-app'].includes(platform) || typeof requestCode !== 'function') {
        throw error('INVALID_AUTHORIZATION_REQUEST', '平台授权配置暂不可用，请稍后重试。');
      }
      if (!base) throw error('SERVICE_UNCONFIGURED', '农场服务尚未配置，请稍后再来。');
      return login('/auth/platform', { platform }, requestCode);
    },
    async load() {
      const requestGeneration = generation, result = await send('/bootstrap', 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      return acceptSnapshot(result);
    },
    async loadFriends() {
      requireSession();
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步当前田园，再查看我的农友。');
      if (activeMutation) throw error('PENDING_OPERATION', '正在核对操作，请稍后刷新农友。');
      const read = ++friendsRead, requestGeneration = generation, ownerId = profile.id, environment = snapshot.environment;
      const value = await send('/friends', 'GET', undefined, true, '', false);
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前农友。');
      if (read !== friendsRead || value?.version < friendsVersion) throw error('READ_SUPERSEDED', '农友关系已更新，请刷新后重新核对。');
      if (!isFriendsView(value, ownerId, environment)) throw error('SERVER_UNAVAILABLE', '农友资料未能确认，请重新加载。');
      friendsView = value; friendsVersion = value.version; return friendsView;
    },
    async commandFriends(command) {
      requireSession(); requireIdle();
      if (!command || Object.hasOwn(command, 'expectedVersion') || !isFriendCommand({ ...command, expectedVersion: 0 })) throw error('INVALID_REQUEST', '农友操作无效，请返回重新选择。');
      if (!friendsView || friendsView.ownerId !== profile.id) throw error('FRIENDS_VIEW_REQUIRED', '请先刷新农友资料，再重新核对操作。');
      cancelAccountDeletion();
      const operation = { kind: 'friends', accountId: profile.id, environment: friendsView.environment, key: generateKey(),
        body: JSON.parse(JSON.stringify({ ...command, expectedVersion: friendsView.version })) };
      return submitFriends(operation);
    },
    async loadForumStatus() {
      const context = forumReadContext(), read = ++forumStatusRead;
      const value = await send('/forum/status', 'GET', undefined, true, '', false);
      if (read !== forumStatusRead || context.generation !== generation) throw error('READ_SUPERSEDED', '社区状态已更新，请刷新。');
      if (!isForumStatus(value, context.ownerId, context.environment)) throw error('SERVER_UNAVAILABLE', '社区状态未能确认，请重新读取。');
      forumStatus = value;
      if (!value.available) { forumPage = null; forumDetail = null; forumReports = null; forumPageRead++; forumDetailRead++; forumReportsRead++; }
      return value;
    },
    async loadForumPage(scope = 'public', circle = 'all', cursor = 'start') {
      const context = forumReadContext(cursor), read = ++forumPageRead;
      if (!['public', 'mine'].includes(scope) || !['all', 'harvest', 'questions', 'chat'].includes(circle) || (scope === 'mine' && circle !== 'all')) throw error('INVALID_REQUEST', '社区分类无效。');
      if (forumPage?.scope !== scope || forumPage?.circle !== circle) forumPage = null;
      const value = await send(scope === 'mine' ? `/forum/mine/${cursor}` : `/forum/posts/${circle}/${cursor}`, 'GET', undefined, true, '', false);
      if (read !== forumPageRead || context.generation !== generation) throw error('READ_SUPERSEDED', '社区列表已更新，请查看当前选择。');
      if (!isForumPage(value, context.ownerId, context.environment, scope, circle) || value.items.some(item => item.id === cursor)) throw error('SERVER_UNAVAILABLE', '社区列表未能确认，请刷新。');
      forumPage = value; return value;
    },
    async loadForumDetail(id, cursor = 'start') {
      const context = forumReadContext(cursor), read = ++forumDetailRead;
      if (!isForumId(id)) throw error('INVALID_REQUEST', '帖子编号无效。');
      if (forumDetail?.post.id !== id) forumDetail = null;
      const value = await send(`/forum/post/${id}/${cursor}`, 'GET', undefined, true, '', false);
      if (read !== forumDetailRead || context.generation !== generation) throw error('READ_SUPERSEDED', '已选择其他帖子，请查看当前页面。');
      if (!isForumDetail(value, context.ownerId, context.environment, id) || value.comments.some(item => item.id === cursor)) throw error('SERVER_UNAVAILABLE', '帖子内容未能确认，请刷新。');
      forumDetail = value; return value;
    },
    async loadForumReports(cursor = 'start') {
      const context = forumReadContext(cursor), read = ++forumReportsRead;
      const value = await send(`/forum/reports/${cursor}`, 'GET', undefined, true, '', false);
      if (read !== forumReportsRead || context.generation !== generation) throw error('READ_SUPERSEDED', '举报记录已更新，请刷新。');
      if (!isForumReports(value, context.ownerId, context.environment) || value.items.some(item => item.id === cursor)) throw error('SERVER_UNAVAILABLE', '举报记录未能确认，请刷新。');
      forumReports = value; return value;
    },
    async commandForum(command) {
      requireSession(); requireIdle();
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步当前田园，再操作社区。');
      if (!isForumCommand(command)) throw error('INVALID_REQUEST', '请检查内容长度和格式，再提交审核。');
      cancelAccountDeletion();
      return submitForum({ kind: 'forum', accountId: profile.id, environment: snapshot.environment, key: generateKey(), body: JSON.parse(JSON.stringify(command)) });
    },
    async loadPlantingStatus() {
      const context = plantingReadContext(), read = ++plantingStatusRead;
      plantingStatus = null;
      const value = await send('/planting/status', 'GET', undefined, true, '', false);
      if (read !== plantingStatusRead || context.generation !== generation) throw error('READ_SUPERSEDED', '播种服务状态已更新，请刷新。');
      if (!isPlantingStatus(value, context.ownerId, context.environment)) throw error('SERVER_UNAVAILABLE', '播种服务状态未能确认，请重新读取。');
      if (!value.available) clearPlanting();
      plantingStatus = value; return value;
    },
    async loadPlantingRecord(id) {
      const context = plantingReadContext(), read = ++plantingRecordRead;
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) throw error('INVALID_REQUEST', '种植档案位置无效。');
      plantingRecord = null;
      const value = await send(`/planting/record/${id}`, 'GET', undefined, true, '', false);
      if (read !== plantingRecordRead || context.generation !== generation) throw error('READ_SUPERSEDED', '已选择其他档案，请刷新当前对象。');
      if (!isPlantingRecord(value, context.ownerId, context.environment, id)) throw error('SERVER_UNAVAILABLE', '播种申请资格未能确认，请重新读取。');
      plantingRecord = value; return value;
    },
    async loadPlantingPage(audience = 'customer', cursor = 'start') {
      const context = plantingReadContext(audience, cursor), read = ++plantingPageRead;
      const value = await send(`${audience === 'staff' ? '/staff' : ''}/planting/orders/${cursor}`, 'GET', undefined, true, '', false);
      if (read !== plantingPageRead || context.generation !== generation) throw error('READ_SUPERSEDED', '作业列表已更新，请查看当前入口。');
      if (!isPlantingPage(value, context.ownerId, context.environment) || (cursor !== 'start' && value.items.some(item => item.id <= cursor))) throw error('SERVER_UNAVAILABLE', '播种作业列表未能确认，请刷新。');
      plantingPage = value; return value;
    },
    async loadPlantingDetail(id, audience = 'customer') {
      const context = plantingReadContext(audience), read = ++plantingDetailRead;
      if (!isPlantingId(id)) throw error('INVALID_REQUEST', '作业编号无效，请重新选择。');
      plantingDetail = null;
      const value = await send(`${audience === 'staff' ? '/staff' : ''}/planting/order/${id}`, 'GET', undefined, true, '', false);
      if (read !== plantingDetailRead || context.generation !== generation) throw error('READ_SUPERSEDED', '已选择其他作业，请查看当前对象。');
      if (!isPlantingDetail(value, context.ownerId, context.environment, id)) throw error('SERVER_UNAVAILABLE', '播种作业详情未能确认，请重新读取。');
      plantingDetail = value; return value;
    },
    async commandPlanting(command, audience = 'customer') {
      requireSession(); requireIdle();
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步当前田园，再操作播种作业。');
      if (!['customer', 'staff'].includes(audience) || !isPlantingCommand(command, audience)) throw error('INVALID_REQUEST', '播种操作无效，请刷新后重新选择。');
      cancelAccountDeletion();
      if (!recoveryMeta?.available) throw error('RECOVERY_UNAVAILABLE', '播种操作恢复服务暂未开放。');
      const operation = { kind: 'planting', accountId: profile.id, environment: snapshot.environment, cold: false, intent: null, stage: 'prepare-unknown', attempt: JSON.parse(JSON.stringify({ expectedEpoch: recoveryMeta.epoch, expectedVersion: recoveryMeta.version, audience, command })) };
      const preparedReceipt = await recoveryPost(operation, 'prepare');
      if (pending?.stage === 'prepared' && pending.attempt === operation.attempt) return recoveryPost(pending, 'execute');
      return preparedReceipt;
    },
    async loadEggsStatus() {
      const context = eggsReadContext(), read = ++eggsStatusRead;
      const value = await send('/eggs/status', 'GET', undefined, true, '', false);
      if (read !== eggsStatusRead || context.generation !== generation) throw error('READ_SUPERSEDED', '收蛋服务状态已更新，请刷新。');
      if (!isEggsStatus(value, context.ownerId, context.environment)) throw error('SERVER_UNAVAILABLE', '收蛋服务状态未能确认，请重新读取。');
      if (!value.available) clearEggs();
      eggsStatus = value; return value;
    },
    async loadEggsRecord(id, audience = 'customer') {
      const context = eggsReadContext(audience), read = ++eggsRecordRead;
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) throw error('INVALID_REQUEST', '牧场档案位置无效。');
      eggsRecord = null;
      const value = await send(`${audience === 'staff' ? '/staff' : ''}/eggs/record/${id}`, 'GET', undefined, true, '', false);
      if (read !== eggsRecordRead || context.generation !== generation) throw error('READ_SUPERSEDED', '已选择其他档案，请刷新当前对象。');
      if (!isEggsRecord(value, context.ownerId, context.environment, id)) throw error('SERVER_UNAVAILABLE', '当日产出登记资格未能确认，请重新读取。');
      eggsRecord = value; return value;
    },
    async loadEggsRecords(cursor = 'start') {
      const context = eggsReadContext('staff'), read = ++eggsRecordsRead;
      if (cursor !== 'start' && (typeof cursor !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(cursor))) throw error('INVALID_REQUEST', '授权对象分页位置无效，请刷新。');
      const value = await send(`/staff/eggs/records/${cursor}`, 'GET', undefined, true, '', false);
      if (read !== eggsRecordsRead || context.generation !== generation) throw error('READ_SUPERSEDED', '授权对象已更新，请刷新。');
      if (!isEggsRecordsPage(value, context.ownerId, context.environment) || (cursor !== 'start' && value.items.some(item => item.recordId <= cursor))) throw error('SERVER_UNAVAILABLE', '授权牧场对象未能确认，请重新读取。');
      eggsRecords = value; return value;
    },
    async loadEggsPage(audience = 'customer', cursor = 'start') {
      const context = eggsReadContext(audience, cursor), read = ++eggsPageRead;
      const value = await send(`${audience === 'staff' ? '/staff' : ''}/eggs/batches/${cursor}`, 'GET', undefined, true, '', false);
      if (read !== eggsPageRead || context.generation !== generation) throw error('READ_SUPERSEDED', '产出列表已更新，请查看当前入口。');
      if (!isEggsPage(value, context.ownerId, context.environment) || (cursor !== 'start' && value.items.some(item => item.id <= cursor))) throw error('SERVER_UNAVAILABLE', '鸡蛋产出列表未能确认，请重新读取。');
      eggsPage = value; return value;
    },
    async loadEggsDetail(id, audience = 'customer') {
      const context = eggsReadContext(audience), read = ++eggsDetailRead;
      if (!isEggsId(id)) throw error('INVALID_REQUEST', '产出编号无效，请重新选择。');
      eggsDetail = null;
      const value = await send(`${audience === 'staff' ? '/staff' : ''}/eggs/batch/${id}`, 'GET', undefined, true, '', false);
      if (read !== eggsDetailRead || context.generation !== generation) throw error('READ_SUPERSEDED', '已选择其他产出，请查看当前对象。');
      if (!isEggsDetail(value, context.ownerId, context.environment, id)) throw error('SERVER_UNAVAILABLE', '鸡蛋产出详情未能确认，请重新读取。');
      eggsDetail = value; return value;
    },
    async commandEggs(audience, command) {
      requireSession(); requireIdle();
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步当前田园，再登记或收取鸡蛋。');
      if (command?.domain !== 'eggs' || !isRecoveryCommand(command, audience)) throw error('INVALID_REQUEST', '收蛋操作无效，请核对数量、来源编号和当前产出。');
      if (command.action === 'collect' && command.expectedRevision !== snapshot.revision) throw error('VERSION_CONFLICT', '田园资产已更新，请重新核对本次收取。');
      if (!recoveryMeta?.available) throw error('RECOVERY_UNAVAILABLE', '操作恢复服务暂未开放。');
      cancelAccountDeletion();
      const operation = { kind: 'eggs', accountId: profile.id, environment: authEnvironment, cold: false, intent: null, stage: 'prepare-unknown', attempt: JSON.parse(JSON.stringify({ expectedEpoch: recoveryMeta.epoch, expectedVersion: recoveryMeta.version, audience, command })) };
      const preparedReceipt = await recoveryPost(operation, 'prepare');
      if (pending?.stage === 'prepared' && pending.attempt === operation.attempt) return recoveryPost(pending, 'execute');
      return preparedReceipt;
    },
    async loadFarmPage(kind, cursor = 'start') {
      requireSession();
      if (!['plots', 'animals'].includes(kind) || (cursor !== 'start' && (typeof cursor !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(cursor)))) throw error('INVALID_REQUEST', '档案分类或分页位置无效，请重新加载。');
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步田园数据，再查看农场档案。');
      const read = ++farmPageRead, requestGeneration = generation, ownerId = profile.id, environment = snapshot.environment;
      const value = await send(`/farm/records/${kind}/${cursor}`, 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      if (read !== farmPageRead) throw error('READ_SUPERSEDED', '档案列表已更新，请以当前选择为准。');
      if (!isFarmPage(value, ownerId, kind, environment) || (cursor !== 'start' && value.items.some(item => item.id <= cursor))) throw error('SERVER_UNAVAILABLE', '农场档案未能确认，请重新加载。');
      farmPage = value; return farmPage;
    },
    async loadFarmDetail(id, beforeVersion = 0) {
      requireSession();
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(id) || !Number.isSafeInteger(beforeVersion) || beforeVersion < 0) throw error('INVALID_REQUEST', '档案或分页位置无效，请返回重新选择。');
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步田园数据，再查看农场档案。');
      const read = ++farmDetailRead, requestGeneration = generation, ownerId = profile.id, environment = snapshot.environment;
      const value = await send(`/farm/record/${id}/${beforeVersion}`, 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      if (read !== farmDetailRead) throw error('READ_SUPERSEDED', '已选择其他档案，请查看当前对象。');
      if (!isFarmDetail(value, ownerId, id, environment) || (beforeVersion > 0 && value.events.some(event => event.version >= beforeVersion))) throw error('SERVER_UNAVAILABLE', '观测记录未能确认，请重新加载。');
      farmDetail = value; return farmDetail;
    },
    async loadExchangePage(cursor = 'start') {
      requireSession();
      if (cursor !== 'start' && !isExchangeId(cursor)) throw error('INVALID_REQUEST', '兑换记录翻页位置无效，请刷新记录。');
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步田园数据，再查看兑换记录。');
      const read = ++exchangePageRead, requestGeneration = generation, ownerId = profile.id, environment = snapshot.environment;
      const value = await send(`/account/exchanges/${cursor}`, 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      if (read !== exchangePageRead) throw error('READ_SUPERSEDED', '兑换记录已更新，请以当前列表为准。');
      if (!isExchangePage(value, ownerId, environment) || (cursor !== 'start' && value.items.some(item => item.id === cursor))) throw error('SERVER_UNAVAILABLE', '兑换记录未能确认，请重新加载。');
      exchangePage = value; return exchangePage;
    },
    async loadExchangeDetail(id) {
      requireSession();
      if (!isExchangeId(id)) throw error('INVALID_REQUEST', '兑换记录编号无效，请返回重新选择。');
      if (!snapshot) throw error('SNAPSHOT_REQUIRED', '请先同步田园数据，再查看兑换收据。');
      const read = ++exchangeDetailRead, requestGeneration = generation, ownerId = profile.id, environment = snapshot.environment;
      if (exchangeDetail?.exchange.id !== id) exchangeDetail = null;
      const value = await send(`/account/exchange/${id}`, 'GET');
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      if (read !== exchangeDetailRead) throw error('READ_SUPERSEDED', '兑换收据已更新，请以当前选择为准。');
      if (!isExchangeDetail(value, ownerId, environment) || value.exchange.id !== id) throw error('SERVER_UNAVAILABLE', '兑换收据未能确认，请重新加载。');
      exchangeDetail = value; exchangeDetailOperationKey = ''; return exchangeDetail;
    },
    async loadConfirmedCheckout() {
      requireSession();
      const checkout = confirmedCheckout;
      if (!checkout || checkout.accountId !== profile.id) throw error('CHECKOUT_RECEIPT_UNAVAILABLE', '本次运行没有可核对的已确认兑换，请查看全部记录。');
      if (checkout.environment !== authEnvironment) throw error('SESSION_CHANGED', '账户环境已变化，请查看当前田园。');
      const read = ++exchangeDetailRead, requestGeneration = generation, ownerId = profile.id, environment = authEnvironment;
      if (exchangeDetailOperationKey !== checkout.key) exchangeDetail = null;
      // Keep the original operation key in memory and the private request header.
      // A newer synchronized purchase must never become this operation's receipt.
      const value = await send('/account/checkout-receipt', 'GET', undefined, true, checkout.key);
      if (requestGeneration !== generation) throw error('SESSION_CHANGED', '账户会话已变化，请查看当前田园。');
      if (read !== exchangeDetailRead || confirmedCheckout !== checkout) throw error('READ_SUPERSEDED', '已确认的兑换已更新，请重新查看收据。');
      if (!isExchangeDetail(value, ownerId, environment)) throw error('SERVER_UNAVAILABLE', '兑换收据未能确认，请重新加载。');
      exchangeDetail = value; exchangeDetailOperationKey = checkout.key; return exchangeDetail;
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
      if (path === '/checkout') { confirmedCheckout = null; exchangeDetail = null; exchangeDetailOperationKey = ''; exchangeDetailRead++; }
      return submit(operation);
    },
    async retryPending() {
      if (activeMutation || activeLogins) throw error('PENDING_OPERATION', '正在登录或核对上次操作，请稍候。');
      if (pending?.kind === 'deletion') return submitDeletion(pending);
      requireSession();
      if (!pending) throw error('NO_PENDING_OPERATION', '没有需要核对的操作。');
      if (pending.accountId !== profile.id) throw error('ACCOUNT_MISMATCH', '请登录原来的账户，再核对上次操作。');
      if (isRecoveryOperation(pending)) {
        if (pending.stage === 'prepare-unknown') return recoveryPost(pending, 'prepare');
        if (pending.stage === 'ack-unknown') return recoveryPost(pending, 'ack');
        if (pending.stage === 'abandon-unknown') return recoveryPost(pending, 'abandon');
        if (pending.stage === 'execute-unknown') return inspectPlanting(pending);
        return pending.intent?.receipt || null;
      }
      let result;
      try {
        if (pending.kind === 'friends') result = await submitFriends(pending);
        else if (pending.kind === 'forum') result = await submitForum(pending);
        else result = await submit(pending, true);
      } catch (failure) {
        // A definitive original refusal may have settled this only slot. Find
        // the remote planting intent it previously obscured, while preserving
        // that refusal even if the independent discovery fails. Unknown
        // operations retain their slot and must never be replaced here.
        if (!pending && token && recoveryDiscovery !== 'clear') {
          try { await discoverRecovery(); } catch { /* discovery owns its error gate */ }
        }
        throw failure;
      }
      if (recoveryDiscovery !== 'clear') await discoverRecovery();
      return result;
    },
    async logout() {
      if (pending || activeMutation || recoveryDiscovery === 'checking' || recoveryDiscovery === 'error') throw error('PENDING_OPERATION', '请先核对上次操作的结果，再退出账户。');
      const requestToken = token, accountId = profile?.id; loginAttempt++;
      invalidateAuthorization();
      try { if (token) await send('/auth/logout', 'POST', {}); }
      finally { if (token === requestToken || (!token && profile?.id === accountId)) { token = ''; profile = null; snapshot = null; privacy = null; clearFarmRecords(); cancelAccountDeletion(); generation++; } }
    }
  };
}
