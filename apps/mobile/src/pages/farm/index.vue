<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import { farmState as state, onFarmPageShow, openProfile, openShop, loadFarmRegistry, openFarmRecord, farmRecordDate, farmRecordStatus } from '../../core/farm';
import type { FarmRegistryKind } from '../../core/types';
const initialPage = state.farmRegistryPage;
const area = ref<FarmRegistryKind>(initialPage && initialPage.ownerId === state.snapshot?.profile.id ? initialPage.kind : 'plots');
const page = computed(() => state.farmRegistryPage?.kind === area.value ? state.farmRegistryPage : null);
let requestedCursor = 'start';
function load(cursor = 'start') { requestedCursor = cursor; void loadFarmRegistry(area.value, cursor); }
function selectArea(kind: FarmRegistryKind) { area.value = kind; load(); }
onShow(() => {
  onFarmPageShow();
  if (state.authenticated && (!page.value || page.value.ownerId !== state.snapshot?.profile.id || page.value.environment !== state.snapshot.environment)) load();
});
</script>
<template>
  <FarmScreen title="我的农场" allow-guest>
    <image class="hero-image" src="/static/photos/farm-estate.webp" mode="aspectFill" aria-label="AI生成的农庄静态示意，非实拍、非直播" />
    <view class="hero-caption"><text class="helper">AI生成静态示意 · 非实拍、非直播</text><text class="helper">认养与作业以农场记录为准</text></view>
    <template v-if="state.snapshot">
      <view class="asset-row"><view class="asset-cell"><text class="asset-number">Lv.{{ state.snapshot.level.level }}</text><text class="asset-label">{{ state.snapshot.level.label }}</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.points }}</text><text class="asset-label">田园积分</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.feed }}</text><text class="asset-label">饲料份数</text></view></view>
      <view class="tabs" role="group" aria-label="切换菜园与牧场"><FarmButton :class="{ active: area === 'plots' }" :aria-pressed="area === 'plots'" @tap="selectArea('plots')">我的菜园</FarmButton><FarmButton :class="{ active: area === 'animals' }" :aria-pressed="area === 'animals'" @tap="selectArea('animals')">我的牧场</FarmButton></view>
      <view class="section-row"><view class="section-heading" role="heading" aria-level="2">{{ area === 'plots' ? '农田种养档案' : '牧场种养档案' }}</view><FarmButton class="text-action" :disabled="state.farmRegistryBusy" @tap="load()">刷新档案</FarmButton></view>
      <text class="body-copy">查看本轮对象与农场观测。档案状态不代表付款、设备执行或寄送结果。</text>
      <view class="registry-status" role="status" aria-live="polite"><text v-if="state.farmRegistryBusy">正在读取农场档案…</text><text v-else-if="page">已显示 {{ page.items.length }} 项{{ page.nextCursor ? '，可继续加载' : '，已全部显示' }}</text></view>
      <view v-if="state.farmRegistryError" class="notice error" role="alert"><text>{{ state.farmRegistryError }}</text><FarmButton class="action secondary" :disabled="state.farmRegistryBusy" @tap="load(requestedCursor)">重试读取档案</FarmButton></view>
      <EmptyPanel v-if="page && !page.items.length && !state.farmRegistryBusy" title="农场尚未登记本类档案" description="农场登记到当前账户后，这里会显示种养轮次和观测资料。可稍后刷新查看。"><FarmButton class="action secondary" @tap="openShop">看看农场商城</FarmButton></EmptyPanel>
      <view v-if="page?.items.length" role="list" aria-label="我的种养档案">
        <view v-for="item in page.items" :key="item.id" class="panel registry-card" role="listitem">
          <view class="record-heading"><view class="section-heading" role="heading" aria-level="3">{{ item.name }}</view><text class="record-status">{{ farmRecordStatus(item.status) }}</text></view>
          <view class="record-meta"><text>位置：{{ item.unitLabel }}</text><text>轮次：{{ item.cycleRef }}</text></view>
          <text class="helper">最近观测 · {{ farmRecordDate(item.observedAt) }}（北京时间）</text>
          <FarmButton class="action secondary" :aria-label="`查看${item.name}，${item.unitLabel}，轮次${item.cycleRef}的档案`" @tap="openFarmRecord(item.id)">查看种养档案</FarmButton>
        </view>
      </view>
      <FarmButton v-if="page?.nextCursor" class="action secondary" :disabled="state.farmRegistryBusy" :loading="state.farmRegistryBusy" @tap="load(page.nextCursor)">加载更多档案</FarmButton>
      <text v-if="page?.items.length" class="helper registry-footnote">资料同步：{{ farmRecordDate(page.serverTime) }}（北京时间）</text>
      <view class="panel"><view class="section-heading">照料说明</view><text class="body-copy">浇水与投喂遵循农场的次数、间隔和设备确认。补充物资不会增加照料额度。</text></view>
    </template>
    <EmptyPanel v-else title="把自己的田园带在身边" description="登录后，认养记录、物资与收获进度会随账户保存。"><FarmButton class="action" @tap="openProfile">登录我的田园</FarmButton></EmptyPanel>
  </FarmScreen>
</template>
