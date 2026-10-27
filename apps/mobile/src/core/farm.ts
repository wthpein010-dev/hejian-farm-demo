import { reactive } from 'vue';
import { createFarmClient, mergeFarmPages, mergeFarmDetails, mergeExchangePages, isExchangeId } from './client.mjs';
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
  }
  farmState.snapshot = client.snapshot as Snapshot | null;
  farmState.privacy = client.privacy as PrivacyReport | null;
  farmState.deletionPrepared = client.deletionPrepared;
  farmState.pendingCanRetryWithoutAuth = client.pendingCanRetryWithoutAuth;
  farmState.authenticated = client.authenticated; farmState.pending = client.hasPending();
  farmState.confirmedCheckout = client.hasConfirmedCheckout;
  if (!client.farmPage) farmState.farmRegistryPage = null;
  if (!client.farmDetail) farmState.farmRegistryDetail = null;
  if (!client.exchangePage) farmState.exchangeHistory = null;
  if (!client.exchangeDetail) farmState.exchangeRecord = null;
  if (!client.friendsView) farmState.friends = null;
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
  }, kind === 'friends' ? '' : farmState.pendingCanRetryWithoutAuth ? '账户已注销，全部登录已失效。' : '上次操作已核对，请查看最新资产。');
};
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
  if (receipt.outcome === 'applied') farmState.friendsMessage = friendSuccess[receipt.action];
  else farmState.friendsMessage = friendRefusal[receipt.code] || '这次操作未能完成，请刷新后核对。';
  // Receipt confirmation is final even when the separate current-view read fails.
  await loadFarmFriends();
}
export async function commandFarmFriends(command: FriendCommand) {
  if (farmState.busy || farmState.pending) return false;
  friendsRead++; farmState.friendsBusy = false; farmState.friendsMessage = ''; farmState.friendsError = '';
  let applied = false;
  const confirmed = await run(async () => {
    const receipt = await client.commandFriends(command) as FriendCommandReceipt;
    applied = receipt.outcome === 'applied'; await completeFriendsCommand(receipt);
  });
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
function openAccountPage(route: 'pages/exchanges/index' | 'pages/inventory/index' | 'pages/friends/index') {
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
export function openConfirmedCheckout() { uni.navigateTo({ url: '/pages/exchange/index?operation=last' }); }
export function openInventory() { openAccountPage('pages/inventory/index'); }
export function openFriends() { openAccountPage('pages/friends/index'); }
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
export function openFarmRegistry() {
  const fallback = () => uni.switchTab({ url: '/pages/farm/index' });
  if (getCurrentPages().length > 1) uni.navigateBack({ delta: 1, fail: fallback });
  else fallback();
}
export function farmRecordStatus(status: FarmRecordStatus) {
  return { planned: '待开始', growing: '生长中', ready: '待农场安排收获', archived: '本轮已归档' }[status];
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
