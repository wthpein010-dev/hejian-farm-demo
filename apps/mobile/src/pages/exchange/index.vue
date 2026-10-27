<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import FarmGoodsPhoto from '../../components/FarmGoodsPhoto.vue';
import { isExchangeId, RESOURCE_INFO } from '../../../../../shared/exchanges.mjs';
import { farmState as state, loadExchangeRecord, openExchangeHistory, openInventory, openProfile, returnFromExchange } from '../../core/farm';
import type { ResourceKey } from '../../core/types';

defineOptions({ inheritAttrs: false });
const requestedId = ref(''), routeError = ref(''), lastReceiptId = ref('');
let receiptRead = 0;
const detail = computed(() => {
  if (!state.exchangeRecord) return null;
  if (requestedId.value === 'last') return lastReceiptId.value === state.exchangeRecord.exchange.id ? state.exchangeRecord : null;
  return state.exchangeRecord.exchange.id === requestedId.value ? state.exchangeRecord : null;
});
const exchange = computed(() => detail.value?.exchange || null);
const received = computed(() => RESOURCE_INFO.map(resource => ({ ...resource, quantity: exchange.value?.received[resource.key as ResourceKey] || 0 })).filter(resource => resource.quantity > 0));
async function load() {
  const target = requestedId.value; if (!target) return;
  const read = ++receiptRead;
  if (target === 'last') lastReceiptId.value = '';
  const loaded = await loadExchangeRecord(target);
  if (read === receiptRead && target === 'last' && requestedId.value === target) lastReceiptId.value = loaded ? state.exchangeRecord?.exchange.id || '' : '';
}
onLoad(query => {
  if (query?.operation === 'last' && !query?.id) requestedId.value = 'last';
  else if (!query?.operation && isExchangeId(query?.id)) requestedId.value = query!.id as string;
  else routeError.value = '收据位置无效，请从兑换记录重新选择。';
});
onShow(() => { if (state.authenticated) void load(); });
</script>
<template>
  <FarmScreen title="积分兑换收据" subtitle="核对这一笔，心中有数。" allow-guest hide-checkout-receipt>
    <FarmButton class="text-action" @tap="returnFromExchange">返回上一页</FarmButton>
    <view v-if="routeError" class="notice error" role="alert"><text>{{ routeError }}</text><FarmButton class="action secondary" @tap="openExchangeHistory">查看全部兑换记录</FarmButton></view>
    <EmptyPanel v-else-if="!state.authenticated" title="登录后查看自己的收据" description="收据只属于当前田园账户。登录后请从兑换记录中重新选择。"><FarmButton class="action" @tap="openProfile">登录我的田园</FarmButton></EmptyPanel>
    <template v-else>
      <view class="registry-status" role="status" aria-live="polite"><text v-if="state.exchangeRecordBusy">正在核对本笔兑换收据…</text><text v-else-if="exchange">本笔兑换已确认，物资按以下明细发放。</text></view>
      <view v-if="state.exchangeRecordError" class="notice error" role="alert"><text>{{ state.exchangeRecordError }}</text><FarmButton class="action secondary" :disabled="state.exchangeRecordBusy" @tap="load">重新读取本笔收据</FarmButton><FarmButton class="action secondary" @tap="openExchangeHistory">查看全部兑换记录</FarmButton></view>
      <template v-if="exchange">
        <view class="panel receipt-overview"><text class="helper">兑换日期 · {{ exchange.day }}（北京时间）</text><view class="section-heading" role="heading" aria-level="2">已兑换 {{ exchange.count }} 件物资</view><view class="receipt-points"><text class="helper">本笔实扣积分</text><text class="balance-number">{{ exchange.total }} <text class="receipt-unit">积分</text></text></view><text class="helper">下列内容保留兑换当时的记录，不随商城价格或商品说明变化。</text></view>
        <view class="section-heading" role="heading" aria-level="2">本笔商品明细</view>
        <view class="panel receipt-items" role="list" aria-label="本笔兑换商品">
          <view v-for="item in exchange.items" :key="item.sku" class="receipt-item" role="listitem"><FarmGoodsPhoto :art="item.art" :title="item.title" /><view class="receipt-item-copy"><view class="goods-title">{{ item.title }}</view><text class="body-copy">{{ item.unitPoints }} 积分 / 件 × {{ item.quantity }} 件</text><text class="helper">商品小计 {{ item.linePoints }} 积分</text></view></view>
          <view class="summary-row"><text>商品积分小计</text><text>{{ exchange.subtotal }} 积分</text></view><view class="summary-row"><text>积分券抵扣</text><text>− {{ exchange.discount }} 积分</text></view><view class="summary-row total"><text>实扣积分</text><text>{{ exchange.total }} 积分</text></view><text class="helper registry-footnote">{{ exchange.couponId ? '本笔已使用积分券并核销。' : '本笔未使用积分券。' }}</text>
        </view>
        <view class="panel"><view class="section-heading" role="heading" aria-level="2">本笔发放</view><view v-for="resource in received" :key="resource.key" class="summary-row"><text>{{ resource.title }}</text><text>{{ resource.quantity }} {{ resource.unit }}</text></view><text class="helper registry-footnote">以上是这一笔发放的物资，不是当前仓库余额。之后的领取、兑换和使用会改变余额，请进入仓库核对最新数据。</text><FarmButton class="action" @tap="openInventory">查看当前仓库</FarmButton><FarmButton class="action secondary" @tap="openExchangeHistory">查看全部兑换记录</FarmButton></view>
        <view class="notice"><text>本收据用于核对虚拟积分与物资，不代表现金付款、认养成功或实体配送。商品图为AI生成物资示意，非实拍。</text></view>
      </template>
    </template>
  </FarmScreen>
</template>
