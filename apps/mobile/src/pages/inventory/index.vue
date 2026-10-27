<script setup lang="ts">
import { computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import FarmGoodsPhoto from '../../components/FarmGoodsPhoto.vue';
import { RESOURCE_INFO } from '../../../../../shared/exchanges.mjs';
import { farmState as state, onFarmPageShow, refreshFarm, openExchangeHistory, openShop, openProfile } from '../../core/farm';
const resources = computed(() => RESOURCE_INFO.map(resource => ({ ...resource, quantity: resource.key === 'feed' ? state.snapshot?.wallet.feed : state.snapshot?.system.inventory[resource.key] })));
const harvested = [{ key: 'eggs', title: '累计鸡蛋' }, { key: 'crops', title: '累计蔬菜' }, { key: 'meat', title: '累计肉类' }];
onShow(onFarmPageShow);
</script>
<template>
  <FarmScreen title="我的仓库">
    <FarmButton class="text-action" @tap="openProfile">返回我的田园</FarmButton>
    <template v-if="state.snapshot">
      <view class="panel exchange-intro"><view class="section-heading" role="heading" aria-level="2">当前可用物资</view><text class="body-copy">以下数量来自最近同步的账户余额，与单笔兑换收据中的“本笔发放”分开核对。</text><FarmButton class="action secondary" :disabled="state.busy" :loading="state.busy" @tap="refreshFarm">同步最新仓库</FarmButton></view>
      <view class="stock-grid" role="list" aria-label="当前仓库物资"><view v-for="resource in resources" :key="resource.key" class="stock-item inventory-card" role="listitem"><FarmGoodsPhoto :art="resource.art" :title="resource.title" /><view class="goods-title">{{ resource.title }}</view><text class="stock-count">{{ resource.quantity }} <text class="receipt-unit">{{ resource.unit }}</text></text><text class="helper">{{ resource.quantity ? '当前可用' : '暂未持有' }}</text></view></view>
      <view class="panel"><text class="body-copy">物资按农场安排使用，不能解除照料次数、间隔或设备确认限制。当前暂未开放的真实农事不会因持有物资而自动执行。</text><FarmButton class="action" @tap="openShop">去商城补充物资</FarmButton><FarmButton class="action secondary" @tap="openExchangeHistory">核对积分兑换记录</FarmButton></view>
      <view class="panel"><view class="section-heading" role="heading" aria-level="2">累计收获记录</view><view v-for="item in harvested" :key="item.key" class="summary-row"><text>{{ item.title }}</text><text>{{ state.snapshot.system.inventory[item.key] || 0 }}</text></view><text class="helper registry-footnote">累计数值不代表当前可寄送数量或物流进度，实体履约以农场正式开放的记录为准。</text></view>
      <text class="helper registry-footnote">商品图为AI生成物资示意，非实拍。虚拟积分和物资不等于现金付款或实体配送。</text>
    </template>
  </FarmScreen>
</template>
