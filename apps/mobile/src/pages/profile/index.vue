<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, nextTick, ref, watch } from 'vue';
import { onShow, onHide } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmSignIn from '../../components/FarmSignIn.vue';
import { farmState as state, sandboxLoginEnabled, platformProvider, loginDevelopment, loginPlatform, logoutFarm, onFarmPageShow, refreshFarm, loadFarmPrivacy, prepareFarmDeletion, cancelFarmDeletion, deleteFarmAccount, openInventory, openExchangeHistory, loadFarmPlantingStatus, openPlantingOrders, loadFarmEggsStatus, openEggs } from '../../core/farm';
const account = ref('');
const accountValid = computed(() => /^[A-Za-z0-9_-]{3,40}$/.test(account.value));
async function connect() { if (accountValid.value) await loginDevelopment(account.value); }
async function focusPrivacy(id: string) {
  await nextTick();
  // #ifdef H5
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: 'center', behavior: 'auto' }); target?.focus({ preventScroll: true });
  // #endif
  // #ifndef H5
  uni.pageScrollTo({ selector: '#' + id, duration: 0 });
  // #endif
}
async function showPrivacy() { if (await loadFarmPrivacy()) await focusPrivacy('privacy-details'); }
async function prepareDeletion() { if (await prepareFarmDeletion()) await focusPrivacy('delete-cancel'); }
async function cancelDeletion() { cancelFarmDeletion(); await focusPrivacy('delete-review'); }
async function confirmDeletion() { if (await deleteFarmAccount()) await focusPrivacy('account-login-title'); }
watch(() => state.authenticated, authenticated => { if (!authenticated && !state.pending) void focusPrivacy('account-login-title'); });
onHide(cancelFarmDeletion);
onShow(() => { onFarmPageShow(); if (state.authenticated) { void loadFarmPlantingStatus(); void loadFarmEggsStatus(); } });
watch(() => state.authenticated, authenticated => { if (authenticated) { void loadFarmPlantingStatus(); void loadFarmEggsStatus(); } });
</script>
<template>
  <FarmScreen title="我的" allow-guest warm>
    <view class="profile-hero"><image class="home-avatar" src="/static/photos/farm-estate.webp" mode="aspectFill" aria-label="农庄头像" /><view class="profile-name">{{ state.authenticated && state.snapshot ? state.snapshot.profile.displayName : '未登录' }}</view><text v-if="state.authenticated && state.snapshot" class="helper">Lv.{{ state.snapshot.level.level }} · {{ state.snapshot.level.label }}</text><text v-else class="helper">登录后，开启我的田园生活</text></view>
    <view v-if="!state.authenticated && !state.pendingCanRetryWithoutAuth" class="panel">
      <view id="account-login-title" class="section-heading" tabindex="-1">登录合耕小舍</view><text class="body-copy">田园资产和兑换记录随账户保存，换页或刷新不会重新发放奖励。</text>
      <FarmButton v-if="platformProvider" class="action" style="margin-top:20px" :disabled="state.busy || !state.configured" @tap="loginPlatform">{{ platformProvider === 'weixin' ? '微信登录' : '抖音登录' }}</FarmButton>
      <text v-else-if="!sandboxLoginEnabled" class="helper" style="margin-top:16px">账户服务准备中，请从已开放的小程序进入。</text>
      <template v-if="sandboxLoginEnabled"><view class="notice" style="margin-top:20px"><text>本机联调入口，仅用于测试示例账户，不是正式用户登录。</text></view><label class="form-label" for="review-account">联调账户名称</label><input id="review-account" v-model="account" placeholder="例：farm_demo（示例账户）" placeholder-style="color: var(--secondary); opacity: 1;" placeholder-class="input-placeholder" class="text-input" maxlength="40" confirm-type="done" :disabled="state.busy" aria-label="联调账户名称" @confirm="connect" /><text class="helper">3–40位英文字母、数字、下划线或连字符；请勿填写真实手机号、地址或密码。</text><FarmButton class="action" style="margin-top:16px" :disabled="state.busy || !accountValid || !state.configured" @tap="connect">连接联调账户</FarmButton></template>
      <text v-if="!state.configured" class="helper" style="margin-top:18px">农场账户服务尚未配置，目前无法登录。</text>
    </view>
    <template v-if="state.snapshot && state.authenticated && !state.pendingCanRetryWithoutAuth">
      <view class="asset-row profile-assets"><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.points }}</text><text class="asset-label">田园积分</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.feed }}</text><text class="asset-label">饲料份数</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.system.purchases.length }}</text><text class="asset-label">积分兑换</text></view></view>
      <FarmSignIn show-progress />
      <view class="panel profile-menu"><FarmButton class="text-action" @tap="openInventory"><text>查看当前仓库</text><text class="profile-menu-arrow" aria-hidden="true">›</text></FarmButton><FarmButton class="text-action" @tap="openExchangeHistory"><text>查看全部兑换记录</text><text class="profile-menu-arrow" aria-hidden="true">›</text></FarmButton></view>
      <view class="panel profile-menu"><FarmButton class="text-action" @tap="openPlantingOrders('customer')"><text>我的播种申请</text><text class="profile-menu-arrow" aria-hidden="true">›</text></FarmButton><FarmButton v-if="state.plantingStatus?.hasStaffAccess" class="text-action" @tap="openPlantingOrders('staff')"><text>农务工作台</text><text class="profile-menu-arrow" aria-hidden="true">›</text></FarmButton></view>
      <view class="panel profile-menu"><FarmButton class="text-action" @tap="openEggs('customer')"><text>我的鸡蛋产出 · 手动收取</text><text class="profile-menu-arrow" aria-hidden="true">›</text></FarmButton><FarmButton v-if="state.eggsStatus?.hasStaffAccess" class="text-action" @tap="openEggs('staff')"><text>鸡蛋登记工作台</text><text class="profile-menu-arrow" aria-hidden="true">›</text></FarmButton></view>
      <FarmButton class="action secondary profile-sync" :disabled="state.busy" @tap="refreshFarm">同步最新田园数据</FarmButton>
            <view class="panel">
        <view class="section-heading">账户与隐私</view>
        <text class="body-copy">登录凭证只在当前运行内存中保留。退出后需重新登录，服务器保存的田园资产仍属于该账户。</text>
        <text class="helper" style="margin-top:12px">当前版本尚未开放真实收货信息、支付和现场视频。正式服务开放前，还需公布运营主体、隐私说明和联系方式。</text>
        <FarmButton class="action secondary" style="margin-top:16px" :disabled="state.busy" @tap="showPrivacy">查看账户保存的数据</FarmButton>
        <FarmButton class="action secondary" style="margin-top:12px" :disabled="state.busy || state.pending || state.mutationBlocked" @tap="logoutFarm">退出当前账户</FarmButton>
      </view>
      <view v-if="state.privacy" id="privacy-details" class="panel" tabindex="-1" role="region" aria-label="账户数据说明">
        <view class="section-heading">本服务保存的数据</view>
        <view v-for="category in state.privacy.dataCategories" :key="category.id" class="simple-row"><view>{{ category.title }}</view><text class="helper">{{ category.description }}</text></view>
        <text class="helper">这些资料只属于当前田园账户。注销会移除当前服务中的账户和业务数据；已生成的备份需要按运营方的保留与删除制度处理。</text>
        <FarmButton v-if="!state.deletionPrepared" id="delete-review" class="action danger-outline" style="margin-top:18px" :disabled="state.busy || state.pending || state.mutationBlocked" @tap="prepareDeletion">查看并核对账户注销</FarmButton>
      </view>
      <view v-if="state.deletionPrepared" class="panel deletion-confirm" role="region" aria-labelledby="account-delete-title">
        <view id="account-delete-title" class="section-heading">注销当前田园账户</view>
        <text class="body-copy">{{ state.snapshot.profile.displayName }}：{{ state.snapshot.wallet.points }}积分、{{ state.snapshot.wallet.feed }}份饲料、{{ state.snapshot.system.purchases.length }}笔积分兑换记录。</text>
        <text class="body-copy" style="margin-top:12px">确认后，本服务的账户、积分物资和兑换记录将被移除，全部登录失效。此操作不可撤销；以后重新登录会创建新账户。</text>
        <text class="helper" style="margin-top:12px">仅注销本服务账户，不会注销微信或抖音账号。请在准备后的2分钟内确认；账户状态变化后需要重新核对。</text>
        <FarmButton id="delete-cancel" class="action secondary" style="margin-top:20px" :disabled="state.busy" @tap="cancelDeletion">返回，保留我的账户</FarmButton>
        <FarmButton class="action danger" style="margin-top:12px" :disabled="state.busy || state.pending || state.mutationBlocked" @tap="confirmDeletion">确认注销当前账户</FarmButton>
      </view>
    </template>
  </FarmScreen>
</template>
