<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, watch } from 'vue';
import { onHide } from '@dcloudio/uni-app';
import { farmState as state, commandFarmForum, forumReasons, openFriends } from '../core/farm';
import type { ForumContent, ForumReason } from '../core/types';
import FarmButton from './FarmButton.vue';
import { requestNavigation } from '../core/navigation.mjs';
const props = defineProps<{ content: ForumContent }>();
const controlId = 'forum-action-' + getCurrentInstance()!.uid;
const choice = ref<'withdraw' | 'block-author' | 'report' | null>(null), reason = ref<ForumReason>('spam');
const blocked = computed(() => state.busy || state.pending || !state.forumStatus?.available);
const canParticipate = computed(() => !blocked.value && state.forumStatus?.canPost);
const target = ref<ForumContent | null>(null);
let previousFocus: HTMLElement | null = null;
function reset() { choice.value = null; target.value = null; previousFocus = null; }
watch(() => [state.authenticated, state.snapshot?.profile.id], reset);
onHide(reset);
async function cancel() { const trigger = previousFocus; reset(); await nextTick();
  // #ifdef H5
  if (trigger?.isConnected) trigger.focus();
  // #endif
}
async function ask(action: 'withdraw' | 'block-author' | 'report') {
  if (blocked.value || (action !== 'withdraw' && !canParticipate.value)) return;
  // #ifdef H5
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // #endif
  target.value = props.content; choice.value = action; await nextTick();
  // #ifdef H5
  document.getElementById(controlId + '-cancel')?.focus();
  // #endif
  // #ifndef H5
  uni.pageScrollTo({ selector: '#' + controlId + '-cancel', duration: 0 });
  // #endif
}
async function confirm() {
  if (!choice.value || !target.value || blocked.value) return;
  const content = target.value, action = choice.value;
  if (content.version !== props.content.version || content.id !== props.content.id) { choice.value = null; return; }
  const command = action === 'report' ? { action, contentId: content.id, expectedVersion: content.version, reason: reason.value } : { action, contentId: content.id, expectedVersion: content.version };
  if (await commandFarmForum(command)) choice.value = null;
}
</script>
<template>
  <view v-if="content.state !== 'withdrawn'" class="forum-content-actions">
    <FarmButton v-if="content.author.self" class="action danger-outline" :disabled="blocked" @tap="ask('withdraw')">撤回这条{{ content.kind === 'post' ? '帖子' : '评论' }}</FarmButton>
    <template v-else><FarmButton class="action secondary" :disabled="!canParticipate" @tap="ask('report')">举报这条内容</FarmButton><FarmButton class="action danger-outline" :disabled="!canParticipate" @tap="ask('block-author')">屏蔽这位作者</FarmButton></template>
    <FarmButton v-if="!content.author.self && state.forumStatus?.available && !state.forumStatus.canPost" class="text-action" @tap="requestNavigation(openFriends)">开通农友名片后参与</FarmButton>
    <view v-if="choice" class="panel deletion-confirm" role="region" :aria-labelledby="controlId + '-title'">
      <view :id="controlId + '-title'" class="section-heading">{{ choice === 'withdraw' ? '撤回自己的内容' : choice === 'report' ? '举报这条内容' : '屏蔽这位作者' }}</view>
      <text class="body-copy">{{ choice === 'withdraw' ? '撤回后清除正文；撤回帖子还会撤回其下全部评论，无法恢复。' : choice === 'report' ? '只提交所选理由，不会立即下架内容。处理进展可在我的举报查看。' : '将隐藏双方的社区内容，并移除已有农友关系和申请。可在我的农友解除，原关系不会恢复。' }}</text>
      <view v-if="choice === 'report'" class="forum-reasons" role="group" aria-label="举报理由"><FarmButton v-for="item in forumReasons" :key="item.id" class="action secondary" :class="{ 'forum-reason-selected': reason === item.id }" :aria-pressed="reason === item.id" :disabled="blocked" @tap="reason = item.id">{{ item.title }}</FarmButton></view>
      <FarmButton :id="controlId + '-cancel'" class="action secondary" :disabled="state.busy" @tap="cancel">返回，暂不操作</FarmButton>
      <FarmButton class="action danger" :disabled="blocked || (choice !== 'withdraw' && !canParticipate)" @tap="confirm">{{ choice === 'withdraw' ? '确认撤回内容' : choice === 'report' ? '提交举报' : '确认屏蔽作者' }}</FarmButton>
    </view>
  </view>
</template>
