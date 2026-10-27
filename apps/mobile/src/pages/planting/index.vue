<script setup lang="ts">
import { computed, getCurrentInstance, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import { farmState as state, loadFarmPlantingOrders, plantingStateLabel, farmRecordDate, openPlantingOrder, openPlantingOrders, returnFromPlanting } from '../../core/farm';
import { loadWithPageFocus } from '../../core/pagination-focus';
import type { PlantingAudience } from '../../core/types';
defineOptions({ inheritAttrs: false });
const audience = ref<PlantingAudience>('customer'), routeError = ref('');
const resultId = 'planting-list-result-' + getCurrentInstance()!.uid;
const page = computed(() => !routeError.value && state.plantingAudience === audience.value ? state.plantingPage : null);
const readBusy = computed(() => state.busy || state.plantingBusy);
function refresh(cursor = 'start', event?: unknown) { if (routeError.value) return Promise.resolve(false); return loadWithPageFocus(cursor, event, () => loadFarmPlantingOrders(audience.value, cursor), () => !!page.value?.nextCursor, resultId); }
onLoad(query => { routeError.value = ''; if (query?.audience !== undefined && !['customer', 'staff'].includes(String(query.audience))) { routeError.value = '作业入口无效，请返回我的页面重新选择。'; return; } audience.value = query?.audience === 'staff' ? 'staff' : 'customer'; });
onShow(() => { if (state.authenticated && !readBusy.value) void refresh(); });
</script>
<template>
  <FarmScreen :title="audience === 'staff' ? '农务工作台' : '我的播种申请'">
    <FarmButton class="action secondary" @tap="returnFromPlanting">返回上一页</FarmButton>
    <view v-if="routeError" class="notice error" role="alert">{{ routeError }}</view>
    <template v-else>
      <view class="notice"><text>{{ audience === 'staff' ? '仅展示当前授权范围的作业。接单、派工与现场回传均需重新核对当前授权。' : '请在我的农场选择已归属的待开始地块，在档案中申请播种。每轮只保留一笔未结束作业。' }}</text></view>
      <view v-if="state.plantingMessage" class="success-note" role="status">{{ state.plantingMessage }}</view><view v-if="state.plantingError" class="notice error" role="alert">{{ state.plantingError }}<text>刷新只读取进展，不会重复提交已确认操作。</text></view>
      <FarmButton class="action secondary" :disabled="readBusy" @tap="refresh()">刷新作业列表</FarmButton>
      <FarmButton v-if="audience === 'customer' && state.plantingStatus?.hasStaffAccess" class="action secondary" :disabled="readBusy" @tap="openPlantingOrders('staff')">进入农务工作台</FarmButton>
      <view :id="resultId" class="registry-status" tabindex="-1" role="status" aria-live="polite"><text v-if="state.plantingBusy">正在读取播种作业…</text><text v-else-if="page">已显示 {{ page.items.length }} 笔{{ page.nextCursor ? '，可继续加载' : '，已全部显示' }}</text></view>
      <view v-if="state.plantingStatus && !state.plantingStatus.available" class="panel empty-panel"><view class="section-heading">播种作业暂未开放</view><text class="body-copy">完成农场资料和人员配置后，才会开放申请。当前不会模拟成功或安排作业。</text></view>
      <template v-else-if="state.plantingStatus?.available"><view v-if="page && !page.items.length && !state.plantingBusy" class="panel empty-panel"><view class="section-heading">{{ audience === 'staff' ? '当前没有可查看的作业' : '还没有播种申请' }}</view><text class="body-copy">{{ audience === 'staff' ? '新申请或授权调整后，请刷新核对。' : '先在我的农场查看本轮地块档案。已有申请可在这里持续核对。' }}</text></view><view v-for="item in page?.items || []" :key="item.id" class="panel"><text class="helper">{{ item.unitLabel }} · {{ item.cycleRef }}</text><view class="section-heading">{{ item.name }}</view><text class="record-status">{{ plantingStateLabel(item.status) }}</text><text class="body-copy">最早开工：{{ farmRecordDate(item.notBefore) }}</text><text class="helper">更新：{{ farmRecordDate(item.updatedAt) }} · 北京时间</text><FarmButton class="action" :disabled="readBusy" @tap="openPlantingOrder(item.id, audience)">查看作业进展</FarmButton></view><FarmButton v-if="page?.nextCursor" class="action secondary" :disabled="readBusy" :loading="state.plantingBusy" @tap="refresh(page.nextCursor!, $event)">加载更多作业</FarmButton></template>
      <text class="helper registry-footnote">关闭应用后需重新登录，并从当前地块及此列表核对进展。新的播种操作可重新登录核对原结果；此前旧操作回执不能自动恢复，请先核对已有作业再申请。</text>
    </template>
  </FarmScreen>
</template>
