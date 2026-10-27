<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import { farmState as state, loadFarmEggsBatch, commandFarmEggs, openEggs, eggsStateLabel, eggsDayLabel, farmRecordDate } from '../../core/farm';
import type { EggsAudience, EggsCommand } from '../../core/types';
defineOptions({ inheritAttrs: false });
const id = ref(''), audience = ref<EggsAudience>('customer'), routeError = ref('');
const prefix = 'egg-batch-' + getCurrentInstance()!.uid;
const detail = computed(() => state.eggsDetailAudience === audience.value && state.eggsDetail?.batch.id === id.value ? state.eggsDetail : null);
const confirmation = ref<{ command: EggsCommand; quantity: number; label: string } | null>(null);
const readBusy = computed(() => state.busy || state.eggsDetailBusy);
const blocked = computed(() => readBusy.value || state.pending || state.mutationBlocked);
let pageGeneration = 0;
async function focus(suffix: string) { await nextTick();
  // #ifdef H5
  const target = document.getElementById(prefix + suffix); target?.scrollIntoView({ block: 'center', behavior: 'auto' }); target?.focus({ preventScroll: true });
  // #endif
  // #ifndef H5
  uni.pageScrollTo({ selector: '#' + prefix + suffix, duration: 0 });
  // #endif
}
function refresh() { confirmation.value = null; return loadFarmEggsBatch(id.value, audience.value); }
async function ask(action: 'collect' | 'withdraw') {
  const value = detail.value; if (blocked.value || !value || (action === 'collect' ? !value.permissions.canCollect || !state.snapshot : !value.permissions.canWithdraw)) return;
  const command: EggsCommand = action === 'collect' ? { domain: 'eggs', action, batchId: value.batch.id, expectedBatchVersion: value.batch.version, expectedRevision: state.snapshot!.revision } : { domain: 'eggs', action, batchId: value.batch.id, expectedBatchVersion: value.batch.version };
  confirmation.value = { command, quantity: value.batch.quantity, label: `${value.batch.name} · ${value.batch.unitLabel} · ${eggsDayLabel(value.batch.day)} · ${value.batch.quantity}枚` }; await focus('-cancel');
}
async function cancel() { confirmation.value = null; await focus('-actions'); }
async function confirmAction() {
  if (blocked.value || !confirmation.value) return;
  const value = confirmation.value, generation = pageGeneration; confirmation.value = null;
  await commandFarmEggs(audience.value, value.command);
  if (generation === pageGeneration) await focus('-feedback');
}
watch(() => [detail.value?.batch.version, detail.value?.permissions.canCollect, detail.value?.permissions.canWithdraw, state.authenticated, state.snapshot?.profile.id], () => { confirmation.value = null; pageGeneration++; });
onLoad(query => { if (typeof query?.id !== 'string' || !/^[a-f0-9]{32}$/.test(query.id) || (query.audience !== undefined && !['customer', 'staff'].includes(query.audience))) { routeError.value = '产出入口无效，请返回列表重新选择。'; return; } id.value = query.id; audience.value = query.audience === 'staff' ? 'staff' : 'customer'; pageGeneration++; });
onShow(() => { pageGeneration++; if (id.value && state.authenticated && !readBusy.value) void refresh(); });
onHide(() => { pageGeneration++; confirmation.value = null; }); onUnload(() => { pageGeneration++; });
</script>
<template>
  <FarmScreen :title="audience === 'staff' ? '鸡蛋登记详情' : '手动收取鸡蛋'" allow-guest>
    <FarmButton class="action secondary" @tap="openEggs(audience)">返回鸡蛋产出列表</FarmButton>
    <view v-if="routeError" class="notice error" role="alert">{{ routeError }}</view>
    <template v-else-if="state.authenticated">
      <view :id="prefix + '-feedback'" tabindex="-1"><view v-if="state.eggsDetailBusy" class="status-line" role="status">正在核对产出与当前权限…</view><view v-if="state.eggsMessage" class="success-note" role="status">{{ state.eggsMessage }}</view><view v-if="state.eggsDetailError" class="notice error" role="alert">{{ state.eggsDetailError }}<text>已确认的收取不会再次发送；刷新只读取当前产出。</text></view></view>
      <FarmButton class="action secondary" :disabled="readBusy" @tap="refresh">刷新当前产出</FarmButton>
      <template v-if="detail"><view class="panel record-overview"><text class="helper">{{ detail.batch.unitLabel }} · {{ detail.batch.cycleRef }}</text><view class="section-heading">{{ detail.batch.name }}</view><text class="record-status">{{ eggsStateLabel(detail.batch.status) }}</text><view class="summary-row"><text>产出日期（北京时间）</text><text>{{ eggsDayLabel(detail.batch.day) }}</text></view><view class="summary-row"><text>本笔登记数量</text><text class="record-value">{{ detail.batch.quantity }} 枚鸡蛋</text></view><text class="body-copy">来源编号：{{ detail.batch.sourceRef }}</text><text class="helper">登记：{{ farmRecordDate(detail.batch.createdAt) }}</text><text v-if="detail.batch.collectedAt !== null" class="body-copy">已收取：{{ farmRecordDate(detail.batch.collectedAt) }}</text><text v-if="detail.batch.withdrawnAt !== null" class="body-copy">已撤回：{{ farmRecordDate(detail.batch.withdrawnAt) }}</text></view>
        <view class="notice"><text>按农场登记的实际数量手动收取，每笔只能收取一次。旧日未收产出会保留在列表供核对，不会自动补产或销毁；这里的鸡蛋累计不代表可寄送库存。</text></view>
        <view v-if="!confirmation" :id="prefix + '-actions'" class="panel" tabindex="-1"><view class="section-heading">当前可操作</view><FarmButton v-if="audience === 'customer' && detail.permissions.canCollect" class="action" :disabled="blocked || !state.snapshot" @tap="ask('collect')">手动收取鸡蛋</FarmButton><FarmButton v-if="audience === 'staff' && detail.permissions.canWithdraw" class="action danger-outline" :disabled="blocked" @tap="ask('withdraw')">撤回这笔登记</FarmButton><text v-if="!detail.permissions.canCollect && !detail.permissions.canWithdraw" class="body-copy">当前状态或授权下无需继续操作。已收取不能再领取，也不能撤回。</text></view>
        <view v-if="confirmation" class="panel" :class="confirmation.command.action === 'withdraw' ? 'deletion-confirm' : 'confirm-panel'" role="region" :aria-labelledby="prefix + '-title'"><view :id="prefix + '-title'" class="section-heading">{{ confirmation.command.action === 'collect' ? '核对本次收取' : '核对撤回登记' }}</view><text class="body-copy">{{ confirmation.label }}</text><text class="body-copy">{{ confirmation.command.action === 'collect' ? '确认后按本笔数量计入鸡蛋累计，并按既有收获规则记录成长与任务资格。不会创建邮寄或物流。' : '仅可撤回尚未收取的登记，不会发放鸡蛋。更正时需另用新的来源编号重新登记。' }}</text><FarmButton :id="prefix + '-cancel'" class="action secondary" :disabled="state.busy" @tap="cancel">返回，暂不操作</FarmButton><FarmButton class="action" :class="{ danger: confirmation.command.action === 'withdraw' }" :disabled="blocked" @tap="confirmAction">{{ confirmation.command.action === 'collect' ? `确认收取${confirmation.quantity}枚鸡蛋` : '确认撤回这笔登记' }}</FarmButton></view>
        <text class="helper registry-footnote">产出和权限于 {{ farmRecordDate(detail.serverTime) }} 核对。当前仅开发沙盒可用。</text>
      </template>
      <view v-else-if="!state.eggsDetailBusy" class="panel empty-panel"><view class="section-heading">尚未取得当前产出</view><text class="body-copy">请刷新核对。授权和归属变化后，旧页面不会继续提供操作。</text></view>
    </template><view v-else class="notice">请先登录田园账户，再从“我的”查看鸡蛋产出。</view>
  </FarmScreen>
</template>
