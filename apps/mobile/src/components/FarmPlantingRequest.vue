<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { onHide } from '@dcloudio/uni-app';
import FarmButton from './FarmButton.vue';
import { farmState as state, loadFarmPlantingRecord, commandFarmPlanting, openPlantingOrder, openPlantingOrders, farmRecordDate } from '../core/farm';
import type { FarmRecord } from '../core/types';
const props = defineProps<{ record: FarmRecord }>();
const controlId = 'planting-request-' + getCurrentInstance()!.uid;
const eligibility = computed(() => state.plantingRecord?.recordId === props.record.id ? state.plantingRecord : null);
const readBusy = computed(() => state.busy || state.plantingRecordBusy);
const mutationBlocked = computed(() => readBusy.value || state.pending || state.mutationBlocked);
const eligible = computed(() => eligibility.value?.enabled && eligibility.value.recordVersion === props.record.version && !eligibility.value.currentOrderId && props.record.kind === 'plot' && props.record.status === 'planned' && props.record.startedAt === null);
const confirmingVersion = ref<number | null>(null);
let previousFocus: HTMLElement | null = null, navigationGeneration = 0;
function reset() { confirmingVersion.value = null; previousFocus = null; }
watch(() => [state.authenticated, state.snapshot?.profile.id, eligibility.value, props.record.version], reset);
onHide(() => { navigationGeneration++; reset(); });
onBeforeUnmount(() => { navigationGeneration++; });
async function ask() {
  if (!eligible.value || mutationBlocked.value) return;
  // #ifdef H5
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // #endif
  confirmingVersion.value = props.record.version; await nextTick();
  // #ifdef H5
  document.getElementById(controlId + '-cancel')?.focus();
  // #endif
  // #ifndef H5
  uni.pageScrollTo({ selector: '#' + controlId + '-cancel', duration: 0 });
  // #endif
}
async function cancel() { const trigger = previousFocus; reset(); await nextTick();
  // #ifdef H5
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  // #endif
}
async function submit() {
  const version = confirmingVersion.value;
  if (!eligible.value || mutationBlocked.value || version !== props.record.version) { reset(); return; }
  const navigation = navigationGeneration, accountId = state.snapshot?.profile.id, recordId = props.record.id;
  const applied = await commandFarmPlanting({ action: 'request', recordId: props.record.id, expectedRecordVersion: version }, 'customer');
  reset();
  if (applied && navigation === navigationGeneration && accountId === state.snapshot?.profile.id && recordId === props.record.id && state.plantingConfirmedOrderId) openPlantingOrder(state.plantingConfirmedOrderId, 'customer');
}
</script>
<template>
  <view v-if="record.kind === 'plot'" class="panel planting-request">
    <view class="section-heading">本轮播种</view>
    <view v-if="state.plantingMessage" class="success-note" role="status">{{ state.plantingMessage }}</view>
    <view v-if="state.plantingRecordError" class="notice error" role="alert">{{ state.plantingRecordError }}</view>
    <text v-if="state.plantingRecordBusy" class="body-copy" role="status">正在核对本轮申请资格…</text>
    <template v-else-if="eligibility?.currentOrderId"><text class="body-copy">本轮已有未结束的播种作业，请先查看当前进展。</text><FarmButton class="action" :disabled="readBusy" @tap="openPlantingOrder(eligibility.currentOrderId, 'customer')">查看当前播种作业</FarmButton></template>
    <template v-else-if="eligible"><text class="body-copy">农场已开放此地块的本轮播种申请，接单后由授权农务员安排作业。</text><text class="helper">最早开工：{{ farmRecordDate(eligibility!.notBefore) }} · 北京时间</text><FarmButton v-show="confirmingVersion === null" class="action" :disabled="mutationBlocked" @tap="ask">申请本轮播种</FarmButton></template>
    <text v-else class="body-copy">{{ record.status !== 'planned' || record.startedAt !== null ? '本轮已经开始或结束，不可再次申请播种。' : '本轮暂未具备申请条件，请刷新档案与申请资格，或由农场核查计划。' }}</text>
    <view v-if="confirmingVersion !== null" class="confirm-panel" role="region" :aria-labelledby="controlId + '-title'"><view :id="controlId + '-title'" class="section-heading">申请播种：{{ record.name }}</view><text class="body-copy">{{ record.unitLabel }} · {{ record.cycleRef }}。申请后等待农场接单与派工，开工前可取消。当前为开发沙盒，不产生付款或真实设备执行。</text><FarmButton :id="controlId + '-cancel'" class="action secondary" :disabled="state.busy" @tap="cancel">返回，暂不申请</FarmButton><FarmButton class="action" :disabled="mutationBlocked || !eligible" @tap="submit">确认申请播种</FarmButton></view>
    <FarmButton class="action secondary" :disabled="readBusy" @tap="loadFarmPlantingRecord(record.id)">刷新申请资格</FarmButton><FarmButton class="text-action" @tap="openPlantingOrders('customer')">查看我的全部播种申请</FarmButton>
    <text class="helper">新的播种操作可在重新登录后核对原结果；此前旧操作仍需先查看当前作业，避免重复申请。</text>
  </view>
</template>
