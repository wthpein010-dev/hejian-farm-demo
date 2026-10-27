<script setup lang="ts">
import { computed, getCurrentInstance, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import FarmTextField from '../../components/FarmTextField.vue';
import FarmDraftNotice from '../../components/FarmDraftNotice.vue';
import { farmState as state, loadFarmEggsRecord, commandFarmEggs, openEggs, openEggsBatch, farmRecordDate } from '../../core/farm';
import { useDraftGuard, requestNavigation } from '../../core/forum-draft';
import { isEggsCommand } from '../../../../../shared/eggs.mjs';
defineOptions({ inheritAttrs: false });
const recordId = ref(''), routeError = ref(''), quantity = ref(''), sourceRef = ref(''), quantityError = ref(''), sourceError = ref('');
const quantityField = ref<InstanceType<typeof FarmTextField> | null>(null), sourceField = ref<InstanceType<typeof FarmTextField> | null>(null);
const prefix = 'eggs-' + getCurrentInstance()!.uid;
const record = computed(() => state.eggsRecordAudience === 'staff' && state.eggsRecord?.recordId === recordId.value ? state.eggsRecord : null);
const readBusy = computed(() => state.busy || state.eggsRecordBusy);
const blocked = computed(() => readBusy.value || state.pending || state.mutationBlocked || !state.snapshot || !record.value?.permissions.canRegister);
const dirty = computed(() => !!quantity.value || !!sourceRef.value);
let pageGeneration = 0;
function clearDraft() { quantity.value = ''; sourceRef.value = ''; quantityError.value = ''; sourceError.value = ''; }
const { leaving, cancelLeave, discardLeave } = useDraftGuard(dirty, clearDraft, prefix + '-leave-cancel');
function refresh() { return loadFarmEggsRecord(recordId.value, 'staff'); }
async function register() {
  if (blocked.value || !record.value) return;
  const number = Number(quantity.value), limit = record.value.maxDailyQuantity || 0;
  quantityError.value = !/^\d{1,5}$/.test(quantity.value) || !Number.isSafeInteger(number) || number < 1 || number > limit ? `请填写1至${limit}的整数，按现场实际产出登记。` : '';
  sourceError.value = !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/.test(sourceRef.value) ? '请填写8至64位来源编号，使用英文字母、数字、下划线、点、冒号或连字符；不要填写姓名或电话。' : '';
  if (quantityError.value) { await quantityField.value?.focus(); return; }
  if (sourceError.value) { await sourceField.value?.focus(); return; }
  const command = { domain: 'eggs' as const, action: 'register' as const, recordId: recordId.value, expectedProfileVersion: record.value.profileVersion, quantity: number, sourceRef: sourceRef.value };
  if (!isEggsCommand(command, 'staff')) return;
  const generation = pageGeneration, account = state.snapshot?.profile.id, selected = recordId.value;
  const applied = await commandFarmEggs('staff', command);
  if (generation !== pageGeneration || selected !== recordId.value || account !== state.snapshot?.profile.id) return;
  if (applied) { clearDraft(); if (state.eggsConfirmedBatchId) openEggsBatch(state.eggsConfirmedBatchId, 'staff'); }
}
watch(() => [state.authenticated, state.snapshot?.profile.id, state.snapshot?.environment], () => { pageGeneration++; });
onLoad(query => { if (typeof query?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(query.id)) { routeError.value = '牧场入口无效，请返回登记工作台重新选择。'; return; } recordId.value = query.id; pageGeneration++; });
onShow(() => { pageGeneration++; if (state.authenticated && recordId.value && !readBusy.value) void refresh(); });
onHide(() => { pageGeneration++; }); onUnload(() => { pageGeneration++; });
</script>
<template>
  <FarmScreen title="登记今日鸡蛋" allow-guest>
    <FarmButton class="action secondary" @tap="openEggs('staff')">返回登记工作台</FarmButton>
    <FarmDraftNotice v-if="leaving" :id-prefix="prefix" :busy="state.busy" description="离开后会清除本页数量和来源编号。结果未确认的原操作仍可从上方核对。" @cancel="cancelLeave" @discard="discardLeave" />
    <view v-if="routeError" class="notice error" role="alert">{{ routeError }}</view>
    <template v-else-if="state.authenticated">
      <view class="notice"><text>仅登记服务器北京时间今天的实际产出。登记后由所属用户手动收取，不自动到账；请只填写合成联调数据。</text></view>
      <view v-if="state.eggsMessage" class="success-note" role="status">{{ state.eggsMessage }}</view>
      <view v-if="state.eggsRecordError" class="notice error" role="alert">{{ state.eggsRecordError }}<text>输入仍保留；核对原操作后再决定，不要换编号重复登记。</text></view>
      <FarmButton class="action secondary" :disabled="readBusy" @tap="refresh">刷新登记资格</FarmButton>
      <view v-if="state.eggsRecordBusy" class="status-line" role="status">正在核对牧场与当前登记授权…</view>
      <view v-if="record" class="panel"><text class="helper">{{ record.unitLabel }} · {{ record.cycleRef }}</text><view class="section-heading">{{ record.name }}</view><text class="body-copy">当前服务日期：{{ farmRecordDate(record.serverTime) }} · 北京时间</text>
        <template v-if="record.permissions.canRegister"><FarmTextField id="egg-quantity" ref="quantityField" v-model="quantity" label="今日实际产出数量（枚）" placeholder="例：6" :help="`1至${record.maxDailyQuantity}枚，只填现场核对后的整数`" :maxlength="5" input-mode="numeric" :error="quantityError" :disabled="blocked" /><FarmTextField id="egg-source" ref="sourceField" v-model="sourceRef" label="来源编号" placeholder="例：synthetic-eggs-001" help="8至64位规范编号，同一来源只登记一次；不要填写个人资料" :maxlength="64" :error="sourceError" :disabled="blocked" /><FarmButton class="action" :disabled="blocked || leaving" @tap="register">登记今日产出</FarmButton><FarmButton v-if="dirty" class="action secondary" :disabled="state.busy" @tap="requestNavigation(clearDraft)">清空本页输入</FarmButton></template>
        <template v-else><text class="body-copy">{{ record.currentBatchId ? '今天已有未撤回的登记，请先查看原产出。已收取的产出不能撤回。' : '当前没有登记权限，或本轮尚未开放登记。请联系农场核查。' }}</text><FarmButton v-if="record.currentBatchId" class="action" :disabled="readBusy" @tap="openEggsBatch(record.currentBatchId!, 'staff')">查看今日登记</FarmButton></template>
      </view>
      <view v-else-if="!state.eggsRecordBusy" class="panel empty-panel"><view class="section-heading">尚未取得登记对象</view><text class="body-copy">请刷新资格。授权撤销后旧页面不会继续提供登记操作。</text></view>
    </template>
    <view v-else class="notice">请先登录田园账户，再从“我的”进入登记工作台。</view>
  </FarmScreen>
</template>
