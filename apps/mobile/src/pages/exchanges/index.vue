<script setup lang="ts">
import { nextTick } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import FarmGoodsPhoto from '../../components/FarmGoodsPhoto.vue';
import { farmState as state, loadExchangeHistory, openExchangeRecord, openInventory, openShop, openProfile } from '../../core/farm';
let requestedCursor = 'start';
async function load(cursor = 'start', event?: unknown) {
  requestedCursor = cursor;
  // #ifdef H5
  const activation = event as MouseEvent | undefined;
  const trigger = activation?.currentTarget;
  const keyboardTrigger = cursor !== 'start' && activation?.detail === 0 && trigger instanceof HTMLElement && document.activeElement === trigger ? trigger : null;
  // #endif
  const loaded = await loadExchangeHistory(cursor);
  // #ifdef H5
  if (!keyboardTrigger || !loaded || state.exchangeHistory?.nextCursor) return;
  await nextTick();
  if (keyboardTrigger.isConnected || (document.activeElement !== document.body && document.activeElement !== keyboardTrigger)) return;
  const result = document.getElementById('exchange-history-result');
  result?.focus({ preventScroll: true }); result?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  // #endif
}
onShow(() => { if (state.authenticated && !state.exchangeHistory) load(); });
</script>
<template>
  <FarmScreen title="积分兑换记录" subtitle="每一笔所需，都有据可查。" allow-guest>
    <FarmButton class="text-action" @tap="openProfile">返回我的田园</FarmButton>
    <EmptyPanel v-if="!state.authenticated" title="登录后查看自己的兑换记录" description="记录只属于当前田园账户，登录后可查看。"><FarmButton class="action" @tap="openProfile">登录我的田园</FarmButton></EmptyPanel>
    <template v-else>
      <view class="panel exchange-intro"><text class="body-copy">按兑换日期由近到远排列。收据保留当时的物资、优惠与实扣积分。</text><text class="helper">这里是虚拟积分兑换记录，不是现金付款或实体配送订单。记录按最近读取结果显示，可刷新核对。</text><FarmButton class="action secondary" :disabled="state.exchangeHistoryBusy" @tap="load()">刷新全部兑换记录</FarmButton><FarmButton class="action secondary" @tap="openInventory">查看当前仓库</FarmButton></view>
      <view id="exchange-history-result" class="registry-status" role="status" aria-live="polite" tabindex="-1"><text v-if="state.exchangeHistoryBusy">正在读取兑换记录…</text><text v-else-if="state.exchangeHistory">已显示 {{ state.exchangeHistory.items.length }} 笔{{ state.exchangeHistory.nextCursor ? '，可继续加载更早记录' : '，已全部显示' }}</text></view>
      <view v-if="state.exchangeHistoryError" class="notice error" role="alert"><text>{{ state.exchangeHistoryError }}</text><FarmButton class="action secondary" :disabled="state.exchangeHistoryBusy" @tap="load(requestedCursor)">重试读取记录</FarmButton></view>
      <EmptyPanel v-if="state.exchangeHistory && !state.exchangeHistory.items.length && !state.exchangeHistoryBusy" title="还没有积分兑换记录" description="从农场商城按需挑选物资，成功兑换后可在这里核对。"><FarmButton class="action" @tap="openShop">逛逛农场商城</FarmButton></EmptyPanel>
      <view v-if="state.exchangeHistory?.items.length" role="list" aria-label="全部积分兑换记录">
        <view v-for="exchange in state.exchangeHistory.items" :key="exchange.id" class="panel exchange-card" role="listitem">
          <text class="helper">兑换日期 · {{ exchange.day }}（北京时间）</text>
          <view class="exchange-preview"><FarmGoodsPhoto :art="exchange.items[0].art" :title="exchange.items[0].title" /><view class="exchange-preview-copy"><view class="section-heading" role="heading" aria-level="2">{{ exchange.items[0].title }}{{ exchange.items.length > 1 ? '等' : '' }}</view><text class="body-copy">共 {{ exchange.count }} 件 · 实扣 {{ exchange.total }} 积分</text><text v-if="exchange.discount" class="helper">本笔已抵扣 {{ exchange.discount }} 积分</text></view></view>
          <FarmButton class="action secondary" :aria-label="`查看${exchange.day}兑换${exchange.items[0].title}等${exchange.count}件物资的收据，实扣${exchange.total}积分`" @tap="openExchangeRecord(exchange.id)">查看本笔收据</FarmButton>
        </view>
      </view>
      <FarmButton v-if="state.exchangeHistory?.nextCursor" class="action secondary" :disabled="state.exchangeHistoryBusy" :loading="state.exchangeHistoryBusy" @tap="load(state.exchangeHistory.nextCursor, $event)">加载更早的兑换记录</FarmButton>
      <text v-else-if="state.exchangeHistory?.items.length" class="helper registry-footnote">已显示全部兑换记录。</text>
      <text class="helper registry-footnote">商品图为AI生成物资示意，非实拍。</text>
    </template>
  </FarmScreen>
</template>
