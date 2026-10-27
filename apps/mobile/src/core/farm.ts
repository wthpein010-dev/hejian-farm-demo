import { reactive, nextTick } from 'vue';
import { createFarmClient, mergeFarmPages, mergeFarmDetails, mergeExchangePages, isExchangeId } from './client.mjs';
import { isForumId, isPlantingId } from './client.mjs';
import type { RecoveryIntent, RecoveryDiscovery, RecoveryStage, PlantingAudience, PlantingStatus, PlantingRecord, PlantingPage, PlantingDetail, PlantingCommand, PlantingReceipt, PlantingState, PlantingAction } from './types';
import { requestNavigation } from './navigation.mjs';
import type { ForumStatus, ForumPage, ForumDetail, ForumReports, ForumCommand, ForumReceipt, ForumState, ForumCircle, ForumReason } from './types';
import type { Snapshot, PrivacyReport, FarmRegistryPage, FarmRegistryDetail, FarmRegistryKind, FarmRecord, FarmRecordStatus, ExchangePage, ExchangeDetail, FriendsView, FriendCommand, FriendCommandReceipt } from './types';

const baseURL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
const client = createFarmClient({ baseURL, transport: (request: { url: string; method: string; headers: object; body: unknown; timeout: number }) => new Promise((resolve, reject) => {
  uni.request({ url: request.url, method: request.method as 'GET' | 'POST', header: request.headers,
    data: request.body as Record<string, unknown>, timeout: request.timeout,
    success: response => resolve({ status: response.statusCode, data: response.data }), fail: () => reject(new Error('transport failed')) });
}) });

export const farmState = reactive({
  snapshot: null as Snapshot | null, busy: false, authenticated: false,
  privacy: null as PrivacyReport | null, deletionPrepared: false, pendingCanRetryWithoutAuth: false,
  farmRegistryPage: null as FarmRegistryPage | null, farmRegistryDetail: null as FarmRegistryDetail | null,
  farmRegistryBusy: false, farmRegistryError: '', farmRecordBusy: false, farmRecordError: '', farmRecordMessage: '',
  exchangeHistory: null as ExchangePage | null, exchangeRecord: null as ExchangeDetail | null,
  exchangeHistoryBusy: false, exchangeHistoryError: '', exchangeRecordBusy: false, exchangeRecordError: '', confirmedCheckout: false,
  friends: null as FriendsView | null, friendsBusy: false, friendsError: '', friendsMessage: '',
  forumStatus: null as ForumStatus | null, forumPage: null as ForumPage | null, forumDetail: null as ForumDetail | null, forumReports: null as ForumReports | null,
  forumBusy: false, forumError: '', forumMessage: '', forumDetailBusy: false, forumDetailError: '',
  forumSubmission: null as { action: 'submit-post' | 'submit-comment' } | null,
  plantingStatus: null as PlantingStatus | null, plantingRecord: null as PlantingRecord | null, plantingPage: null as PlantingPage | null, plantingDetail: null as PlantingDetail | null,
  plantingAudience: 'customer' as PlantingAudience, plantingDetailAudience: 'customer' as PlantingAudience,
  plantingBusy: false, plantingDetailBusy: false, plantingRecordBusy: false, plantingError: '', plantingDetailError: '', plantingRecordError: '', plantingMessage: '', plantingConfirmedOrderId: '',
  recoveryDiscovery: 'unknown' as RecoveryDiscovery, recoveryError: '', recoveryIntent: null as RecoveryIntent | null, recoveryStage: null as RecoveryStage | null, mutationBlocked: true,
  error: '', message: '', pending: false, configured: client.configured
});
// Production bundles never include an enabled development sign-in path.
export const sandboxLoginEnabled = import.meta.env.DEV;
let provider: 'weixin' | 'toutiao' | null = null;
// #ifdef MP-WEIXIN
provider = 'weixin';
// #endif
// #ifdef MP-TOUTIAO
provider = 'toutiao';
// #endif
export const platformProvider = provider as 'weixin' | 'toutiao' | null;
let registryRead = 0, detailRead = 0, exchangeHistoryRead = 0, exchangeRecordRead = 0, friendsRead = 0, exchangeSelection = '', synchronizedProfile: unknown = null;
let forumRead = 0, forumDetailRead = 0, forumSelection = { scope: 'public' as 'public' | 'mine' | 'reports', circle: 'all' as 'all' | ForumCircle }, forumPostId = '';
let plantingRead = 0, plantingDetailRead = 0, plantingRecordRead = 0, plantingStatusRead = 0;
let plantingAudience: PlantingAudience = 'customer', plantingOrderId = '', plantingRecordId = '', plantingClock: { serverTime: number; receivedAt: number } | null = null;
function invalidatePlantingViews() {
  plantingRead++; plantingDetailRead++; plantingRecordRead++; plantingStatusRead++;
  farmState.plantingStatus = null; farmState.plantingRecord = null; farmState.plantingPage = null; farmState.plantingDetail = null;
  farmState.plantingBusy = false; farmState.plantingDetailBusy = false; farmState.plantingRecordBusy = false;
}
function invalidateForumViews(message = '') {
  forumRead++; forumDetailRead++;
  farmState.forumStatus = null; farmState.forumPage = null; farmState.forumDetail = null; farmState.forumReports = null;
  farmState.forumBusy = false; farmState.forumDetailBusy = false;
  farmState.forumError = message; farmState.forumDetailError = message; farmState.forumMessage = '';
}
function invalidateFriendsView(message = '') {
  friendsRead++; farmState.friends = null; farmState.friendsBusy = false;
  farmState.friendsError = message; farmState.friendsMessage = '';
}
const forumRelationRefresh = '农友关系可能已变化，请刷新社区核对当前可见内容。';
const friendRelationRefresh = '农友关系可能已变化，请刷新农友列表核对当前关系。';
function syncClientState() {
  if (synchronizedProfile !== client.profile || !client.authenticated) {
    synchronizedProfile = client.profile; registryRead++; detailRead++;
    farmState.farmRegistryPage = null; farmState.farmRegistryDetail = null;
    farmState.farmRegistryError = ''; farmState.farmRecordError = ''; farmState.farmRecordMessage = '';
    farmState.farmRegistryBusy = false; farmState.farmRecordBusy = false;
    exchangeHistoryRead++; exchangeRecordRead++; exchangeSelection = '';
    farmState.exchangeHistory = null; farmState.exchangeRecord = null;
    farmState.exchangeHistoryBusy = false; farmState.exchangeRecordBusy = false;
    farmState.exchangeHistoryError = ''; farmState.exchangeRecordError = '';
    friendsRead++; farmState.friends = null; farmState.friendsBusy = false; farmState.friendsError = ''; farmState.friendsMessage = '';
    forumRead++; forumDetailRead++; farmState.forumStatus = null; farmState.forumPage = null; farmState.forumDetail = null; farmState.forumReports = null;
    farmState.forumBusy = false; farmState.forumDetailBusy = false; farmState.forumError = ''; farmState.forumDetailError = ''; farmState.forumMessage = ''; forumPostId = '';
    farmState.forumSubmission = null;
    invalidatePlantingViews(); plantingOrderId = ''; plantingRecordId = ''; plantingAudience = 'customer'; plantingClock = null;
    farmState.plantingError = ''; farmState.plantingDetailError = ''; farmState.plantingRecordError = ''; farmState.plantingMessage = ''; farmState.plantingConfirmedOrderId = '';
  }
  farmState.snapshot = client.snapshot as Snapshot | null;
  farmState.privacy = client.privacy as PrivacyReport | null;
  farmState.deletionPrepared = client.deletionPrepared;
  farmState.pendingCanRetryWithoutAuth = client.pendingCanRetryWithoutAuth;
  farmState.authenticated = client.authenticated; farmState.pending = client.hasPending();
  farmState.recoveryDiscovery = client.recoveryDiscovery as RecoveryDiscovery; farmState.recoveryError = client.recoveryError;
  farmState.recoveryIntent = client.recoveryIntent as RecoveryIntent | null; farmState.recoveryStage = client.pendingStage as RecoveryStage | null;
  farmState.mutationBlocked = client.mutationBlocked;
  farmState.confirmedCheckout = client.hasConfirmedCheckout;
  if (!client.farmPage) farmState.farmRegistryPage = null;
  if (!client.farmDetail) farmState.farmRegistryDetail = null;
  if (!client.exchangePage) farmState.exchangeHistory = null;
  if (!client.exchangeDetail) farmState.exchangeRecord = null;
  if (!client.friendsView) farmState.friends = null;
  if (!client.forumStatus) farmState.forumStatus = null;
  if (!client.forumPage) farmState.forumPage = null;
  if (!client.forumDetail) farmState.forumDetail = null;
  if (!client.forumReports) farmState.forumReports = null;
  if (!client.plantingStatus) farmState.plantingStatus = null;
  if (!client.plantingRecord) farmState.plantingRecord = null;
  if (!client.plantingPage) farmState.plantingPage = null;
  if (!client.plantingDetail) farmState.plantingDetail = null;
}

async function run(operation: () => Promise<unknown>, message = '') {
  if (farmState.busy) return false;
  farmState.busy = true; farmState.error = ''; farmState.message = '';
  try { await operation(); farmState.message = message; return true; }
  catch (failure) { farmState.error = failure instanceof Error ? failure.message : '操作未完成，请稍后重试。'; return false; }
  finally {
    syncClientState(); farmState.busy = false;
  }
}
export const refreshFarm = () => run(() => client.load());
export const mutateFarm = (path: string, body: Record<string, unknown> = {}, message = '已更新，田园数据已同步。') => run(() => client.mutate(path, body), message);
export const retryFarmOperation = () => {
  const kind = client.pendingKind;
  return run(async () => {
    const result = await client.retryPending();
    if (kind === 'friends') await completeFriendsCommand(result as FriendCommandReceipt);
    if (kind === 'forum') await completeForumCommand(result as ForumReceipt);
    if (kind === 'planting' && result) await completePlantingCommand(result as PlantingReceipt);
  }, ['friends', 'forum', 'planting'].includes(kind || '') ? '' : farmState.pendingCanRetryWithoutAuth ? '账户已注销，全部登录已失效。' : '上次操作已核对，请查看最新资产。');
};
export const retryFarmRecovery = () => run(() => client.discoverRecovery());
export const continueFarmPlanting = () => run(async () => {
  const receipt = await client.continuePlanting() as PlantingReceipt | null;
  syncClientState();
  if (receipt) await completePlantingCommand(receipt);
});
export const acknowledgeFarmPlanting = () => { const intentId = farmState.recoveryIntent?.id; return run(() => client.acknowledgePlanting(intentId)); };
export const abandonFarmPlanting = () => run(async () => {
  const receipt = await client.abandonPlanting() as PlantingReceipt | null;
  syncClientState();
  if (receipt) await completePlantingCommand(receipt);
});
export const loadFarmPrivacy = () => run(() => client.loadPrivacy());
export const prepareFarmDeletion = () => run(() => client.prepareAccountDeletion());
export const deleteFarmAccount = () => run(() => client.deleteAccount(), '账户已注销，全部登录已失效。');
export function cancelFarmDeletion() { client.cancelAccountDeletion(); farmState.deletionPrepared = false; }
export const loginDevelopment = (account: string) => run(async () => { await client.loginDevelopment(account); await client.load(); }, '已连接联调账户，进度由服务器保存。');
export const loginPlatform = () => run(async () => {
  if (!platformProvider) throw new Error('请在已配置账号服务的小程序中登录。');
  const code = await new Promise<string>((resolve, reject) => uni.login({
    success: result => result.code ? resolve(result.code) : reject(new Error('平台未返回登录凭证，请重试。')),
    fail: () => reject(new Error('登录未完成，请重新尝试。'))
  }));
  await client.loginPlatform(platformProvider, code); await client.load();
});
export const logoutFarm = () => run(() => client.logout());
const friendSuccess: Record<string, string> = { enable: '农友名片已开通。', disable: '农友名片已关闭，关系与申请已移除。', request: '申请已发送，等待对方接受。', accept: '已接受申请，成为农友。', decline: '已婉拒这次申请。', cancel: '申请已取消。', remove: '已移除这位农友。', block: '已屏蔽，对方无法再向你申请。', unblock: '已解除屏蔽，原关系不会恢复。' };
const friendRefusal: Record<string, string> = {
  FRIENDS_UNAVAILABLE: '农友功能暂未开放，请稍后再来。', FRIENDS_DISABLED: '请先开通农友名片，再发起操作。', PEER_UNAVAILABLE: '暂时无法向该农友申请，请核对农友码或稍后再试。',
  ALREADY_PENDING: '你们之间已有待处理申请，请查看申请列表。', ALREADY_FRIENDS: '你们已经是农友，无需重复申请。', REQUEST_NOT_FOUND: '这次申请已不在列表中，请刷新后查看。',
  RELATION_NOT_FOUND: '这段农友关系已变化，请刷新后查看。', BLOCK_NOT_FOUND: '这位农友已不在屏蔽列表中，请刷新后查看。', FRIEND_LIMIT: '活动关系已达上限，请先处理现有申请或关系。',
  BLOCK_LIMIT: '屏蔽数量已达上限，请先整理屏蔽列表。', DAILY_REQUEST_LIMIT: '今天的新申请次数已用完，请明天再来。', IDEMPOTENCY_CONFLICT: '这次操作记录有冲突，请刷新并重新核对。',
  FRIENDS_CHANGED: '农友关系刚刚发生变化，请查看最新列表，再重新决定。'
};
export async function loadFarmFriends() {
  syncClientState(); const read = ++friendsRead, account = client.profile;
  farmState.friendsBusy = true; farmState.friendsError = '';
  try {
    if (!client.snapshot) await client.load();
    if (read !== friendsRead || account !== client.profile) return false;
    const view = await client.loadFriends() as FriendsView;
    if (read !== friendsRead || account !== client.profile || view !== client.friendsView) return false;
    farmState.friends = view; return true;
  } catch (failure) {
    if (read === friendsRead && account === client.profile) farmState.friendsError = failure instanceof Error ? failure.message : '农友资料暂时无法读取，请重试。';
    return false;
  } finally { syncClientState(); if (read === friendsRead) farmState.friendsBusy = false; }
}
async function completeFriendsCommand(receipt: FriendCommandReceipt) {
  syncClientState();
  invalidateForumViews(forumRelationRefresh);
  if (receipt.outcome === 'applied') farmState.friendsMessage = friendSuccess[receipt.action];
  else farmState.friendsMessage = friendRefusal[receipt.code] || '这次操作未能完成，请刷新后核对。';
  // Receipt confirmation is final even when the separate current-view read fails.
  await loadFarmFriends();
}
export async function commandFarmFriends(command: FriendCommand) {
  if (farmState.busy || farmState.pending || client.mutationBlocked) return false;
  invalidateFriendsView(); invalidateForumViews(forumRelationRefresh);
  let applied = false;
  const confirmed = await run(async () => {
    const receipt = await client.commandFriends(command) as FriendCommandReceipt;
    applied = receipt.outcome === 'applied'; await completeFriendsCommand(receipt);
  });
  return confirmed && applied;
}
export const forumCircles: Array<{ id: 'all' | ForumCircle; title: string }> = [{ id: 'all', title: '全部圈子' }, { id: 'harvest', title: '丰收分享' }, { id: 'questions', title: '种养问答' }, { id: 'chat', title: '田园闲聊' }];
export const forumReasons: Array<{ id: ForumReason; title: string }> = [{ id: 'spam', title: '广告刷屏' }, { id: 'abuse', title: '辱骂攻击' }, { id: 'privacy', title: '泄露隐私' }, { id: 'misinformation', title: '不实信息' }, { id: 'other', title: '其他违规' }];
export function forumStateLabel(value: ForumState) { return { pending: '待审核，仅自己可见', published: '已公开', rejected: '审核未通过', hidden: '已隐藏', withdrawn: '已撤回，正文已清除' }[value]; }
export function forumCircleLabel(value: ForumCircle) { return forumCircles.find(circle => circle.id === value)?.title || '田园圈子'; }
const forumRefusals: Record<string, string> = { FORUM_UNAVAILABLE: '社区暂未开放。', FRIENDS_DISABLED: '请先开通农友名片，再参与社区。', CONTENT_UNAVAILABLE: '内容已不可用，请刷新查看。', CONTENT_CHANGED: '内容刚刚发生变化，请刷新后重新决定。', OWN_CONTENT_REQUIRED: '只能撤回自己的内容。', SELF_REPORT: '不能举报自己的内容。', ALREADY_REPORTED: '你已举报过这条内容，请在我的举报查看进展。', DAILY_POST_LIMIT: '今天的发帖次数已用完，请明天再来。', DAILY_COMMENT_LIMIT: '今天的评论次数已用完，请明天再来。', DAILY_REPORT_LIMIT: '今天的举报次数已用完，请明天再来。', ACTIVE_LIMIT: '当前内容已达上限，可先撤回不再保留的内容。', BLOCK_LIMIT: '屏蔽数量已达上限，请先到我的农友整理。', IDEMPOTENCY_CONFLICT: '操作记录有冲突，请刷新后重新核对。' };
function appendForum<T extends { id: string }>(previous: { items: T[]; nextCursor: string | null } | null, page: { items: T[]; nextCursor: string | null }, cursor: string) {
  if (cursor === 'start') return page.items;
  if (!previous || previous.nextCursor !== cursor || page.items.some(item => previous.items.some(old => old.id === item.id))) throw new Error('列表刚刚更新，请刷新后继续查看。');
  return [...previous.items, ...page.items];
}
export async function loadFarmForum(scope: 'public' | 'mine' | 'reports' = forumSelection.scope, circle: 'all' | ForumCircle = forumSelection.circle, cursor = 'start') {
  syncClientState(); const read = ++forumRead, account = client.profile;
  if (forumSelection.scope !== scope || forumSelection.circle !== circle) { farmState.forumPage = null; farmState.forumReports = null; }
  forumSelection = { scope, circle }; farmState.forumBusy = true; farmState.forumError = '';
  try {
    if (!client.snapshot) await client.load();
    if (read !== forumRead || account !== client.profile) return false;
    const status = await client.loadForumStatus() as ForumStatus;
    if (read !== forumRead || account !== client.profile || status !== client.forumStatus) return false;
    farmState.forumStatus = status;
    if (!status.available) return true;
    if (scope === 'reports') {
      const page = await client.loadForumReports(cursor) as ForumReports;
      if (read !== forumRead || account !== client.profile || page !== client.forumReports) return false;
      farmState.forumReports = { ...page, items: appendForum(farmState.forumReports, page, cursor) };
    } else {
      const page = await client.loadForumPage(scope, scope === 'mine' ? 'all' : circle, cursor) as ForumPage;
      if (read !== forumRead || account !== client.profile || page !== client.forumPage) return false;
      farmState.forumPage = { ...page, items: appendForum(farmState.forumPage, page, cursor) };
    }
    return true;
  } catch (failure) { if (read === forumRead && account === client.profile) farmState.forumError = failure instanceof Error ? failure.message : '社区暂时无法读取，请重试。'; return false; }
  finally { syncClientState(); if (read === forumRead) farmState.forumBusy = false; }
}
export async function loadFarmForumPost(id: string, cursor = 'start') {
  syncClientState(); const read = ++forumDetailRead, account = client.profile;
  if (forumPostId !== id) farmState.forumDetail = null;
  forumPostId = id; farmState.forumDetailBusy = true; farmState.forumDetailError = '';
  try {
    if (!client.snapshot) await client.load();
    if (read !== forumDetailRead || account !== client.profile) return false;
    const status = await client.loadForumStatus() as ForumStatus;
    if (read !== forumDetailRead || account !== client.profile) return false;
    farmState.forumStatus = status;
    if (!status.available) { farmState.forumDetail = null; return true; }
    let detail = await client.loadForumDetail(id, cursor) as ForumDetail;
    if (read !== forumDetailRead || account !== client.profile || detail !== client.forumDetail) return false;
    const previous = farmState.forumDetail;
    if (cursor !== 'start' && previous?.post.version !== detail.post.version) {
      detail = await client.loadForumDetail(id, 'start') as ForumDetail;
      if (read !== forumDetailRead || account !== client.profile || detail !== client.forumDetail) return false;
      farmState.forumDetail = detail;
    } else farmState.forumDetail = { ...detail, comments: appendForum(previous ? { items: previous.comments, nextCursor: previous.nextCursor } : null, { items: detail.comments, nextCursor: detail.nextCursor }, cursor) };
    return true;
  } catch (failure) { if (read === forumDetailRead && account === client.profile) { farmState.forumDetailError = failure instanceof Error ? failure.message : '帖子暂时无法读取，请重试。'; if ((failure as { status?: number }).status === 404) farmState.forumDetail = null; } return false; }
  finally { syncClientState(); if (read === forumDetailRead) farmState.forumDetailBusy = false; }
}
async function completeForumCommand(receipt: ForumReceipt) {
  syncClientState();
  if (receipt.action === 'block-author') invalidateFriendsView(friendRelationRefresh);
  if (receipt.outcome === 'applied' && ['submit-post', 'submit-comment'].includes(receipt.action)) farmState.forumSubmission = { action: receipt.action as 'submit-post' | 'submit-comment' };
  farmState.forumMessage = receipt.outcome === 'applied' ? ({ 'submit-post': '帖子已提交审核，通过后才会公开。', 'submit-comment': '评论已提交审核，通过后才会公开。', withdraw: '内容已撤回，正文已清除。', report: '举报已记录，可在我的举报查看进展。', 'block-author': '已屏蔽该作者，双方的申请和关系已移除。' }[receipt.action]) : forumRefusals[receipt.code] || '操作未完成，请刷新后核对。';
  await loadFarmForum();
  if (forumPostId) await loadFarmForumPost(forumPostId);
}
export async function commandFarmForum(command: ForumCommand) {
  if (farmState.busy || farmState.pending || client.mutationBlocked) return false;
  invalidateForumViews();
  if (command.action === 'block-author') invalidateFriendsView(friendRelationRefresh);
  let applied = false;
  const confirmed = await run(async () => { const receipt = await client.commandForum(command) as ForumReceipt; applied = receipt.outcome === 'applied'; await completeForumCommand(receipt); });
  return confirmed && applied;
}
export async function loadExchangeHistory(cursor = 'start') {
  syncClientState();
  const read = ++exchangeHistoryRead, account = client.profile;
  farmState.exchangeHistoryBusy = true; farmState.exchangeHistoryError = '';
  try {
    if (!client.snapshot) await client.load();
    if (read !== exchangeHistoryRead || account !== client.profile) return false;
    const page = await client.loadExchangePage(cursor) as ExchangePage;
    if (read !== exchangeHistoryRead || account !== client.profile || page !== client.exchangePage) return false;
    farmState.exchangeHistory = mergeExchangePages(farmState.exchangeHistory, page, cursor) as ExchangePage;
    return true;
  } catch (failure) {
    if (read === exchangeHistoryRead && account === client.profile) farmState.exchangeHistoryError = failure instanceof Error ? failure.message : '兑换记录暂时无法读取，请重试。';
    return false;
  } finally {
    syncClientState(); if (read === exchangeHistoryRead) farmState.exchangeHistoryBusy = false;
  }
}
export async function loadExchangeRecord(id: string) {
  syncClientState();
  const read = ++exchangeRecordRead, account = client.profile;
  farmState.exchangeRecordBusy = true; farmState.exchangeRecordError = '';
  if (exchangeSelection !== id || id === 'last') farmState.exchangeRecord = null;
  exchangeSelection = id;
  try {
    if (!client.snapshot) await client.load();
    if (read !== exchangeRecordRead || account !== client.profile) return false;
    const detail = await (id === 'last' ? client.loadConfirmedCheckout() : client.loadExchangeDetail(id)) as ExchangeDetail;
    if (read !== exchangeRecordRead || account !== client.profile || detail !== client.exchangeDetail) return false;
    farmState.exchangeRecord = detail;
    return true;
  } catch (failure) {
    if (read === exchangeRecordRead && account === client.profile) farmState.exchangeRecordError = failure instanceof Error ? failure.message : '兑换收据暂时无法读取，请重试。';
    return false;
  } finally {
    syncClientState(); if (read === exchangeRecordRead) farmState.exchangeRecordBusy = false;
  }
}
function openAccountPage(route: 'pages/exchanges/index' | 'pages/inventory/index' | 'pages/friends/index' | 'pages/community/index') {
  const pages = getCurrentPages(), position = pages.map(page => page.route).lastIndexOf(route);
  if (position === pages.length - 1) return;
  const fallback = () => uni.navigateTo({ url: `/${route}` });
  if (position >= 0) uni.navigateBack({ delta: pages.length - 1 - position, fail: fallback });
  else fallback();
}
export function openExchangeHistory() { openAccountPage('pages/exchanges/index'); }
export function openExchangeRecord(id: string) {
  if (isExchangeId(id)) uni.navigateTo({ url: `/pages/exchange/index?id=${id}` });
}
export function openConfirmedCheckout() { requestNavigation(() => uni.navigateTo({ url: '/pages/exchange/index?operation=last' })); }
export function openInventory() { openAccountPage('pages/inventory/index'); }
export function openFriends() { openAccountPage('pages/friends/index'); }
export function openCommunity() { openAccountPage('pages/community/index'); }
export function openForumPost(id: string) { if (isForumId(id)) uni.navigateTo({ url: `/pages/forum-post/index?id=${id}` }); }
export function returnFromForumPost() { const fallback = () => openCommunity(); if (getCurrentPages().length > 1) uni.navigateBack({ delta: 1, fail: fallback }); else fallback(); }
export function returnFromFriends() {
  const fallback = () => uni.switchTab({ url: '/pages/activities/index' });
  if (getCurrentPages().length > 1) uni.navigateBack({ delta: 1, fail: fallback });
  else fallback();
}
export function returnFromExchange() {
  const fallback = () => uni.switchTab({ url: '/pages/profile/index' });
  if (getCurrentPages().length > 1) uni.navigateBack({ delta: 1, fail: fallback });
  else fallback();
}
export async function loadFarmRegistry(kind: FarmRegistryKind, cursor = 'start') {
  syncClientState();
  const read = ++registryRead, account = client.profile;
  farmState.farmRegistryBusy = true; farmState.farmRegistryError = '';
  if (farmState.farmRegistryPage?.kind !== kind) farmState.farmRegistryPage = null;
  try {
    if (!client.snapshot) await client.load();
    if (read !== registryRead || account !== client.profile) return false;
    const page = await client.loadFarmPage(kind, cursor) as FarmRegistryPage;
    if (read !== registryRead || account !== client.profile || page !== client.farmPage) return false;
    farmState.farmRegistryPage = mergeFarmPages(farmState.farmRegistryPage, page, cursor) as FarmRegistryPage;
    return true;
  } catch (failure) {
    if (read === registryRead && account === client.profile) farmState.farmRegistryError = failure instanceof Error ? failure.message : '农场档案暂时无法读取，请重试。';
    return false;
  } finally {
    syncClientState(); if (read === registryRead) farmState.farmRegistryBusy = false;
  }
}
export async function loadFarmRecord(id: string, beforeVersion = 0) {
  syncClientState();
  const read = ++detailRead, account = client.profile;
  farmState.farmRecordBusy = true; farmState.farmRecordError = ''; farmState.farmRecordMessage = '';
  if (farmState.farmRegistryDetail?.record.id !== id) farmState.farmRegistryDetail = null;
  try {
    if (!client.snapshot) await client.load();
    if (read !== detailRead || account !== client.profile) return false;
    const detail = await client.loadFarmDetail(id, beforeVersion) as FarmRegistryDetail;
    if (read !== detailRead || account !== client.profile || detail !== client.farmDetail) return false;
    try { farmState.farmRegistryDetail = mergeFarmDetails(farmState.farmRegistryDetail, detail, beforeVersion) as FarmRegistryDetail; }
    catch (failure) {
      if (!(failure instanceof Error) || !('code' in failure) || failure.code !== 'FARM_RECORD_CHANGED') throw failure;
      // One fresh page replaces the old consistent history; never combine versions
      // or loop while the farm keeps publishing observations.
      const latest = await client.loadFarmDetail(id, 0) as FarmRegistryDetail;
      if (read !== detailRead || account !== client.profile || latest !== client.farmDetail) return false;
      farmState.farmRegistryDetail = mergeFarmDetails(null, latest, 0) as FarmRegistryDetail;
      farmState.farmRecordMessage = '农场新增了观测，已刷新到最新记录。';
    }
    return true;
  } catch (failure) {
    if (read === detailRead && account === client.profile) farmState.farmRecordError = failure instanceof Error ? failure.message : '观测记录暂时无法读取，请重试。';
    return false;
  } finally {
    syncClientState(); if (read === detailRead) farmState.farmRecordBusy = false;
  }
}
export function openFarmRecord(id: string) {
  if (/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) uni.navigateTo({ url: `/pages/farm-record/index?id=${id}` });
}
function acceptPlantingClock(view: PlantingStatus | PlantingRecord | PlantingPage | PlantingDetail) { plantingClock = { serverTime: view.serverTime, receivedAt: Date.now() }; }
export function plantingNow() {
  if (!plantingClock) throw new Error('请先刷新作业时间，再核对实际操作。');
  return Math.min(8640000000000000, plantingClock.serverTime + Math.max(0, Date.now() - plantingClock.receivedAt));
}
export function plantingStateLabel(state: PlantingState) { return { requested: '等待农场接单', accepted: '已接单，待派工', assigned: '已派工，待开工', working: '农务作业中', completed: '播种已回传完成', cancelled: '作业已取消' }[state]; }
export function plantingActionLabel(action: PlantingAction) { return { request: '客户申请', cancel: '客户取消', accept: '农场接单', assign: '安排农务员', start: '确认开工', complete: '回传完成', 'cancel-work': '核实人工停工' }[action]; }
export async function loadFarmPlantingStatus() {
  syncClientState(); const read = ++plantingStatusRead, account = client.profile;
  farmState.plantingStatus = null;
  try {
    if (!client.snapshot) await client.load();
    if (read !== plantingStatusRead || account !== client.profile) return false;
    const value = await client.loadPlantingStatus() as PlantingStatus;
    if (read !== plantingStatusRead || account !== client.profile || value !== client.plantingStatus) return false;
    farmState.plantingStatus = value; acceptPlantingClock(value); return true;
  } catch { syncClientState(); return false; }
}
export async function loadFarmPlantingOrders(audience: PlantingAudience = 'customer', cursor = 'start') {
  syncClientState(); const read = ++plantingRead, account = client.profile;
  if (farmState.plantingAudience !== audience) farmState.plantingPage = null;
  plantingAudience = audience; farmState.plantingAudience = audience; farmState.plantingBusy = true; farmState.plantingError = '';
  try {
    if (!await loadFarmPlantingStatus()) throw new Error('播种服务状态未能确认，请刷新重试。');
    if (read !== plantingRead || account !== client.profile) return false;
    if (!farmState.plantingStatus?.available) { farmState.plantingPage = null; return true; }
    const page = await client.loadPlantingPage(audience, cursor) as PlantingPage;
    if (read !== plantingRead || account !== client.profile || page !== client.plantingPage) return false;
    farmState.plantingPage = { ...page, items: appendForum(farmState.plantingPage, page, cursor) }; acceptPlantingClock(page); return true;
  } catch (failure) { if (read === plantingRead && account === client.profile) farmState.plantingError = failure instanceof Error ? failure.message : '作业列表读取失败，请重试。'; return false; }
  finally { syncClientState(); if (read === plantingRead) farmState.plantingBusy = false; }
}
export async function loadFarmPlantingOrder(id: string, audience: PlantingAudience = 'customer') {
  syncClientState(); const read = ++plantingDetailRead, account = client.profile;
  plantingOrderId = id; plantingAudience = audience; farmState.plantingDetailAudience = audience;
  farmState.plantingDetail = null; farmState.plantingDetailBusy = true; farmState.plantingDetailError = '';
  try {
    if (!await loadFarmPlantingStatus()) throw new Error('播种服务状态未能确认，请刷新重试。');
    if (read !== plantingDetailRead || account !== client.profile) return false;
    if (!farmState.plantingStatus?.available) return true;
    const detail = await client.loadPlantingDetail(id, audience) as PlantingDetail;
    if (read !== plantingDetailRead || account !== client.profile || detail !== client.plantingDetail) return false;
    farmState.plantingDetail = detail; acceptPlantingClock(detail); return true;
  } catch (failure) { if (read === plantingDetailRead && account === client.profile) farmState.plantingDetailError = failure instanceof Error ? failure.message : '作业详情读取失败，请重试。'; return false; }
  finally { syncClientState(); if (read === plantingDetailRead) farmState.plantingDetailBusy = false; }
}
export async function loadFarmPlantingRecord(id: string) {
  syncClientState(); const read = ++plantingRecordRead, account = client.profile;
  plantingRecordId = id; farmState.plantingRecord = null; farmState.plantingRecordBusy = true; farmState.plantingRecordError = '';
  try {
    if (!client.snapshot) await client.load();
    if (read !== plantingRecordRead || account !== client.profile) return false;
    const value = await client.loadPlantingRecord(id) as PlantingRecord;
    if (read !== plantingRecordRead || account !== client.profile || value !== client.plantingRecord) return false;
    farmState.plantingRecord = value; acceptPlantingClock(value); return true;
  } catch (failure) { if (read === plantingRecordRead && account === client.profile) farmState.plantingRecordError = failure instanceof Error ? failure.message : '申请资格读取失败，请重试。'; return false; }
  finally { syncClientState(); if (read === plantingRecordRead) farmState.plantingRecordBusy = false; }
}
const plantingRefusals: Record<string, string> = { INTENT_PENDING: '请先核对上次播种操作，再提交新的操作。', PLANTING_UNAVAILABLE: '播种作业暂未开放。', NOT_FOUND: '作业已不可访问，请刷新列表。', PLAN_DISABLED: '农场暂未开放这块田的播种，请联系农场核查。', RECORD_CHANGED: '地块档案已更新，请查看最新档案后重新决定。', ORDER_CHANGED: '作业状态刚刚更新，请查看最新进展后重新决定。', INVALID_STATE: '当前状态无法执行此操作，请刷新核对。', ACTIVE_ORDER_EXISTS: '本轮已有未结束作业，请查看当前申请。', ASSIGNEE_UNAVAILABLE: '所选农务员授权已变化，请刷新候选名单。', TOO_EARLY: '尚未到农场安排的最早开工时间。', INVALID_PERFORMED_AT: '实际操作时间未能确认，请刷新作业核对。', EVENT_LIMIT: '当前作业记录已达限制，请由农场核查。', IDEMPOTENCY_CONFLICT: '操作记录有冲突，请核对原操作。' };
export function plantingResultLabel(receipt: PlantingReceipt) {
  return receipt.outcome === 'applied' ? ({ request: '播种申请已保存，等待农场接单。', cancel: '播种申请已取消。', accept: '已接单，等待安排农务员。', assign: '派工已保存，请查看最新作业进展。', start: '开工已登记，实际作业仍由农场执行。', complete: '播种完成已回传，地块档案已更新。', 'cancel-work': '人工停工已记录，农场重新核查前暂停新申请。' }[receipt.action]) : plantingRefusals[receipt.code] || '操作未完成，请刷新后核对。';
}
async function completePlantingCommand(receipt: PlantingReceipt) {
  syncClientState();
  farmState.plantingConfirmedOrderId = receipt.outcome === 'applied' ? receipt.orderId || '' : '';
  farmState.plantingMessage = plantingResultLabel(receipt);
  // A confirmed original command is final even when any subsequent GET fails.
  const audience = plantingAudience, selectedOrder = plantingOrderId, selectedRecord = plantingRecordId;
  await loadFarmPlantingOrders(audience);
  if (selectedOrder) await loadFarmPlantingOrder(selectedOrder, audience);
  if (selectedRecord) { await loadFarmPlantingRecord(selectedRecord); if (receipt.action === 'complete') await loadFarmRecord(selectedRecord); }
}
export async function commandFarmPlanting(command: PlantingCommand, audience: PlantingAudience = 'customer') {
  if (farmState.busy || farmState.pending || client.mutationBlocked) return false;
  plantingAudience = audience; invalidatePlantingViews(); farmState.plantingMessage = ''; farmState.plantingConfirmedOrderId = '';
  let applied = false;
  const confirmed = await run(async () => { const receipt = await client.commandPlanting(command, audience) as PlantingReceipt | null; if (!receipt) { farmState.plantingMessage = '这次操作已结束，未执行新的播种操作。'; return; } applied = receipt.outcome === 'applied'; await completePlantingCommand(receipt); syncClientState(); await nextTick(); if (client.recoveryIntent?.operationKey === receipt.operationKey && client.pendingStage === 'receipt-review') await client.acknowledgePlanting(receipt.operationKey.slice('intent-'.length)); });
  return confirmed && applied;
}
export function openPlantingOrders(audience: PlantingAudience = 'customer') {
  if (!['customer', 'staff'].includes(audience)) return;
  requestNavigation(() => {
    const pages = getCurrentPages(), position = pages.map(page => page.route).lastIndexOf('pages/planting/index');
    const fallback = () => uni.navigateTo({ url: `/pages/planting/index?audience=${audience}` });
    if (position >= 0 && plantingAudience === audience && position < pages.length - 1) uni.navigateBack({ delta: pages.length - 1 - position, fail: fallback }); else fallback();
  });
}
export function openPlantingOrder(id: string, audience: PlantingAudience = 'customer') { if (isPlantingId(id) && ['customer', 'staff'].includes(audience)) requestNavigation(() => uni.navigateTo({ url: `/pages/planting-order/index?id=${id}&audience=${audience}` })); }
export function returnFromPlanting() { requestNavigation(() => { const fallback = () => uni.switchTab({ url: '/pages/profile/index' }); if (getCurrentPages().length > 1) uni.navigateBack({ delta: 1, fail: fallback }); else fallback(); }); }
export function openFarmRegistry() {
  const fallback = () => uni.switchTab({ url: '/pages/farm/index' });
  if (getCurrentPages().length > 1) uni.navigateBack({ delta: 1, fail: fallback });
  else fallback();
}
export function farmRecordStatus(status: FarmRecordStatus) {
  return { planned: '待开始', growing: '生长中', ready: '待农场安排收获', archived: '本轮已归档' }[status];
}
export function farmRecordUnitLabel(record: Pick<FarmRecord, 'kind' | 'unitLabel'>) {
  const match = record.kind === 'plot' && /^A0([1-6])$/.exec(record.unitLabel);
  return match ? `地块${match[1]}` : record.unitLabel;
}
// UTC arithmetic gives the same Beijing calendar in mini-programs without Intl.
export function farmRecordDate(value: number | null) {
  if (value === null) return '农场暂未记录';
  const date = new Date(value), pad = (n: number) => String(n).padStart(2, '0');
  let year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate(), hour = date.getUTCHours() + 8;
  // Calendar rollover avoids overflowing Date at the contract's maximum instant.
  if (hour >= 24) {
    hour -= 24; day++;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (day > days) { day = 1; month++; if (month > 12) { month = 1; year++; } }
  }
  return `${year}年${pad(month)}月${pad(day)}日 ${pad(hour)}:${pad(date.getUTCMinutes())}`;
}
export function farmMeasurements(record: FarmRecord) {
  const values = record.measurements;
  return [values.areaM2 !== undefined ? { label: '种植面积', value: `${values.areaM2} 平方米` } : null,
    values.moisturePercent !== undefined ? { label: '土壤湿度', value: `${values.moisturePercent}%` } : null,
    values.weightKg !== undefined ? { label: '记录重量', value: `${values.weightKg} 千克` } : null,
    values.headCount !== undefined ? { label: '记录数量', value: `${values.headCount} 头／只` } : null]
    .filter((item): item is { label: string; value: string } => item !== null);
}
export function openProfile() { uni.switchTab({ url: '/pages/profile/index' }); }
export function openCart() { uni.navigateTo({ url: '/pages/cart/index' }); }
export function openShop() { uni.switchTab({ url: '/pages/shop/index' }); }
export function onFarmPageShow() { if (farmState.authenticated && !farmState.busy) void refreshFarm(); }
export function rewardLabel(reward: { points?: number; feed?: number; fertilizer?: number; tools?: number; coupon?: unknown }) {
  return [reward.points ? `${reward.points}积分` : '', reward.feed ? `${reward.feed}份饲料` : '', reward.fertilizer ? `${reward.fertilizer}份肥料` : '', reward.tools ? `${reward.tools}件工具` : '', reward.coupon ? '积分券' : ''].filter(Boolean).join(' · ');
}
