<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmButton from './FarmButton.vue';
const route = ref('pages/farm/index');
const entries = [
  { path: 'pages/farm/index', title: '我的农场', mark: '田' },
  { path: 'pages/shop/index', title: '商城', mark: '集' },
  { path: 'pages/activities/index', title: '活动', mark: '礼' },
  { path: 'pages/live/index', title: '实景', mark: '景' },
  { path: 'pages/profile/index', title: '我的', mark: '我' }
];
function syncRoute() { const pages = getCurrentPages(); route.value = pages[pages.length - 1]?.route || 'pages/farm/index'; }
function prepareNavigation() {
  syncRoute();
  if (entries.some(entry => entry.path === route.value)) {
    // The page must be mounted before the framework can hide its own tab bar.
    // CSS remains the fallback during the first frame or a direct cart entry.
    uni.hideTabBar({ animation: false, fail: () => {} });
  }
}
onShow(prepareNavigation);
onMounted(prepareNavigation);
const selected = computed(() => route.value === 'pages/cart/index' ? 'pages/shop/index' : route.value === 'pages/farm-record/index' ? 'pages/farm/index' : ['pages/exchanges/index', 'pages/exchange/index', 'pages/inventory/index'].includes(route.value) ? 'pages/profile/index' : route.value);
function navigate(path: string) { if (path !== route.value) uni.switchTab({ url: '/' + path }); }
</script>
<template><view class="farm-navigation" role="navigation" aria-label="主导航"><FarmButton v-for="entry in entries" :key="entry.path" class="farm-nav-item" :class="{ active: selected === entry.path }" :aria-current="selected === entry.path ? 'page' : undefined" @tap="navigate(entry.path)"><text class="farm-nav-mark" aria-hidden="true">{{ entry.mark }}</text><text>{{ entry.title }}</text></FarmButton></view></template>
