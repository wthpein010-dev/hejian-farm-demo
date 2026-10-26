<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import { farmState as state, onFarmPageShow, openProfile, openShop } from '../../core/farm';
const area = ref<'plots' | 'animals'>('plots');
const owned = computed(() => state.snapshot?.farm[area.value] || []);
onShow(onFarmPageShow);
</script>
<template>
  <FarmScreen title="我的田园" subtitle="一方菜园，一份牵挂。" allow-guest>
    <image class="hero-image" src="/static/farm-estate.webp" mode="aspectFill" aria-label="田园概念插画" />
    <view class="hero-caption"><view class="section-heading">身在城市，心有一亩田。</view><text class="helper">田园概念插画 · 认养与作业以农场记录为准</text></view>
    <template v-if="state.snapshot">
      <view class="asset-row"><view class="asset-cell"><text class="asset-number">Lv.{{ state.snapshot.level.level }}</text><text class="asset-label">{{ state.snapshot.level.label }}</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.points }}</text><text class="asset-label">田园积分</text></view><view class="asset-cell"><text class="asset-number">{{ state.snapshot.wallet.feed }}</text><text class="asset-label">饲料份数</text></view></view>
      <view class="tabs" role="group" aria-label="切换菜园与牧场"><FarmButton :class="{ active: area === 'plots' }" :aria-pressed="area === 'plots'" @tap="area = 'plots'">我的菜园</FarmButton><FarmButton :class="{ active: area === 'animals' }" :aria-pressed="area === 'animals'" @tap="area = 'animals'">我的牧场</FarmButton></view>
      <EmptyPanel v-if="!owned.length" :title="area === 'plots' ? '还没有认养地块' : '还没有认养的牧场伙伴'" description="农场开放认养后，可以在这里查看生长记录、照料安排与收获。"><FarmButton class="action secondary" @tap="openShop">看看农场商城</FarmButton></EmptyPanel>
      <view v-for="item in owned" :key="item.id" class="panel"><view class="section-heading">{{ item.name }}</view><text class="helper">{{ item.id }} · 农场记录</text><text class="body-copy">{{ item.status }}</text><text class="helper">照料设备尚未接入，不会从此页面派发实际作业。</text></view>
      <view class="panel"><view class="section-heading">照料要刚刚好</view><text class="body-copy">浇水与投喂遵循农场的次数、间隔和设备确认。补充物资不会增加照料额度。</text></view>
    </template>
    <EmptyPanel v-else title="把自己的田园带在身边" description="登录后，认养记录、物资与收获进度会随账户保存。"><FarmButton class="action" @tap="openProfile">登录我的田园</FarmButton></EmptyPanel>
  </FarmScreen>
</template>
