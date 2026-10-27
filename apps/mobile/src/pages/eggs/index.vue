<script setup lang="ts">
import { computed, getCurrentInstance, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import { farmState as state, loadFarmEggs, loadFarmEggsRecords, openEggs, openEggsBatch, openEggsRegister, returnFromEggs, eggsStateLabel, eggsDayLabel, farmRecordDate } from '../../core/farm';
import { loadWithPageFocus } from '../../core/pagination-focus';
import type { EggsAudience } from '../../core/types';
defineOptions({ inheritAttrs: false });
const audience = ref<EggsAudience>('customer'), routeError = ref(''), resultId = 'egg-results-' + getCurrentInstance()!.uid;
const page = computed(() => state.eggsAudience === audience.value ? state.eggsPage : null);
const records = computed(() => audience.value === 'staff' && state.eggsAudience === 'staff' ? state.eggsRecords : null);
const readBusy = computed(() => state.busy || state.eggsBusy);
function refresh(cursor = 'start', event?: unknown) { return loadWithPageFocus(cursor, event, () => loadFarmEggs(audience.value, cursor), () => !!page.value?.nextCursor, resultId); }
function moreRecords() { if (records.value?.nextCursor) return loadFarmEggsRecords(records.value.nextCursor); }
onLoad(query => { if (query?.audience !== undefined && !['customer', 'staff'].includes(query.audience)) { routeError.value = '产出入口无效，请返回“我的”重新选择。'; return; } audience.value = query?.audience === 'staff' ? 'staff' : 'customer'; });
onShow(() => { if (state.authenticated && !readBusy.value && (!page.value || (audience.value === 'staff' && !records.value))) void refresh(); });
</script>
<template>
  <FarmScreen :title="audience === 'staff' ? '鸡蛋登记工作台' : '我的鸡蛋产出'" allow-guest>
    <FarmButton class="action secondary" @tap="returnFromEggs">返回上一页</FarmButton>
    <view v-if="routeError" class="notice error" role="alert">{{ routeError }}</view>
    <template v-else-if="state.authenticated">
      <view class="notice"><text>{{ audience === 'staff' ? '仅显示当前授权范围的养鸡档案与产出。按现场实际数量登记服务器北京时间今天的产出，已收取登记不能撤回。' : '农场先登记实际产出，你再逐笔手动收取。旧日未收按原日期保留供核对，不自动补产，也不代表可寄送库存。' }}</text></view>
      <view v-if="state.eggsMessage" class="success-note" role="status">{{ state.eggsMessage }}</view><view v-if="state.eggsError" class="notice error" role="alert">{{ state.eggsError }}<text>刷新只读取当前产出，不重复登记或收取。</text></view>
      <FarmButton class="action secondary" :disabled="readBusy" @tap="refresh()">刷新鸡蛋产出</FarmButton>
      <FarmButton v-if="audience === 'customer' && state.eggsStatus?.hasStaffAccess" class="action secondary" :disabled="readBusy" @tap="openEggs('staff')">进入鸡蛋登记工作台</FarmButton>
      <view :id="resultId" class="registry-status" tabindex="-1" role="status" aria-live="polite"><text v-if="state.eggsBusy">正在读取产出与授权…</text><text v-else-if="page">已显示 {{ page.items.length }} 笔产出{{ page.nextCursor ? '，可继续加载' : '，已全部显示' }}</text></view>
      <view v-if="state.eggsStatus && !state.eggsStatus.available" class="panel empty-panel"><view class="section-heading">鸡蛋登记与收取暂未开放</view><text class="body-copy">农场完成养鸡档案和人员配置后才会开放。当前不会自动生成产出或模拟到账。</text></view>
      <template v-else-if="state.eggsStatus?.available">
        <template v-if="audience === 'staff'"><view class="section-heading">当前授权登记对象</view><view v-if="records && !records.items.length" class="panel empty-panel"><text class="body-copy">当前没有授权对象。请由农场核查独立的产出登记权限。</text></view><view v-for="item in records?.items || []" :key="item.recordId" class="panel"><text class="helper">{{ item.unitLabel }} · {{ item.cycleRef }}</text><view class="section-heading">{{ item.name }}</view><text class="body-copy">{{ item.currentBatchId ? '今天已有未撤回登记，请先核对。' : item.permissions.canRegister ? '今天尚未登记产出。' : '当前不能登记，请核对本轮状态或授权。' }}</text><FarmButton class="action" :disabled="readBusy" @tap="openEggsRegister(item.recordId)">查看今日登记</FarmButton></view><FarmButton v-if="records?.nextCursor" class="action secondary" :disabled="readBusy" @tap="moreRecords">加载更多授权对象</FarmButton><view class="section-heading">授权范围的产出记录</view></template>
        <view v-if="page && !page.items.length && !state.eggsBusy" class="panel empty-panel"><view class="section-heading">还没有鸡蛋产出登记</view><text class="body-copy">{{ audience === 'staff' ? '请先选择授权对象，按实际产出登记今天的数量。' : '农场登记后会显示日期和数量，你可以在这里逐笔手动收取。' }}</text></view>
        <view v-for="item in page?.items || []" :key="item.id" class="panel"><text class="helper">{{ item.unitLabel }} · {{ item.cycleRef }}</text><view class="section-heading">{{ item.name }}</view><text class="record-status">{{ eggsStateLabel(item.status) }}</text><view class="summary-row"><text>{{ eggsDayLabel(item.day) }}</text><text class="record-value">{{ item.quantity }} 枚</text></view><text class="helper">登记：{{ farmRecordDate(item.createdAt) }} · 北京时间</text><FarmButton class="action" :disabled="readBusy" @tap="openEggsBatch(item.id, audience)">{{ audience === 'customer' && item.status === 'available' ? '查看并手动收取' : '查看这笔产出' }}</FarmButton></view>
        <FarmButton v-if="page?.nextCursor" class="action secondary" :disabled="readBusy" :loading="state.eggsBusy" @tap="refresh(page.nextCursor!, $event)">加载更多产出</FarmButton>
      </template><text class="helper registry-footnote">当前为开发沙盒流程，真实养殖、保鲜和物流规则仍需农场确认。</text>
    </template><view v-else class="notice">请先登录田园账户，再查看本人产出或授权登记工作台。</view>
  </FarmScreen>
</template>
