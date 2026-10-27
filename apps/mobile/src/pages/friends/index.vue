<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { onShow, onHide } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import { farmState as state, loadFarmFriends, commandFarmFriends, returnFromFriends } from '../../core/farm';
import { isFriendCode } from '../../../../../shared/friends.mjs';
import type { FriendAction, FriendCommand, FriendEntry } from '../../core/types';
defineOptions({ inheritAttrs: false });
const draft = ref(''), inputError = ref(''), copyMessage = ref('');
const codeFocused = ref(false);
let privateInputGeneration = 0;
const confirmation = ref<{ action: 'remove' | 'block' | 'disable'; peer?: FriendEntry; version: number } | null>(null);
const current = computed(() => state.friends);
const blocked = computed(() => state.busy || state.pending || state.friendsBusy || !current.value);
const canUse = computed(() => !blocked.value && current.value?.available && current.value.enabled);
const groups = computed(() => [
  { key: 'incoming', title: '收到的申请', empty: '还没有收到申请。将自己的农友码交给认识的人，由你决定是否接受。', items: current.value?.incoming || [] },
  { key: 'friends', title: '我的农友', empty: '还没有农友。用认识的人的农友码发送申请，对方接受后会显示在这里。', items: current.value?.friends || [] },
  { key: 'outgoing', title: '发出的申请', empty: '没有等待对方处理的申请。', items: current.value?.outgoing || [] },
  { key: 'blocked', title: '已屏蔽', empty: '没有已屏蔽的农友。', items: current.value?.blocked || [] }
]);
const confirmationTitle = computed(() => confirmation.value?.action === 'disable' ? '关闭我的农友名片' : `${confirmation.value?.action === 'block' ? '屏蔽' : '移除'}${confirmation.value?.peer?.alias || '这位农友'}`);
const confirmationCopy = computed(() => confirmation.value?.action === 'disable'
  ? '关闭后，你的名片、全部农友、双向申请和主动屏蔽将被移除。以后重新开通需要重新交换农友码，已有申请次数不会重置。'
  : confirmation.value?.action === 'block' ? '屏蔽会移除你们的关系和申请，对方无法再向你申请。解除屏蔽后，原关系不会恢复。' : '移除后，你们将不再是农友。以后需要重新申请并由对方接受。');
async function focus(id: string) {
  await nextTick();
  // #ifdef H5
  const target = document.getElementById(id); target?.scrollIntoView({ block: 'center', behavior: 'auto' }); target?.focus({ preventScroll: true });
  // #endif
  // #ifndef H5
  if (id === 'friend-code-input') { codeFocused.value = false; await nextTick(); codeFocused.value = true; }
  uni.pageScrollTo({ selector: '#' + id, duration: 0 });
  // #endif
}
function resetPrivateInput() { privateInputGeneration++; codeFocused.value = false; draft.value = ''; inputError.value = ''; copyMessage.value = ''; confirmation.value = null; }
watch(() => [state.authenticated, state.snapshot?.profile.id], resetPrivateInput);
onHide(resetPrivateInput);
onShow(() => { if (state.authenticated && !state.busy && !state.pending) void loadFarmFriends(); });
async function submitCode() {
  if (!canUse.value) return;
  inputError.value = '';
  if (!isFriendCode(draft.value)) { inputError.value = '请粘贴完整的32位小写农友码，不要附加空格或其他文字。'; await focus('friend-code-input'); return; }
  if (await commandFarmFriends({ action: 'request', code: draft.value })) { draft.value = ''; await focus('friends-feedback'); }
}
function clearCode() { draft.value = ''; inputError.value = ''; void focus('friend-code-input'); }
function updateNativeCode(event: Event) { if (canUse.value) draft.value = (event.target as HTMLInputElement).value; }
function pasteCode() {
  if (!canUse.value) return;
  const ownerId = current.value?.ownerId, inputGeneration = privateInputGeneration;
  const active = () => inputGeneration === privateInputGeneration && ownerId === current.value?.ownerId && canUse.value;
  uni.getClipboardData({ success: result => { if (active()) { draft.value = result.data; inputError.value = ''; void focus('friend-code-input'); } }, fail: () => { if (active()) inputError.value = '暂时无法读取剪贴板，请长按输入框粘贴农友码。'; } });
}
function copyCode() {
  const profile = current.value?.profile; if (!profile || blocked.value) return;
  const ownerId = current.value?.ownerId, inputGeneration = privateInputGeneration;
  const active = () => inputGeneration === privateInputGeneration && ownerId === current.value?.ownerId && current.value?.profile === profile && !blocked.value;
  copyMessage.value = '';
  uni.setClipboardData({ data: profile.code, showToast: false, success: () => { if (active()) copyMessage.value = '自己的农友码已复制。复制不代表申请已发送。'; }, fail: () => { if (active()) copyMessage.value = '复制未完成，请长按上方农友码手动复制。'; } });
}
async function ask(action: 'remove' | 'block' | 'disable', peer?: FriendEntry) {
  if (!canUse.value || !current.value) return;
  confirmation.value = { action, peer, version: current.value.version }; await focus('friend-confirm-cancel');
}
function cancelAction() { confirmation.value = null; void focus('friends-controls'); }
async function confirmAction() {
  const selected = confirmation.value; if (!selected || !canUse.value) return;
  if (selected.version !== current.value?.version) { confirmation.value = null; inputError.value = '农友关系已更新，请查看最新列表，再重新决定。'; await focus('friends-feedback'); return; }
  const command: FriendCommand = selected.action === 'disable' ? { action: 'disable' } : { action: selected.action, peerId: selected.peer!.peerId };
  if (await commandFarmFriends(command)) { confirmation.value = null; await focus('friends-feedback'); }
}
async function act(action: Exclude<FriendAction, 'enable' | 'disable' | 'request' | 'remove' | 'block'>, peer: FriendEntry) {
  if (!canUse.value) return;
  await commandFarmFriends({ action, peerId: peer.peerId }); await focus('friends-feedback');
}
</script>
<template>
  <FarmScreen title="我的农友">
    <FarmButton class="action secondary" @tap="returnFromFriends">返回田园主页</FarmButton>
    <view class="notice"><text>当前仅在开发沙盒联调农友关系，正式服务暂未开放。不会读取通讯录、发送平台消息或发放邀请奖励。</text></view>
    <view id="friends-feedback" tabindex="-1" class="friends-feedback">
      <view v-if="state.friendsBusy" class="status-line" role="status">正在读取农友资料…</view>
      <view v-if="state.friendsMessage" class="success-note" role="status">{{ state.friendsMessage }}</view>
      <view v-if="state.friendsError" class="notice error" role="alert">{{ state.friendsError }}<text>已确认的操作不会重新发送，请刷新列表查看当前关系。</text></view>
      <view v-if="inputError" id="friend-code-error" class="notice error" role="alert">{{ inputError }}</view>
      <view v-if="copyMessage" class="status-line" role="status">{{ copyMessage }}</view>
    </view>
    <FarmButton id="friends-controls" class="action secondary" :disabled="state.busy || state.friendsBusy || state.pending" @tap="loadFarmFriends">刷新农友列表</FarmButton>
    <view v-if="!current && !state.friendsBusy" class="panel empty-panel"><view class="section-heading">农友资料尚未取得</view><text class="body-copy">请刷新后查看。读取成功前无法开通名片或修改关系。</text></view>
    <template v-if="current">
      <view v-if="!current.available" class="panel empty-panel"><view class="section-heading">农友功能暂未开放</view><text class="body-copy">正式运营与审核准备完成后，会在这里说明开放安排。</text></view>
      <view v-else-if="!current.enabled" class="panel friends-profile"><text class="helper">自己的田园名片</text><view class="section-heading">先开通，再认识农友</view><text class="body-copy">开通后生成系统别名和农友码。只有拿到你的码并发送申请的人才能与你建立关系，仍需要你明确接受。</text><FarmButton class="action" :disabled="blocked" @tap="commandFarmFriends({ action: 'enable' })">开通农友名片</FarmButton></view>
      <template v-else>
        <view class="panel friends-profile"><text class="helper">自己的田园名片 · 开发沙盒</text><view class="section-heading">{{ current.profile?.alias }}</view><text class="body-copy">只把农友码交给认识的人。没有公开目录，也不会展示你的平台身份。</text><text class="friends-own-code" selectable aria-label="自己的农友码">{{ current.profile?.code }}</text><FarmButton class="action" :disabled="blocked" @tap="copyCode">复制自己的农友码</FarmButton></view>
        <view class="panel"><view class="section-heading">添加一位农友</view>
          <!-- #ifdef H5 -->
          <component :is="'label'" class="form-label" for="friend-code-input">对方的农友码</component>
          <component :is="'input'" id="friend-code-input" :value="draft" placeholder="粘贴对方分享的农友码" class="text-input friends-code-input" type="text" maxlength="128" :disabled="!canUse" :aria-invalid="!!inputError" :aria-describedby="inputError ? 'friend-code-help friend-code-error' : 'friend-code-help'" autocomplete="off" autocapitalize="off" :spellcheck="false" @input="updateNativeCode" />
          <!-- #endif -->
          <!-- #ifndef H5 -->
          <label class="form-label" for="friend-code-input">对方的农友码</label>
          <input id="friend-code-input" v-model="draft" placeholder="粘贴对方分享的农友码" placeholder-style="color: var(--secondary); opacity: 1;" placeholder-class="input-placeholder" class="text-input friends-code-input" maxlength="128" :disabled="!canUse" :focus="codeFocused" :aria-invalid="!!inputError" :aria-describedby="inputError ? 'friend-code-help friend-code-error' : 'friend-code-help'" autocomplete="off" confirm-type="done" @blur="codeFocused = false" />
          <!-- #endif -->
        <text id="friend-code-help" class="helper">粘贴32位小写农友码，核对后点击“发送农友申请”。输入或按回车都不会自动发送。</text><view class="friends-inline"><FarmButton class="action secondary" :disabled="!canUse" @tap="pasteCode">粘贴农友码</FarmButton><FarmButton v-if="draft" class="action secondary" :disabled="!canUse" @tap="clearCode">清除农友码</FarmButton></view><FarmButton class="action" :disabled="!canUse || !draft" @tap="submitCode">发送农友申请</FarmButton><text class="helper">双方同属一个环境且已开通，才可申请。关系与申请合计最多200条，每天最多20次新申请；额度为联调提案。</text></view>
        <view v-if="confirmation" class="panel deletion-confirm" role="region" aria-labelledby="friend-confirm-title"><view id="friend-confirm-title" class="section-heading">{{ confirmationTitle }}</view><text class="body-copy">{{ confirmationCopy }}</text><FarmButton id="friend-confirm-cancel" class="action secondary" :disabled="blocked" @tap="cancelAction">返回，暂不操作</FarmButton><FarmButton class="action danger" :disabled="!canUse" @tap="confirmAction">确认{{ confirmation?.action === 'disable' ? '关闭农友名片' : confirmation?.action === 'block' ? '屏蔽这位农友' : '移除这位农友' }}</FarmButton></view>
        <view v-for="group in groups" :key="group.key" class="panel"><view class="section-heading">{{ group.title }} · {{ group.items.length }}</view><text v-if="!group.items.length" class="body-copy">{{ group.empty }}</text><view v-for="peer in group.items" :key="peer.peerId" class="friends-person"><view class="friends-alias">{{ peer.alias }}</view><text class="helper">{{ group.key === 'incoming' ? '等待你决定' : group.key === 'outgoing' ? '等待对方接受' : group.key === 'blocked' ? '已屏蔽，解除后不会恢复关系' : '已相互确认的农友' }}</text><template v-if="group.key === 'incoming'"><FarmButton class="action" :disabled="!canUse || !!confirmation" @tap="act('accept', peer)">接受申请</FarmButton><FarmButton class="action secondary" :disabled="!canUse || !!confirmation" @tap="act('decline', peer)">婉拒申请</FarmButton></template><FarmButton v-if="group.key === 'outgoing'" class="action secondary" :disabled="!canUse || !!confirmation" @tap="act('cancel', peer)">取消申请</FarmButton><FarmButton v-if="group.key === 'friends'" class="action secondary" :disabled="!canUse || !!confirmation" @tap="ask('remove', peer)">移除农友</FarmButton><FarmButton v-if="group.key !== 'blocked'" class="action danger-outline" :disabled="!canUse || !!confirmation" @tap="ask('block', peer)">屏蔽这位农友</FarmButton><FarmButton v-else class="action secondary" :disabled="!canUse || !!confirmation" @tap="act('unblock', peer)">解除屏蔽</FarmButton></view></view>
        <view class="panel"><view class="section-heading">管理自己的名片</view><text class="body-copy">关闭前会再次核对。关闭将移除名片及现有关系，需要重新开通后才能再使用农友功能。关闭不会撤回社区内容，请到田园圈子的“我的内容”单独撤回。</text><FarmButton class="action danger-outline" :disabled="!canUse || !!confirmation" @tap="ask('disable')">关闭我的农友名片</FarmButton></view>
      </template>
    </template>
  </FarmScreen>
</template>
