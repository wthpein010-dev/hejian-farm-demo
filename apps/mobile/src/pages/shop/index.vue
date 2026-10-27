<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, ref, watch } from 'vue';
import { onShow, onHide } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import FarmGoodsPhoto from '../../components/FarmGoodsPhoto.vue';
import { farmState as state, onFarmPageShow, mutateFarm, openCart, openExchangeHistory, openInventory } from '../../core/farm';
import type { CatalogItem } from '../../core/types';
const section = ref<'adopt' | 'supplies' | 'gifts'>('supplies');
const items = computed(() => state.snapshot?.catalog.filter(p => p.category === section.value) || []);
const count = computed(() => Object.values(state.snapshot?.system.cart || {}).reduce((a, b) => a + b, 0));
let active = false, visitAttempted = false;
function visit() {
  if (!active || visitAttempted || state.busy || state.pending || !state.snapshot?.capabilities.activities) return;
  if (!state.snapshot.tasks.some(t => t.id === 'browse' && t.progress === 0)) return;
  visitAttempted = true; void mutateFarm('/events/shop-visit', {}, '');
}
watch([() => state.busy, () => state.snapshot?.revision], visit);
onShow(() => { active = true; visitAttempted = false; onFarmPageShow(); visit(); });
onHide(() => { active = false; });
function remaining(p: CatalogItem) { return Math.max(0, p.limit - (state.snapshot?.system.daily.bought[p.id] || 0)); }
function canAdd(p: CatalogItem) { return !state.busy && !state.pending && !!state.snapshot?.capabilities.pointShop && (state.snapshot.system.cart[p.id] || 0) < Math.min(5, remaining(p)); }
</script>
<template>
  <FarmScreen title="商城">
    <view class="balance-bar"><view><text class="helper">可用田园积分</text><text class="balance-number">{{ state.snapshot?.wallet.points }}</text></view><FarmButton class="action secondary" @tap="openCart">购物车{{ count ? ` · ${count}` : '' }}</FarmButton></view>
    <view class="exchange-links"><FarmButton class="text-action" @tap="openExchangeHistory">兑换记录</FarmButton><FarmButton class="text-action" @tap="openInventory">当前仓库</FarmButton></view>
    <view class="tabs" role="group" aria-label="商城专区"><FarmButton :class="{ active: section === 'adopt' }" :aria-pressed="section === 'adopt'" @tap="section = 'adopt'">当季认养</FarmButton><FarmButton :class="{ active: section === 'supplies' }" :aria-pressed="section === 'supplies'" @tap="section = 'supplies'">农场物资</FarmButton><FarmButton :class="{ active: section === 'gifts' }" :aria-pressed="section === 'gifts'" @tap="section = 'gifts'">积分好礼</FarmButton></view>
    <EmptyPanel v-if="section === 'adopt'" title="认养服务准备中" description="农场核定可认养地块、品种、农时与价格后开放。这里不会创建未经确认的真实认养订单。" />
    <EmptyPanel v-else-if="!state.snapshot?.capabilities.pointShop" title="积分兑换暂未开放" description="农场核定物资和积分规则后开放，当前不会扣除任何积分。" />
    <view v-else class="card-grid"><view v-for="p in items" :key="p.id" class="goods-card"><FarmGoodsPhoto :art="p.art" :title="p.title" /><view class="goods-title">{{ p.title }}</view><text class="helper">{{ p.description }}</text><text class="helper">今日可兑 {{ remaining(p) }} 件<text v-if="state.snapshot?.system.cart[p.id]"> · 车中 {{ state.snapshot.system.cart[p.id] }}</text></text><view class="goods-cost">{{ p.cost }} <text>积分</text></view><FarmButton class="action" :disabled="!canAdd(p)" :aria-label="`加入${p.title}到购物车`" @tap="mutateFarm('/cart/items', { sku: p.id, delta: 1 }, '已加入购物车，可以统一核对兑换。')">{{ remaining(p) ? '加入购物车' : '今日已兑完' }}</FarmButton></view></view>
    <view class="panel"><text class="helper">商品图为AI生成物资示意，非实拍。积分兑换与现金认养分开核对。当前可用服务以农场开放状态为准，物资不会解除照料间隔。</text></view>
  </FarmScreen>
</template>
