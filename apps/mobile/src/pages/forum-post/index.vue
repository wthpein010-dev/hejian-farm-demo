<script setup lang="ts">
import { computed, getCurrentInstance, ref, watch } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import FarmTextField from '../../components/FarmTextField.vue';
import FarmDraftNotice from '../../components/FarmDraftNotice.vue';
import FarmForumActions from '../../components/FarmForumActions.vue';
import { farmState as state, loadFarmForumPost, commandFarmForum, forumCircleLabel, forumStateLabel, farmRecordDate, returnFromForumPost, openFriends } from '../../core/farm';
import { useForumDraft, requestNavigation } from '../../core/forum-draft';
import { isForumText } from '../../../../../shared/forum.mjs';
import { loadWithPageFocus } from '../../core/pagination-focus';
defineOptions({ inheritAttrs: false });
const id = ref(''), draft = ref(''), inputError = ref(''), bodyField = ref<InstanceType<typeof FarmTextField> | null>(null);
const resultId = 'forum-comments-result-' + getCurrentInstance()!.uid;
const detail = computed(() => state.forumDetail?.post.id === id.value ? state.forumDetail : null);
const blocked = computed(() => state.busy || state.pending || state.forumDetailBusy);
const canComment = computed(() => !blocked.value && state.forumStatus?.canPost && detail.value?.post.state === 'published');
const { leaving, cancelLeave, discardLeave } = useForumDraft(computed(() => !!draft.value), () => { draft.value = ''; inputError.value = ''; });
watch(() => state.forumSubmission, value => { if (value?.action === 'submit-comment') { draft.value = ''; inputError.value = ''; } });
function refresh(cursor = 'start', event?: unknown) { return loadWithPageFocus(cursor, event, async () => id.value ? loadFarmForumPost(id.value, cursor) : false, () => !!detail.value?.nextCursor, resultId); }
async function submitComment() {
  if (!canComment.value || !detail.value) return;
  const body = draft.value.trim();
  inputError.value = !isForumText(body, 1, 240) ? '请填写1至240字评论，可换行，请移除不可见控制字符。' : '';
  if (inputError.value) { await bodyField.value?.focus(); return; }
  if (await commandFarmForum({ action: 'submit-comment', postId: id.value, expectedVersion: detail.value.post.version, body })) { draft.value = ''; inputError.value = ''; }
}
onLoad(options => { const value = options?.id; id.value = typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''; });
onShow(() => { if (id.value && state.authenticated && !state.busy && !state.pending) void refresh(); });
</script>
<template>
  <FarmScreen title="圈子帖子" subtitle="读一段田园日常，留一句交流。">
    <FarmButton class="action secondary" @tap="requestNavigation(returnFromForumPost)">返回田园圈子</FarmButton>
    <FarmDraftNotice v-if="leaving" :busy="state.busy" @cancel="cancelLeave" @discard="discardLeave" />
    <view v-if="state.forumDetailBusy" class="status-line" role="status">正在读取帖子与评论…</view><view v-if="state.forumMessage" class="success-note" role="status">{{ state.forumMessage }}</view><view v-if="state.forumDetailError" class="notice error" role="alert">{{ state.forumDetailError }}</view>
    <FarmButton v-if="id" class="action secondary" :disabled="blocked" @tap="refresh()">刷新帖子</FarmButton>
    <view v-if="!id" class="panel empty-panel"><view class="section-heading">帖子地址无效</view><text class="body-copy">请返回圈子，重新选择一篇帖子。</text></view>
    <view v-else-if="state.forumStatus && !state.forumStatus.available" class="panel empty-panel"><view class="section-heading">社区暂未开放</view><text class="body-copy">正式服务和审核准备完成后再开放。</text></view>
    <template v-else-if="detail"><view class="panel forum-full-post"><text class="home-section-kicker">{{ forumCircleLabel(detail.post.circle) }}</text><view class="section-heading">{{ detail.post.title || '帖子已撤回' }}</view><text class="helper">{{ detail.post.author.self ? '我' : detail.post.author.alias }} · {{ farmRecordDate(detail.post.createdAt) }} · 北京时间</text><text class="record-status">{{ forumStateLabel(detail.post.state) }}</text><text class="forum-body" selectable>{{ detail.post.body }}</text><FarmForumActions :content="detail.post" /></view>
      <view v-if="detail.post.state !== 'withdrawn'" class="panel"><view class="section-heading">写下评论</view><text class="body-copy">评论通过审核后才会公开。按回车或确认输入法候选不会发送。</text><template v-if="state.forumStatus?.canPost && detail.post.state === 'published'"><FarmTextField id="forum-comment-body" ref="bodyField" v-model="draft" label="评论内容" help="1至240字，请勿填写联系方式或隐私" :maxlength="240" multiline :error="inputError" :disabled="!canComment" /><FarmButton class="action" :disabled="!canComment || leaving" @tap="submitComment">提交评论审核</FarmButton></template><FarmButton v-else-if="!state.forumStatus?.canPost" class="action secondary" :disabled="blocked" @tap="requestNavigation(openFriends)">开通农友名片后评论</FarmButton><text v-else class="helper">帖子公开后才可评论。</text></view>
      <view class="section-heading">评论</view><view :id="resultId" class="registry-status" role="status" aria-live="polite" tabindex="-1"><text>已显示 {{ detail.comments.length }} 条{{ detail.nextCursor ? '，可继续加载更早评论' : '，已全部显示' }}</text></view><view v-if="!detail.comments.length" class="panel empty-panel"><text class="body-copy">暂时没有可见评论。自己的待审核评论也会在这里显示。</text></view><view v-for="item in detail.comments" :key="item.id" class="panel forum-comment"><view class="friends-alias">{{ item.author.self ? '我' : item.author.alias }}</view><text class="record-status">{{ forumStateLabel(item.state) }}</text><text class="forum-body" selectable>{{ item.body }}</text><text class="helper">{{ farmRecordDate(item.createdAt) }} · 北京时间</text><FarmForumActions :content="item" /></view><FarmButton v-if="detail.nextCursor" class="action secondary" :disabled="blocked" :loading="state.forumDetailBusy" @tap="refresh(detail.nextCursor!, $event)">加载更早评论</FarmButton>
    </template>
    <view v-else-if="!state.forumDetailBusy && id" class="panel empty-panel"><view class="section-heading">当前无法查看这篇帖子</view><text class="body-copy">内容可能已变化，返回圈子或刷新再查看。</text></view>
  </FarmScreen>
</template>
