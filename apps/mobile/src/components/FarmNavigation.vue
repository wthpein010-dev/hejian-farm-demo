<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmButton from './FarmButton.vue';
import { requestNavigation } from '../core/navigation.mjs';
const route = ref('pages/farm/index');
const entries = [
  { path: 'pages/farm/index', title: '我的农场', icon: 'farm' },
  { path: 'pages/shop/index', title: '商城', icon: 'shop' },
  { path: 'pages/activities/index', title: '主页', icon: 'home' },
  { path: 'pages/live/index', title: '实景', icon: 'live' },
  { path: 'pages/profile/index', title: '我的', icon: 'profile' }
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
const selected = computed(() => ['pages/friends/index', 'pages/community/index', 'pages/forum-post/index'].includes(route.value) ? 'pages/activities/index' : route.value === 'pages/cart/index' ? 'pages/shop/index' : route.value === 'pages/farm-record/index' ? 'pages/farm/index' : ['pages/exchanges/index', 'pages/exchange/index', 'pages/inventory/index', 'pages/planting/index', 'pages/planting-order/index', 'pages/eggs/index', 'pages/egg-batch/index', 'pages/egg-register/index'].includes(route.value) ? 'pages/profile/index' : route.value);
function navigate(path: string) { if (path !== route.value) requestNavigation(() => uni.switchTab({ url: '/' + path })); }
</script>
<template><view class="farm-navigation" role="navigation" aria-label="主导航"><FarmButton v-for="entry in entries" :key="entry.path" class="farm-nav-item" :class="{ active: selected === entry.path }" :aria-current="selected === entry.path ? 'page' : undefined" @tap="navigate(entry.path)"><image class="farm-nav-mark" :src="`/static/navigation/${entry.icon}${selected === entry.path ? '-selected' : ''}.png`" mode="aspectFit" aria-hidden="true" /><text>{{ entry.title }}</text></FarmButton></view></template>
