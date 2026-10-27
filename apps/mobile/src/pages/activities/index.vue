<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import { farmState as state, onFarmPageShow, mutateFarm, rewardLabel, openShop, openFriends, openCommunity } from '../../core/farm';
const tab = ref<'today' | 'growth'>('today');
const sign = computed(() => state.snapshot?.signIn);
const claimed = computed(() => !sign.value ? 0 : sign.value.todayClaimed ? ((sign.value.streak - 1) % 7) + 1 : sign.value.streak % 7);
function shortLabel(label: string) { return label.includes('券') ? '券' : label.includes('份') ? '物资' : label.replace('积分', ''); }
onShow(onFarmPageShow);
</script>
<template>
  <FarmScreen title="合耕小舍">
    <view class="home-profile">
      <image class="home-avatar" src="/static/photos/farm-estate.webp" mode="aspectFill" aria-label="AI生成的农庄静态示意头像，非实拍、非直播" />
      <view class="home-profile-copy"><view class="section-heading">{{ state.snapshot?.profile.displayName }}</view><text class="helper">Lv.{{ state.snapshot?.level.level }} · {{ state.snapshot?.level.label }}</text><text class="helper">农庄头像为AI摄影示意</text></view>
    </view>
    <view v-if="state.snapshot?.capabilities.activities && sign" class="home-sign-row"><view><view class="home-sign-label">每日签到</view><text class="helper">连续 {{ sign.streak }} 天 · {{ sign.todayClaimed ? '今日奖励已到账' : `今日 ${sign.rewards[sign.nextIndex].label}` }}</text></view><FarmButton class="action home-sign-action" :disabled="state.busy || state.pending || sign.todayClaimed" @tap="mutateFarm('/activities/sign-in', {}, '今日签到成功，奖励已收入账户。')">{{ sign.todayClaimed ? '今日已签到，明天再来' : `签到领取 ${sign.rewards[sign.nextIndex].label}` }}</FarmButton></view>
    <view class="home-social-list"><FarmButton class="home-entry" aria-label="进入田园圈子" @tap="openCommunity"><view class="home-entry-symbol home-entry-community" aria-hidden="true"><view /><view /></view><view class="home-entry-copy"><text class="home-entry-title">进入田园圈子</text><text class="helper">聊种养，看看农友的日常</text></view><text class="home-entry-arrow" aria-hidden="true">›</text></FarmButton><FarmButton class="home-entry" aria-label="查看我的农友" @tap="openFriends"><view class="home-entry-symbol home-entry-friends" aria-hidden="true"><view /><view /></view><view class="home-entry-copy"><text class="home-entry-title">查看我的农友</text><text class="helper">交换农友码，彼此确认后添加</text></view><text class="home-entry-arrow" aria-hidden="true">›</text></FarmButton></view>
    <view class="home-service-note"><text class="helper">社区和农友仅在开发沙盒联调，正式服务暂未开放。帖子与评论通过审核才公开；消息、邀请奖励仍待接入。</text></view>
    <EmptyPanel v-if="!state.snapshot?.capabilities.activities" title="活动暂未开放" description="活动安排核定后，会在这里公布参与条件和奖励。" />
    <template v-else>
      <view class="tabs" role="group" aria-label="活动内容"><FarmButton :class="{ active: tab === 'today' }" :aria-pressed="tab === 'today'" @tap="tab = 'today'">今日活动</FarmButton><FarmButton :class="{ active: tab === 'growth' }" :aria-pressed="tab === 'growth'" @tap="tab = 'growth'">成长成就</FarmButton></view>
      <template v-if="tab === 'today' && sign">
        <view class="section-heading">今日农事</view>
        <view v-for="task in state.snapshot.tasks" :key="task.id" class="task-card"><view class="section-heading">{{ task.title }}</view><text class="helper">{{ task.description }}</text><text class="reward-text">{{ rewardLabel(task.reward) }}</text><text class="helper">进度 {{ task.progress }} / {{ task.target }}</text><view class="task-progress" role="progressbar" :aria-label="`${task.title}进度`" :aria-valuenow="task.progress" :aria-valuemin="0" :aria-valuemax="task.target"><view class="task-progress-fill" :style="{ width: `${Math.min(100, task.progress / task.target * 100)}%` }" /></view><FarmButton v-if="task.ready || task.claimed" class="action" :disabled="state.busy || state.pending || task.claimed" @tap="mutateFarm(`/activities/tasks/${task.id}/claim`, {}, '任务奖励已收入账户。')">{{ task.claimed ? '已领取' : '领取奖励' }}</FarmButton><FarmButton v-else-if="task.id === 'browse'" class="action secondary" @tap="openShop">逛逛商城</FarmButton><text v-else class="helper">{{ task.id === 'care' ? '设备接入并确认照料后记录进度。' : '完成实际采收或处理后记录进度。' }}</text></view>
        <view class="panel"><view class="section-heading">丰收季 · 田园三章</view><text class="body-copy">领取今日三项任务奖励，再收一份丰收礼。</text><view class="stamps"><view v-for="(task, i) in state.snapshot.tasks" :key="task.id" class="stamp" :class="{ done: task.claimed }">{{ ['逛田园', '做照料', '有收获'][i] }}</view></view><FarmButton class="action" :disabled="state.busy || state.pending || state.snapshot.season.claimed || !state.snapshot.season.ready" @tap="mutateFarm('/activities/season/claim', {}, '丰收礼已收入账户。')">{{ state.snapshot.season.claimed ? '今日丰收礼已领取' : state.snapshot.season.ready ? '领取今日丰收礼' : `已集齐 ${state.snapshot.season.count} / 3 枚印章` }}</FarmButton></view>
        <view class="panel home-sign-panel"><view class="section-heading">七日签到奖励</view><view class="sign-grid home-sign-grid"><view v-for="(day, i) in sign.rewards" :key="day.day" class="sign-cell" :class="{ done: i < claimed, current: !sign.todayClaimed && i === sign.nextIndex }" :aria-label="`第${day.day}天，${day.label}，${i < claimed ? '已领取' : '待签到'}`"><text>第{{ day.day }}天</text><text class="home-sign-reward">{{ shortLabel(day.label) }}<text v-if="!day.label.includes('券') && !day.label.includes('份')" class="home-sign-unit">积分</text></text><text>{{ i < claimed ? '已领' : i === sign.nextIndex && !sign.todayClaimed ? '今日' : '待签' }}</text></view></view><text class="helper">按北京时间每日签到，断签后重新积累连续天数。积分、物资和积分券按当天奖励发放。</text></view>
      </template>
      <template v-else><view class="panel"><view class="section-heading">Lv.{{ state.snapshot.level.level }} · {{ state.snapshot.level.label }}</view><text class="body-copy">成长值 {{ state.snapshot.level.xp }}</text><text class="helper">成长记录田园历程，不增加实际照料额度。</text></view><view v-for="task in state.snapshot.achievements" :key="task.id" class="task-card"><view class="section-heading">{{ task.title }}</view><text class="helper">{{ task.description }}</text><text class="reward-text">{{ rewardLabel(task.reward) }}</text><text class="helper">累计 {{ task.progress }} / {{ task.target }}</text><FarmButton class="action" :disabled="state.busy || state.pending || task.claimed || !task.ready" @tap="mutateFarm(`/activities/achievements/${task.id}/claim`, {}, '成就奖励已收入账户。')">{{ task.claimed ? '已领取' : task.ready ? '领取成就奖励' : '尚未达成' }}</FarmButton></view></template>
    </template>
  </FarmScreen>
</template>
