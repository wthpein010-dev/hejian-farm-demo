<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { computed, nextTick, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import { farmState as state, onFarmPageShow, mutateFarm, openShop, openConfirmedCheckout } from '../../core/farm';
const selectedCoupon = ref('');
const confirmation = ref<{ revision: number; total: number; couponId: string } | null>(null);
const items = computed(() => state.snapshot?.catalog.filter(p => (state.snapshot?.system.cart[p.id] || 0) > 0).map(p => ({ ...p, quantity: state.snapshot!.system.cart[p.id] })) || []);
const count = computed(() => items.value.reduce((n, p) => n + p.quantity, 0));
const subtotal = computed(() => items.value.reduce((n, p) => n + p.cost * p.quantity, 0));
const coupons = computed(() => state.snapshot?.system.coupons.filter(c => !c.used) || []);
const coupon = computed(() => coupons.value.find(c => c.id === selectedCoupon.value));
const discount = computed(() => coupon.value && subtotal.value >= coupon.value.min ? Math.min(subtotal.value, coupon.value.off) : 0);
const total = computed(() => subtotal.value - discount.value);
const affordable = computed(() => !!state.snapshot && state.snapshot.wallet.points >= total.value);
watch(() => state.snapshot?.revision, () => { confirmation.value = null; if (selectedCoupon.value && (!coupon.value || subtotal.value < coupon.value.min)) selectedCoupon.value = ''; });
async function focusSection(id: string) {
  await nextTick();
  // #ifdef H5
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  target?.focus({ preventScroll: true });
  // #endif
  // #ifndef H5
  uni.pageScrollTo({ selector: '#' + id, duration: 0 });
  // #endif
}
async function prepare() {
  if (state.snapshot && !state.busy && !state.pending && count.value && affordable.value) {
    confirmation.value = { revision: state.snapshot.revision, total: total.value, couponId: selectedCoupon.value };
    await focusSection('checkout-confirm');
  }
}
async function edit() { confirmation.value = null; await focusSection('checkout-review'); }
async function checkout() {
  const intent = confirmation.value; if (!intent) return;
  const ok = await mutateFarm('/checkout', { ...(intent.couponId ? { couponId: intent.couponId } : {}), expectedRevision: intent.revision }, '兑换成功，物资已收入仓库。');
  if (ok) { selectedCoupon.value = ''; openConfirmedCheckout(); }
}
function maximum(id: string, limit: number) { return Math.min(5, limit - (state.snapshot?.system.daily.bought[id] || 0)); }
onShow(onFarmPageShow);
</script>
<template>
  <FarmScreen title="购物车">
    <EmptyPanel v-if="!count" title="购物车还是空的" description="去商城挑选需要的饲料、肥料和物资。"><FarmButton id="cart-empty-action" class="action" @tap="openShop">逛逛农场商城</FarmButton></EmptyPanel>
    <template v-else>
      <view v-for="item in items" :key="item.id" class="panel"><view class="section-heading">{{ item.title }}</view><text class="helper">{{ item.cost }} 积分 / 件</text><view class="quantity" :aria-label="`${item.title}数量`"><FarmButton :disabled="state.busy || state.pending" :aria-label="`减少${item.title}`" @tap="mutateFarm('/cart/items', { sku: item.id, delta: -1 }, '')">−</FarmButton><text aria-live="polite">{{ item.quantity }}</text><FarmButton :disabled="state.busy || state.pending || item.quantity >= maximum(item.id, item.limit)" :aria-label="`增加${item.title}`" @tap="mutateFarm('/cart/items', { sku: item.id, delta: 1 }, '')">＋</FarmButton></view><text class="body-copy">小计 {{ item.cost * item.quantity }} 积分</text></view>
      <view class="panel"><view class="section-heading">积分优惠券</view><FarmButton class="coupon" :class="{ selected: !selectedCoupon }" :aria-pressed="!selectedCoupon" :disabled="state.busy || state.pending" @tap="selectedCoupon = ''; confirmation = null">不使用优惠券</FarmButton><FarmButton v-for="c in coupons" :key="c.id" class="coupon" :class="{ selected: selectedCoupon === c.id }" :aria-pressed="selectedCoupon === c.id" :disabled="state.busy || state.pending || subtotal < c.min" @tap="selectedCoupon = c.id; confirmation = null"><text>{{ c.title }}</text><text class="helper">{{ subtotal >= c.min ? `抵${c.off}积分` : `还差${c.min - subtotal}积分` }}</text></FarmButton></view>
      <view class="panel"><view class="summary-row"><text>商品积分 · {{ count }}件</text><text>{{ subtotal }}</text></view><view class="summary-row"><text>优惠抵扣</text><text>− {{ discount }}</text></view><view class="summary-row total"><text>实付积分</text><text>{{ total }}</text></view><text class="helper">当前可用 {{ state.snapshot?.wallet.points }} 积分{{ !affordable ? '，积分不足，请先调整数量或完成活动。' : '' }}</text><FarmButton v-if="!confirmation" id="checkout-review" class="action" style="margin-top:18px" :disabled="state.busy || state.pending || !affordable" @tap="prepare">核对兑换 · {{ total }}积分</FarmButton></view>
      <view v-if="confirmation" id="checkout-confirm" class="panel confirm-panel" tabindex="-1" role="region" aria-label="最终兑换确认"><view class="section-heading">确认兑换这些物资</view><text class="body-copy">共 {{ count }} 件，使用 {{ confirmation.total }} 积分。兑换成功后物资收入仓库，优惠券同时核销。</text><text class="helper">最终金额和库存由服务端再次校验。此次使用虚拟积分，不产生现金付款。</text><FarmButton class="action" :disabled="state.busy || state.pending" @tap="checkout">确认兑换 · {{ confirmation.total }}积分</FarmButton><FarmButton class="action secondary" :disabled="state.busy || state.pending" @tap="edit">返回修改</FarmButton></view>
    </template>
  </FarmScreen>
</template>
