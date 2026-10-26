import { reactive } from 'vue';
import { createFarmClient } from './client.mjs';
import type { Snapshot, PrivacyReport } from './types';

const baseURL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
const client = createFarmClient({ baseURL, transport: (request: { url: string; method: string; headers: object; body: unknown; timeout: number }) => new Promise((resolve, reject) => {
  uni.request({ url: request.url, method: request.method as 'GET' | 'POST', header: request.headers,
    data: request.body as Record<string, unknown>, timeout: request.timeout,
    success: response => resolve({ status: response.statusCode, data: response.data }), fail: () => reject(new Error('transport failed')) });
}) });

export const farmState = reactive({
  snapshot: null as Snapshot | null, busy: false, authenticated: false,
  privacy: null as PrivacyReport | null, deletionPrepared: false, pendingCanRetryWithoutAuth: false,
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

async function run(operation: () => Promise<unknown>, message = '') {
  if (farmState.busy) return false;
  farmState.busy = true; farmState.error = ''; farmState.message = '';
  try { await operation(); farmState.message = message; return true; }
  catch (failure) { farmState.error = failure instanceof Error ? failure.message : '操作未完成，请稍后重试。'; return false; }
  finally {
    farmState.snapshot = client.snapshot as Snapshot | null;
    farmState.privacy = client.privacy as PrivacyReport | null;
    farmState.deletionPrepared = client.deletionPrepared;
    farmState.pendingCanRetryWithoutAuth = client.pendingCanRetryWithoutAuth;
    farmState.authenticated = client.authenticated;
    farmState.pending = client.hasPending(); farmState.busy = false;
  }
}
export const refreshFarm = () => run(() => client.load());
export const mutateFarm = (path: string, body: Record<string, unknown> = {}, message = '已更新，田园数据已同步。') => run(() => client.mutate(path, body), message);
export const retryFarmOperation = () => run(() => client.retryPending(), farmState.pendingCanRetryWithoutAuth ? '账户已注销，全部登录已失效。' : '上次操作已核对，请查看最新资产。');
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
export function openProfile() { uni.switchTab({ url: '/pages/profile/index' }); }
export function openCart() { uni.navigateTo({ url: '/pages/cart/index' }); }
export function openShop() { uni.switchTab({ url: '/pages/shop/index' }); }
export function onFarmPageShow() { if (farmState.authenticated && !farmState.busy) void refreshFarm(); }
export function rewardLabel(reward: { points?: number; feed?: number; fertilizer?: number; tools?: number; coupon?: unknown }) {
  return [reward.points ? `${reward.points}积分` : '', reward.feed ? `${reward.feed}份饲料` : '', reward.fertilizer ? `${reward.fertilizer}份肥料` : '', reward.tools ? `${reward.tools}件工具` : '', reward.coupon ? '积分券' : ''].filter(Boolean).join(' · ');
}
