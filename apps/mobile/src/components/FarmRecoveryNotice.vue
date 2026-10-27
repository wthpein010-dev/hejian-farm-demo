<script setup lang="ts">
import { farmState as state, retryFarmRecovery, continueFarmPlanting, abandonFarmPlanting, acknowledgeFarmPlanting, retryFarmOperation, plantingActionLabel, plantingResultLabel, farmRecordDate } from '../core/farm';
import FarmButton from './FarmButton.vue';
</script>
<template>
  <view v-if="state.authenticated && (state.recoveryDiscovery === 'checking' || state.recoveryDiscovery === 'error' || state.recoveryDiscovery === 'open' || state.recoveryStage)" class="notice recovery-notice" role="status" aria-live="polite">
    <view class="section-heading">上次播种操作核对</view>
    <template v-if="state.recoveryDiscovery === 'checking'"><text>正在检查账户中的上次操作，请稍候。</text></template>
    <template v-else-if="state.recoveryDiscovery === 'error'"><text>上次操作暂未检查完成。你可以查看资料，核对前暂不能提交新操作。</text><text class="helper">{{ state.recoveryError }}</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="retryFarmRecovery">重新检查上次操作</FarmButton></template>
    <template v-else-if="state.recoveryDiscovery === 'open' && !state.recoveryStage"><text>{{ state.pending ? '账户还有待核对的播种操作。请先核对当前未确认操作，再检查播种恢复项。' : '账户还有待核对的播种操作，请重新检查原结果，再继续新的操作。' }}</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="retryFarmRecovery">重新检查上次操作</FarmButton></template>
    <template v-if="state.recoveryIntent">
      <text class="recovery-copy">原动作：{{ plantingActionLabel(state.recoveryIntent.command.action) }} · {{ state.recoveryIntent.audience === 'staff' ? '农务作业' : '我的播种' }}</text>
      <text class="recovery-copy">原对象：{{ 'recordId' in state.recoveryIntent.command ? state.recoveryIntent.command.recordId : state.recoveryIntent.command.orderId }}</text>
      <text class="helper">准备时间：{{ farmRecordDate(state.recoveryIntent.createdAt) }}</text>
      <template v-if="state.recoveryStage === 'prepared'"><text>这次操作已准备，尚未取得执行结果。请明确选择继续原操作，或放弃这次未执行操作。</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="continueFarmPlanting">继续原操作</FarmButton><FarmButton class="action secondary" :disabled="state.busy" @tap="abandonFarmPlanting">放弃这次未执行操作</FarmButton></template>
      <template v-else-if="state.recoveryIntent.receipt">
        <text class="recovery-copy">原结果：{{ plantingResultLabel(state.recoveryIntent.receipt) }}</text><text class="recovery-copy">原结果时间：{{ farmRecordDate(state.recoveryIntent.receipt.completedAt) }}</text>
        <text>这是原操作结果，当前作业进展可能已变化。确认结果不代表设备回执。</text>
        <text v-if="state.recoveryStage === 'ack-unknown'">原结果已取得，确认状态尚待核对。重试只确认这一条原结果。</text>
        <FarmButton class="action recovery-action" :disabled="state.busy" @tap="acknowledgeFarmPlanting">{{ state.recoveryStage === 'ack-unknown' ? '重试原结果确认' : '已核对结果，继续' }}</FarmButton>
      </template>
      <text v-else-if="state.recoveryStage === 'quarantined'">此操作来自恢复备份，执行情况需要农场人工核查。请联系农场，暂不能自行继续或解除。</text>
      <FarmButton v-else class="action recovery-action" :disabled="state.busy" @tap="retryFarmOperation">核对原操作状态</FarmButton>
    </template>
    <FarmButton v-else-if="state.recoveryStage === 'prepare-unknown'" class="action recovery-action" :disabled="state.busy" @tap="retryFarmOperation">核对原操作准备</FarmButton>
  </view>
</template>
