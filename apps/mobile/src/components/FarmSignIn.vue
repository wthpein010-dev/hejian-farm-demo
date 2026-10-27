<script setup lang="ts">
import { computed } from 'vue';
import FarmButton from './FarmButton.vue';
import { farmState as state, mutateFarm } from '../core/farm';
defineOptions({ options: { virtualHost: true, styleIsolation: 'shared' } });
defineProps<{ showProgress?: boolean }>();
const sign = computed(() => state.snapshot?.signIn);
const claimed = computed(() => !sign.value ? 0 : sign.value.todayClaimed ? ((sign.value.streak - 1) % 7) + 1 : sign.value.streak % 7);
</script>
<template>
  <view v-if="state.snapshot?.capabilities.activities && sign" class="home-sign-panel">
    <view class="home-sign-row"><view><view class="home-sign-label">每日签到</view><text class="helper">连续 {{ sign.streak }} 天</text><text class="helper">{{ sign.todayClaimed ? '今日奖励已到账' : `今日 ${sign.rewards[sign.nextIndex].label}` }}</text></view><FarmButton class="action home-sign-action" :disabled="state.busy || state.pending || state.mutationBlocked || sign.todayClaimed" @tap="mutateFarm('/activities/sign-in', {}, '今日签到成功，奖励已收入账户。')">{{ sign.todayClaimed ? '今日已签到，明天再来' : `签到领取 ${sign.rewards[sign.nextIndex].label}` }}</FarmButton></view>
    <view v-if="showProgress" class="sign-week" aria-label="本轮七日签到进度"><view v-for="(day, i) in sign.rewards" :key="day.day" class="sign-day" :class="{ done: i < claimed, current: !sign.todayClaimed && i === sign.nextIndex }" :aria-label="`第${day.day}天，${day.label}，${i < claimed ? '已领取' : '待签到'}`"><text>{{ day.day }}</text><text>{{ i < claimed ? '已签' : !sign.todayClaimed && i === sign.nextIndex ? '今日' : '待签' }}</text></view></view>
  </view>
</template>
