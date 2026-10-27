<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, watch } from 'vue';
import { onLoad, onShow, onHide } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import { farmState as state, loadFarmPlantingOrder, commandFarmPlanting, plantingStateLabel, plantingActionLabel, plantingNow, farmRecordDate, openPlantingOrders, openFarmRecord } from '../../core/farm';
import type { PlantingAudience, PlantingCommand, PlantingAction } from '../../core/types';
defineOptions({ inheritAttrs: false });
const id = ref(''), audience = ref<PlantingAudience>('customer'), routeError = ref('');
const controlId = 'planting-confirm-' + getCurrentInstance()!.uid;
const detail = computed(() => !routeError.value && state.plantingDetailAudience === audience.value && state.plantingDetail?.order.id === id.value ? state.plantingDetail : null);
const blocked = computed(() => state.busy || state.pending || state.plantingDetailBusy || !detail.value);
const confirmation = ref<{ action: Exclude<PlantingAction, 'request'>; command: PlantingCommand; version: number; label: string } | null>(null), candidate = ref('');
let previousFocus: HTMLElement | null = null;
function reset() { confirmation.value = null; candidate.value = ''; previousFocus = null; }
watch(() => [state.authenticated, state.snapshot?.profile.id, detail.value], reset);
onHide(reset);
function refresh() { reset(); if (id.value && !routeError.value) return loadFarmPlantingOrder(id.value, audience.value); return Promise.resolve(false); }
async function cancelConfirmation() { const trigger = previousFocus; reset(); await nextTick();
  // #ifdef H5
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  // #endif
}
const actionPermission = { cancel: 'canCancel', accept: 'canAccept', assign: 'canAssign', start: 'canStart', complete: 'canComplete', 'cancel-work': 'canCancelWork' } as const;
async function ask(action: Exclude<PlantingAction, 'request'>) {
  if (blocked.value || !detail.value || !detail.value.permissions[actionPermission[action]]) return;
  if ((audience.value === 'customer') !== (action === 'cancel')) return;
  const order = detail.value.order, base = { orderId: order.id, expectedOrderVersion: order.version };
  let command: PlantingCommand;
  if (action === 'complete') command = { action, ...base, expectedRecordVersion: order.recordVersion, performedAt: plantingNow() };
  else if (action === 'cancel-work') command = { action, ...base, stoppedAt: plantingNow(), reason: 'farm-confirmed-stop' };
  else if (action === 'assign') command = { action, ...base, assigneeRef: '' };
  else command = { action, ...base };
  // #ifdef H5
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // #endif
  candidate.value = ''; confirmation.value = { action, command, version: order.version, label: `${order.name} · ${order.unitLabel} · ${order.cycleRef}` };
  await nextTick();
  // #ifdef H5
  document.getElementById(controlId + '-cancel')?.focus();
  // #endif
  // #ifndef H5
  uni.pageScrollTo({ selector: '#' + controlId + '-cancel', duration: 0 });
  // #endif
}
async function confirmAction() {
  const selected = confirmation.value, current = detail.value;
  if (!selected || !current || blocked.value || selected.version !== current.order.version || !current.permissions[actionPermission[selected.action]]) { reset(); return; }
  let command = selected.command;
  if (command.action === 'assign') {
    if (!current.candidates.some(item => item.ref === candidate.value)) return;
    command = { ...command, assigneeRef: candidate.value };
  }
  await commandFarmPlanting(command, audience.value); reset();
  await nextTick();
  // #ifdef H5
  document.getElementById(controlId + '-feedback')?.focus({ preventScroll: true });
  // #endif
}
const confirmLabel = computed(() => ({ cancel: '确认取消申请', accept: '确认接单', assign: '确认派工', start: '确认已开工', complete: '确认回传完成', 'cancel-work': '确认已人工停工' }[confirmation.value?.action || 'cancel']));
onLoad(query => {
  reset(); routeError.value = ''; id.value = '';
  if (typeof query?.id !== 'string' || !/^[a-f0-9]{32}$/.test(query.id) || (query.audience !== undefined && !['customer', 'staff'].includes(String(query.audience)))) { routeError.value = '作业入口无效，请返回列表重新选择。'; return; }
  id.value = query.id; audience.value = query.audience === 'staff' ? 'staff' : 'customer';
});
onShow(() => { if (state.authenticated && !state.busy && !state.pending) void refresh(); });
</script>
<template>
  <FarmScreen :title="audience === 'staff' ? '农务作业详情' : '播种申请详情'">
    <FarmButton class="action secondary" @tap="openPlantingOrders(audience)">返回作业列表</FarmButton>
    <view v-if="routeError" class="notice error" role="alert">{{ routeError }}</view>
    <template v-else>
      <view :id="controlId + '-feedback'" tabindex="-1"><view v-if="state.plantingDetailBusy" class="status-line" role="status">正在核对作业与当前权限…</view><view v-if="state.plantingMessage" class="success-note" role="status">{{ state.plantingMessage }}</view><view v-if="state.plantingDetailError" class="notice error" role="alert">{{ state.plantingDetailError }}<text>已确认的操作不会重发；刷新只读取当前进展。</text></view></view>
      <FarmButton class="action secondary" :disabled="state.busy || state.pending || state.plantingDetailBusy" @tap="refresh">刷新当前作业</FarmButton>
      <view v-if="state.plantingStatus && !state.plantingStatus.available" class="panel empty-panel"><view class="section-heading">播种作业暂未开放</view><text class="body-copy">服务开放并核实地块与人员授权后，才可申请或处理。</text></view>
      <view v-else-if="!detail && !state.plantingDetailBusy" class="panel empty-panel"><view class="section-heading">尚未取得当前作业</view><text class="body-copy">请刷新核对。授权变化后，旧页面不会继续提供操作。</text></view>
      <template v-if="detail">
        <view class="panel record-overview"><text class="helper">{{ audience === 'staff' ? '农场授权作业' : '我的播种申请' }} · {{ detail.order.cycleRef }}</text><view class="section-heading">{{ detail.order.name }}</view><text class="record-status">{{ plantingStateLabel(detail.order.status) }}</text><view class="record-meta"><text>地块：{{ detail.order.unitLabel }}</text><text>最早开工：{{ farmRecordDate(detail.order.notBefore) }}</text></view><view class="record-date-list"><view class="record-fact"><text class="helper">申请时间</text><text>{{ farmRecordDate(detail.order.createdAt) }}</text></view><view v-if="detail.order.startedAt !== null" class="record-fact"><text class="helper">实际开工</text><text>{{ farmRecordDate(detail.order.startedAt) }}</text></view><view v-if="detail.order.completedAt !== null" class="record-fact"><text class="helper">播种完成</text><text>{{ farmRecordDate(detail.order.completedAt) }}</text></view></view><text class="helper">{{ detail.order.assigneeRef ? '已安排农务员' : '尚未安排农务员' }} · 作业版本 {{ detail.order.version }} · 北京时间</text><FarmButton v-if="audience === 'customer'" class="action secondary" @tap="openFarmRecord(detail.order.recordId)">查看本轮地块档案</FarmButton></view>
        <view class="notice"><text>当前为开发沙盒流程，实际农务须由农场核实。开工和完成由授权人员登记，不是设备执行回执，不推算收获日期或发放积分。</text></view>
        <view v-if="detail.order.status === 'cancelled' && detail.order.startedAt !== null" class="notice"><text>此作业曾开工，农场已核实人工停工；不代表地块未播种。农场重新核查并开放计划前不能重新申请。</text></view>
        <view v-show="!confirmation" class="panel planting-actions"><view class="section-heading">当前可操作</view>
          <template v-if="audience === 'customer'"><FarmButton v-if="detail.permissions.canCancel" class="action danger-outline" :disabled="blocked" @tap="ask('cancel')">取消播种申请</FarmButton><text v-else class="body-copy">{{ detail.order.status === 'working' ? '已开始作业，客户不能直接取消。需由农场核实现场情况。' : '此阶段无需客户操作，可刷新查看最新进展。' }}</text></template>
          <template v-else><FarmButton v-if="detail.permissions.canAccept" class="action" :disabled="blocked" @tap="ask('accept')">接下播种申请</FarmButton><FarmButton v-if="detail.permissions.canAssign" class="action" :disabled="blocked || !detail.candidates.length" @tap="ask('assign')">{{ detail.order.status === 'assigned' ? '重新安排农务员' : '安排农务员' }}</FarmButton><text v-if="detail.permissions.canAssign && !detail.candidates.length" class="helper">当前没有可指派的农务员，请由农场核查授权。</text><FarmButton v-if="detail.permissions.canStart" class="action" :disabled="blocked || detail.serverTime < detail.order.notBefore" @tap="ask('start')">登记实际开工</FarmButton><text v-if="detail.order.status === 'assigned' && detail.serverTime < detail.order.notBefore" class="helper">尚未到最早开工时间，到时请刷新后再核对。</text><FarmButton v-if="detail.permissions.canComplete" class="action" :disabled="blocked" @tap="ask('complete')">回传播种完成</FarmButton><FarmButton v-if="detail.permissions.canCancelWork" class="action danger-outline" :disabled="blocked" @tap="ask('cancel-work')">核实人工停工</FarmButton><text v-if="!Object.values(detail.permissions).some(Boolean)" class="body-copy">当前授权与作业状态下没有可执行操作。请刷新核对，或联系农场。</text></template>
        </view>
        <view v-if="confirmation" class="panel" :class="confirmation.action === 'cancel' || confirmation.action === 'cancel-work' ? 'deletion-confirm' : 'confirm-panel'" role="region" :aria-labelledby="controlId + '-title'"><view :id="controlId + '-title'" class="section-heading">{{ plantingActionLabel(confirmation.action) }}</view><text class="body-copy">{{ confirmation.label }}</text><text class="body-copy" style="margin-top:12px">{{ confirmation.action === 'cancel-work' ? '请先明确核实现场已人工停工。这不是设备停止回执；登记后结束该作业并暂停新申请，保留曾经开工的事实。' : confirmation.action === 'complete' ? '仅在现场已经完成播种后回传。将更新本轮地块为生长中，开始时间记为本次完成时间；未重新测量的观测不会复制。' : confirmation.action === 'start' ? '仅登记本人指派作业的实际开工；不向设备发送指令，不能早于农场安排的最早开工时间。' : confirmation.action === 'cancel' ? '尚未开工的申请将结束，后续如仍符合资格，可重新申请。' : confirmation.action === 'accept' ? '接单后进入待派工，由有权限的人员安排农务员。' : '只可选择当前授权名单中的农务员。改派后原农务员不能继续此单作业。' }}</text><text v-if="confirmation.command.action === 'complete'" class="helper">本次实际完成时间：{{ farmRecordDate(confirmation.command.performedAt) }}（按服务时间校准）</text><text v-if="confirmation.command.action === 'cancel-work'" class="helper">本次核实停工时间：{{ farmRecordDate(confirmation.command.stoppedAt) }}（按服务时间校准）</text><view v-if="confirmation.action === 'assign'" class="planting-candidates" role="group" aria-label="当前可派工农务员"><FarmButton v-for="item in detail.candidates" :key="item.ref" class="action secondary" :aria-pressed="candidate === item.ref" :class="{ 'forum-reason-selected': candidate === item.ref }" :disabled="blocked" @tap="candidate = item.ref">{{ item.label }}</FarmButton></view><FarmButton :id="controlId + '-cancel'" class="action secondary" :disabled="state.busy" @tap="cancelConfirmation">返回，暂不操作</FarmButton><FarmButton class="action" :class="{ danger: confirmation.action === 'cancel' || confirmation.action === 'cancel-work' }" :disabled="blocked || (confirmation.action === 'assign' && !candidate)" @tap="confirmAction">{{ confirmLabel }}</FarmButton></view>
        <view class="section-heading">作业记录</view><view v-for="event in detail.events" :key="event.version" class="panel"><view class="section-heading">{{ plantingActionLabel(event.action) }}</view><text class="body-copy">实际发生：{{ farmRecordDate(event.occurredAt) }}</text><text class="helper">登记：{{ farmRecordDate(event.recordedAt) }} · {{ event.actorRef === 'customer' ? '客户' : '农场授权人员' }}</text></view><text class="helper registry-footnote">记录与权限于 {{ farmRecordDate(detail.serverTime) }} 核对。</text>
      </template>
    </template>
  </FarmScreen>
</template>
