<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import { farmState as state, sandboxLoginEnabled, platformProvider, loginDevelopment, loginPlatform, logoutFarm, onFarmPageShow, refreshFarm } from '../../core/farm';
const account = ref('reviewer');
const accountValid = computed(() => /^[A-Za-z0-9_-]{3,40}$/.test(account.value));
const resources: Record<string, string> = { fertilizer: '田园养护肥', tools: '农事工具', seedPacks: '当季种子盒', decorations: '庄园装扮', eggs: '累计鸡蛋', crops: '累计蔬菜', meat: '累计肉类' };
async function connect() { if (accountValid.value) await loginDevelopment(account.value); }
onShow(onFarmPageShow);
</script>
<template>
  <FarmScreen title="我的田园" subtitle="有一方田，有一份安心。" allow-guest>
    <view v-if="!state.authenticated" class="panel">
      <view class="section-heading">登录，找回自己的田园</view><text class="body-copy">田园资产和兑换记录随账户保存，换页或刷新不会重新发放奖励。</text>
      <FarmButton v-if="platformProvider" class="action" style="margin-top:20px" :disabled="state.busy || !state.configured" @tap="loginPlatform">{{ platformProvider === 'weixin' ? '微信登录' : '抖音登录' }}</FarmButton>
      <text v-else-if="!sandboxLoginEnabled" class="helper" style="margin-top:16px">账户服务准备中，请从已开放的小程序进入。</text>
      <template v-if="sandboxLoginEnabled"><view class="notice" style="margin-top:20px"><text>本机联调入口，仅用于测试示例账户，不是正式用户登录。</text></view><label class="form-label" for="review-account">联调账户名称</label><input id="review-account" v-model="account" class="text-input" maxlength="40" confirm-type="done" :disabled="state.busy" aria-label="联调账户名称" @confirm="connect" /><text class="helper">3–40位英文字母、数字、下划线或连字符；请勿填写真实手机号、地址或密码。</text><FarmButton class="action" style="margin-top:16px" :disabled="state.busy || !accountValid || !state.configured" @tap="connect">连接联调账户</FarmButton></template>
      <text v-if="!state.configured" class="helper" style="margin-top:18px">农场账户服务尚未配置，目前无法登录。</text>
    </view>
    <template v-if="state.snapshot && state.authenticated">
      <view class="panel"><view class="section-heading">{{ state.snapshot.profile.displayName }}</view><text class="helper">Lv.{{ state.snapshot.level.level }} · {{ state.snapshot.level.label }}</text><view class="asset-row"><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.points }}</text><text class="asset-label">田园积分</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.feed }}</text><text class="asset-label">饲料份数</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.system.purchases.length }}</text><text class="asset-label">积分订单</text></view></view><FarmButton class="action secondary" :disabled="state.busy" @tap="refreshFarm">同步最新田园数据</FarmButton></view>
      <view class="section-heading">我的仓库</view><view class="stock-grid"><view v-for="(name, key) in resources" :key="key" class="stock-item"><text class="helper">{{ name }}</text><text class="stock-count">{{ state.snapshot.system.inventory[key] || 0 }}</text></view></view><text class="helper" style="margin:14px 0">物资按实际农事安排使用，不能跳过次数、间隔或设备确认。</text>
      <view class="panel"><view class="section-heading">最近积分兑换</view><text v-if="!state.snapshot.system.purchases.length" class="body-copy">还没有积分兑换记录。</text><view v-for="purchase in [...state.snapshot.system.purchases].reverse().slice(0, 10)" :key="purchase.id" class="simple-row"><view>{{ purchase.day }} · {{ purchase.count }} 件物资</view><text class="helper">使用 {{ purchase.total }} 积分</text></view></view>
      <view class="panel"><view class="section-heading">账户与隐私</view><text class="body-copy">登录凭证只在当前运行内存中保留。退出后需重新登录，服务器保存的田园资产仍属于该账户。</text><FarmButton class="action secondary" style="margin-top:16px" :disabled="state.busy || state.pending" @tap="logoutFarm">退出当前账户</FarmButton></view>
    </template>
  </FarmScreen>
</template>
