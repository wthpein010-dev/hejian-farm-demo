<script setup lang="ts">
import { farmState as state, retryFarmRecovery, continueFarmRecovery, abandonFarmRecovery, acknowledgeFarmRecovery, retryFarmOperation, recoveryActionLabel, recoveryObjectLabel, recoveryResultLabel, farmRecordDate, refreshFarm } from '../core/farm';
import FarmButton from './FarmButton.vue';
</script>
<template>
  <view v-if="state.authenticated && (state.recoveryDiscovery === 'checking' || state.recoveryDiscovery === 'error' || state.recoveryDiscovery === 'open' || state.recoveryStage)" class="notice recovery-notice" role="status" aria-live="polite">
    <view class="section-heading">上次操作核对</view>
    <template v-if="state.recoveryDiscovery === 'checking'"><text>正在检查账户中的上次操作，请稍候。</text></template>
    <template v-else-if="state.recoveryDiscovery === 'error'"><text>上次操作暂未检查完成。你可以查看资料，核对前暂不能提交新操作。</text><text class="helper">{{ state.recoveryError }}</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="retryFarmRecovery">重新检查上次操作</FarmButton></template>
    <template v-else-if="state.recoveryDiscovery === 'open' && !state.recoveryStage"><text>{{ state.pending ? '账户还有待核对的原操作。请先核对当前未确认操作，再检查恢复项。' : '账户还有待核对的原操作，请重新检查原结果，再继续新的操作。' }}</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="retryFarmRecovery">重新检查上次操作</FarmButton></template>
    <template v-if="state.recoveryIntent">
      <text class="recovery-copy">原动作：{{ recoveryActionLabel(state.recoveryIntent.command) }} · {{ 'domain' in state.recoveryIntent.command ? '鸡蛋产出' : '播种作业' }} · {{ state.recoveryIntent.audience === 'staff' ? '授权人员' : '我的田园' }}</text>
      <text class="recovery-copy">原对象：{{ recoveryObjectLabel(state.recoveryIntent.command) }}</text>
      <text class="helper">准备时间：{{ farmRecordDate(state.recoveryIntent.createdAt) }}</text>
      <template v-if="state.recoveryStage === 'prepared'"><text>这次操作已准备，尚未取得执行结果。请明确选择继续原操作，或放弃这次未执行操作。</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="continueFarmRecovery">继续原操作</FarmButton><FarmButton class="action secondary" :disabled="state.busy" @tap="abandonFarmRecovery">放弃这次未执行操作</FarmButton></template>
      <template v-else-if="state.recoveryIntent.receipt">
        <text class="recovery-copy">原结果：{{ recoveryResultLabel(state.recoveryIntent.receipt) }}</text><text class="recovery-copy">原结果时间：{{ farmRecordDate(state.recoveryIntent.receipt.completedAt) }}</text>
        <text>{{ 'eggFormat' in state.recoveryIntent.receipt ? '这是本笔原结果，当前产出状态与田园资产另行读取，不能把原数量当作当前库存。' : '这是原操作结果，当前作业进展可能已变化。确认结果不代表设备回执。' }}</text>
        <text v-if="state.recoveryStage === 'ack-unknown'">原结果已取得，确认状态尚待核对。重试只确认这一条原结果。</text>
        <FarmButton class="action recovery-action" :disabled="state.busy" @tap="acknowledgeFarmRecovery">{{ state.recoveryStage === 'ack-unknown' ? '重试原结果确认' : '已核对结果，继续' }}</FarmButton>
      </template>
      <text v-else-if="state.recoveryStage === 'quarantined'">此操作来自恢复备份，执行情况需要农场人工核查。请联系农场，暂不能自行继续或解除。</text>
      <FarmButton v-else class="action recovery-action" :disabled="state.busy" @tap="retryFarmOperation">核对原操作状态</FarmButton>
    </template>
    <FarmButton v-else-if="state.recoveryStage === 'prepare-unknown'" class="action recovery-action" :disabled="state.busy" @tap="retryFarmOperation">核对原操作准备</FarmButton>
  </view>
  <view v-if="state.authenticated && state.assetSyncRequired" class="notice recovery-notice" role="status" aria-live="polite"><view class="section-heading">收蛋结果已确认，资产待同步</view><text>原收取结果已保留。请同步相应的田园资产，确认前暂不能提交新操作；查看产出和档案仍可继续。</text><text v-if="state.eggsSyncError" class="helper">{{ state.eggsSyncError }}</text><FarmButton class="action recovery-action" :disabled="state.busy" @tap="refreshFarm">重新同步田园资产</FarmButton></view>
</template>
