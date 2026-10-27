<script setup lang="ts">
import { farmState as state, openProfile, refreshFarm, retryFarmOperation, openConfirmedCheckout } from '../core/farm';
import FarmButton from './FarmButton.vue';
import FarmNavigation from './FarmNavigation.vue';
defineProps<{ title: string; subtitle?: string; allowGuest?: boolean; id?: string; hideCheckoutReceipt?: boolean }>();
</script>
<template>
  <view :id="id" class="screen">
    <view v-if="state.snapshot?.environment === 'development'" class="environment-note">联调农场 · 示例资产，不产生付款或真实作业</view>
    <view class="screen-heading"><view class="page-title" role="heading" aria-level="1">{{ title }}</view><text v-if="subtitle" class="subtitle">{{ subtitle }}</text></view>
    <view v-if="state.busy" class="status-line" role="status">正在同步田园数据…</view>
    <view v-if="state.pending" class="notice" role="status"><text>{{ state.pendingCanRetryWithoutAuth ? '注销结果尚未确认。请先核对结果，确认前不要重新注册账户。' : '上次操作结果尚未确认，请先核对。' }}</text><FarmButton class="action secondary" :disabled="state.busy || (!state.authenticated && !state.pendingCanRetryWithoutAuth)" @tap="retryFarmOperation">核对上次操作</FarmButton></view>
    <view v-if="state.error" class="notice error" role="alert"><text>{{ state.error }}</text><FarmButton v-if="state.authenticated && !state.pending" class="action secondary" :disabled="state.busy" @tap="refreshFarm">刷新田园数据</FarmButton></view>
    <view v-if="state.message" class="success-note" role="status">{{ state.message }}</view>
    <view v-if="state.confirmedCheckout && state.authenticated && !state.pending && !hideCheckoutReceipt" class="confirmed-checkout"><FarmButton class="action secondary" :disabled="state.busy" @tap="openConfirmedCheckout">查看最近确认的兑换收据</FarmButton></view>
    <template v-if="allowGuest || (state.authenticated && state.snapshot)"><slot /></template>
    <view v-else-if="!state.authenticated" class="panel empty-panel"><view class="empty-mark">田</view><view class="section-heading">登录后查看我的农场</view><text class="body-copy">登录后查看认养、物资和收获进度。</text><FarmButton class="action" @tap="openProfile">登录我的田园</FarmButton></view>
    <view v-else class="panel empty-panel"><text>暂未取得田园数据，请检查网络后重试。</text><FarmButton class="action" :disabled="state.busy" @tap="refreshFarm">重新加载</FarmButton></view>
  </view>
  <!-- #ifndef APP-PLUS -->
  <FarmNavigation />
  <!-- #endif -->
</template>
