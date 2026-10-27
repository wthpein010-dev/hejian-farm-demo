<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import { farmState as state, loadFarmRecord, openFarmRegistry, openProfile, farmRecordDate, farmRecordStatus, farmMeasurements } from '../../core/farm';

const recordId = ref(''), routeError = ref('');
const detail = computed(() => state.farmRegistryDetail?.record.id === recordId.value ? state.farmRegistryDetail : null);
const record = computed(() => detail.value?.record || null);
let requestedBeforeVersion = 0;
function load(beforeVersion = 0) { requestedBeforeVersion = beforeVersion; void loadFarmRecord(recordId.value, beforeVersion); }
onLoad(query => {
  const id = query?.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) { routeError.value = '档案位置无效，请返回我的农场重新选择。'; return; }
  recordId.value = id;
});
onShow(() => { if (recordId.value && state.authenticated) load(); });
</script>
<template>
  <FarmScreen title="种养档案" allow-guest>
    <FarmButton class="text-action" @tap="openFarmRegistry">返回我的农场</FarmButton>
    <view v-if="routeError" class="notice error" role="alert">{{ routeError }}</view>
    <EmptyPanel v-else-if="!state.authenticated" title="请登录后查看自己的档案" description="档案按田园账户归属。登录后，请回到我的农场选择种养对象。"><FarmButton class="action" @tap="openProfile">登录我的田园</FarmButton></EmptyPanel>
    <template v-else>
      <view class="registry-status" role="status" aria-live="polite"><text v-if="state.farmRecordBusy">正在读取种养与观测记录…</text><text v-else-if="detail">已显示 {{ detail.events.length }} 条观测{{ detail.nextBeforeVersion ? '，可继续查看更早记录' : '，已全部显示' }}</text></view>
      <view v-if="state.farmRecordMessage" class="success-note" role="status">{{ state.farmRecordMessage }}</view>
      <view v-if="state.farmRecordError" class="notice error" role="alert"><text>{{ state.farmRecordError }}</text><FarmButton class="action secondary" :disabled="state.farmRecordBusy" @tap="load(requestedBeforeVersion)">重试读取观测</FarmButton></view>
      <template v-if="record && detail">
        <view class="panel record-overview">
          <text class="helper">{{ record.kind === 'plot' ? '农田' : '牧场' }} · 归属档案</text>
          <view class="record-heading"><view class="section-heading" role="heading" aria-level="2">{{ record.name }}</view><text class="record-status">{{ farmRecordStatus(record.status) }}</text></view>
          <view class="record-meta"><text>位置：{{ record.unitLabel }}</text><text>种养轮次：{{ record.cycleRef }}</text></view>
          <text class="helper">档案版本 {{ record.version }} · 日期均为北京时间</text>
          <view class="record-date-list"><view class="record-fact"><text class="helper">本轮开始</text><text>{{ farmRecordDate(record.startedAt) }}</text></view><view class="record-fact"><text class="helper">预计收获</text><text>{{ farmRecordDate(record.expectedHarvestAt) }}</text></view><view class="record-fact"><text class="helper">最近观测</text><text>{{ farmRecordDate(record.observedAt) }}</text></view></view>
          <FarmButton class="action secondary" :disabled="state.farmRecordBusy" @tap="load()">刷新本轮档案</FarmButton>
        </view>
        <view class="panel">
          <view class="section-heading" role="heading" aria-level="2">最近测量</view>
          <view v-for="measurement in farmMeasurements(record)" :key="measurement.label" class="summary-row"><text>{{ measurement.label }}</text><text class="record-value">{{ measurement.value }}</text></view>
          <text v-if="!farmMeasurements(record).length" class="body-copy">这次观测尚未记录测量值。</text>
          <text class="helper registry-footnote">测量对应 {{ farmRecordDate(record.observedAt) }} 的观测。</text>
        </view>
        <view class="notice"><text>观测记录用于了解种养状态，不是设备执行回执。预计收获时间以农场安排为准；“待农场安排收获”和“本轮已归档”不代表已经采收、付款或寄出。</text></view>
        <view class="section-row"><view class="section-heading" role="heading" aria-level="2">农场观测时间线</view></view>
        <text class="helper">按记录版本由新到旧排列，保留各次实际观测时间。</text>
        <view class="record-timeline" role="list" aria-label="农场观测历史">
          <view v-for="event in detail.events" :key="event.version" class="panel observation-card" role="listitem">
            <view class="record-heading"><view class="section-heading" role="heading" aria-level="3">第 {{ event.version }} 次记录</view><text class="record-status">{{ farmRecordStatus(event.record.status) }}</text></view>
            <text class="body-copy">观测：{{ farmRecordDate(event.record.observedAt) }}</text>
            <text class="helper">登记：{{ farmRecordDate(event.recordedAt) }} · 北京时间</text>
            <view v-for="measurement in farmMeasurements(event.record)" :key="measurement.label" class="summary-row"><text>{{ measurement.label }}</text><text class="record-value">{{ measurement.value }}</text></view>
            <text v-if="!farmMeasurements(event.record).length" class="body-copy">本次未登记测量值。</text>
            <text class="helper registry-footnote">农场来源：{{ event.source }}</text>
          </view>
        </view>
        <text v-if="!detail.events.length" class="body-copy registry-footnote">暂无可展示的观测记录，请稍后刷新。</text>
        <FarmButton v-if="detail.nextBeforeVersion" class="action secondary" :disabled="state.farmRecordBusy" :loading="state.farmRecordBusy" @tap="load(detail.nextBeforeVersion)">查看更早的观测</FarmButton>
        <text v-else-if="detail.events.length" class="helper registry-footnote">已显示本轮全部观测记录。</text>
        <text class="helper registry-footnote">资料同步：{{ farmRecordDate(detail.serverTime) }}（北京时间）</text>
      </template>
    </template>
  </FarmScreen>
</template>
