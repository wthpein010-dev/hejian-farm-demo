<script setup lang="ts">
import { computed, getCurrentInstance, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import FarmButton from '../../components/FarmButton.vue';
import FarmTextField from '../../components/FarmTextField.vue';
import FarmDraftNotice from '../../components/FarmDraftNotice.vue';
import FarmForumActions from '../../components/FarmForumActions.vue';
import { farmState as state, loadFarmForum, commandFarmForum, forumCircles, forumReasons, forumCircleLabel, forumStateLabel, farmRecordDate, openForumPost, openFriends, returnFromFriends } from '../../core/farm';
import { useForumDraft, requestNavigation } from '../../core/forum-draft';
import type { ForumCircle, ForumReport } from '../../core/types';
import { isForumText } from '../../../../../shared/forum.mjs';
import { loadWithPageFocus } from '../../core/pagination-focus';
defineOptions({ inheritAttrs: false });
const mode = ref<'public' | 'mine' | 'reports'>('public'), circle = ref<'all' | ForumCircle>('all');
const resultId = 'forum-list-result-' + getCurrentInstance()!.uid;
const composing = ref(false), title = ref(''), body = ref(''), postCircle = ref<ForumCircle>('harvest');
const titleError = ref(''), bodyError = ref('');
const titleField = ref<InstanceType<typeof FarmTextField> | null>(null), bodyField = ref<InstanceType<typeof FarmTextField> | null>(null);
const blocked = computed(() => state.busy || state.pending || state.forumBusy);
const canSubmit = computed(() => !blocked.value && state.forumStatus?.available && state.forumStatus.canPost);
const current = computed(() => mode.value === 'reports' ? state.forumReports : state.forumPage);
const dirty = computed(() => !!title.value || !!body.value);
function clearDraft() { title.value = ''; body.value = ''; titleError.value = ''; bodyError.value = ''; composing.value = false; }
const { leaving, cancelLeave, discardLeave } = useForumDraft(dirty, clearDraft);
watch(() => state.forumSubmission, value => { if (value?.action === 'submit-post') clearDraft(); });
function refresh(cursor = 'start', event?: unknown) { return loadWithPageFocus(cursor, event, () => loadFarmForum(mode.value, circle.value, cursor), () => !!current.value?.nextCursor, resultId); }
function selectMode(value: 'public' | 'mine' | 'reports') { requestNavigation(() => { mode.value = value; void refresh(); }); }
function selectCircle(value: 'all' | ForumCircle) { requestNavigation(() => { circle.value = value; void refresh(); }); }
function closeCompose() { requestNavigation(clearDraft); }
function reportResult(item: ForumReport) { return item.status === 'open' ? '待处理' : { dismissed: '已处理：未作隐藏', hidden: '已处理：内容已隐藏', withdrawn: '作者已撤回，举报已结束' }[item.resolution || 'dismissed']; }
async function submitPost() {
  if (!canSubmit.value) return;
  const heading = title.value.trim(), text = body.value.trim();
  titleError.value = !isForumText(heading, 4, 40, false) ? '请填写4至40字标题，移除换行及不可见控制字符。' : '';
  bodyError.value = !isForumText(text, 5, 600) ? '请填写5至600字正文，可换行，请移除不可见控制字符。' : '';
  if (titleError.value) { await titleField.value?.focus(); return; }
  if (bodyError.value) { await bodyField.value?.focus(); return; }
  if (await commandFarmForum({ action: 'submit-post', circle: postCircle.value, title: heading, body: text })) { clearDraft(); mode.value = 'mine'; await refresh(); }
}
onShow(() => { if (state.authenticated && !state.busy && !state.pending) void refresh(); });
</script>
<template>
  <FarmScreen title="田园圈子">
    <FarmButton class="action secondary" @tap="requestNavigation(returnFromFriends)">返回田园主页</FarmButton>
    <view class="notice"><text>当前为开发沙盒社区。帖子和评论先审核，通过后才公开；没有私信、奖励或正式分享。请勿填写真实身份、联系方式与私密资料。</text></view>
    <FarmDraftNotice v-if="leaving" :busy="state.busy" @cancel="cancelLeave" @discard="discardLeave" />
    <view id="forum-feedback" tabindex="-1"><view v-if="state.forumBusy" class="status-line" role="status">正在读取圈子…</view><view v-if="state.forumMessage" class="success-note" role="status">{{ state.forumMessage }}</view><view v-if="state.forumError" class="notice error" role="alert">{{ state.forumError }}<text>已确认的提交不会再次发送，可刷新查看当前内容。</text></view></view>
    <FarmButton class="action secondary" :disabled="blocked" @tap="refresh()">刷新社区</FarmButton>
    <view v-if="!state.forumStatus && !state.forumBusy" class="panel empty-panel"><view class="section-heading">社区状态尚未取得</view><text class="body-copy">请刷新后再查看或提交。</text></view>
    <view v-else-if="state.forumStatus && !state.forumStatus.available" class="panel empty-panel"><view class="section-heading">社区暂未开放</view><text class="body-copy">正式服务与审核安排准备完成后，会在这里公布。当前不会创建或模拟发布内容。</text></view>
    <template v-else-if="state.forumStatus?.available">
      <view class="forum-welcome panel"><text class="home-section-kicker">开发沙盒 · 社区联调</text><view class="section-heading">{{ state.forumStatus.alias || '欢迎来看看农友的日常' }}</view><text class="body-copy">审核前的内容只有自己可见。关闭农友名片不会撤回已提交内容，需要在“我的内容”逐条撤回。</text><text class="helper">今日已提交 {{ state.forumStatus.usage.posts }} / {{ state.forumStatus.limits.posts }} 帖，{{ state.forumStatus.usage.comments }} / {{ state.forumStatus.limits.comments }} 条评论。次数与额度为联调提案。</text><FarmButton v-if="state.forumStatus.canPost && !composing" class="action" :disabled="blocked" @tap="composing = true">写一篇帖子</FarmButton><FarmButton v-if="!state.forumStatus.canPost" class="action" :disabled="blocked" @tap="requestNavigation(openFriends)">开通农友名片后参与</FarmButton></view>
      <view v-if="composing" class="panel forum-compose" role="region" aria-labelledby="forum-compose-title"><view id="forum-compose-title" class="section-heading">写一篇帖子</view><text class="body-copy">用纯文字分享；点击“提交审核”才会发送，回车和输入法候选确认不会提交。</text><view class="forum-circle-options" role="group" aria-label="发帖圈子"><FarmButton v-for="item in forumCircles.filter(item => item.id !== 'all')" :key="item.id" class="action secondary" :class="{ 'forum-reason-selected': postCircle === item.id }" :aria-pressed="postCircle === item.id" :disabled="!canSubmit" @tap="postCircle = item.id as ForumCircle">{{ item.title }}</FarmButton></view><FarmTextField id="forum-post-title" ref="titleField" v-model="title" label="帖子标题" help="4至40字，简要说明想分享的内容" :maxlength="40" :error="titleError" :disabled="!canSubmit" /><FarmTextField id="forum-post-body" ref="bodyField" v-model="body" label="帖子正文" help="5至600字，只填写可公开的内容" :maxlength="600" multiline :error="bodyError" :disabled="!canSubmit" /><FarmButton class="action" :disabled="!canSubmit || leaving" @tap="submitPost">提交审核</FarmButton><FarmButton class="action secondary" :disabled="state.busy" @tap="closeCompose">取消填写</FarmButton></view>
      <view class="tabs" role="group" aria-label="社区内容"><FarmButton :class="{ active: mode === 'public' }" :aria-pressed="mode === 'public'" :disabled="blocked" @tap="selectMode('public')">圈子动态</FarmButton><FarmButton :class="{ active: mode === 'mine' }" :aria-pressed="mode === 'mine'" :disabled="blocked" @tap="selectMode('mine')">我的内容</FarmButton><FarmButton :class="{ active: mode === 'reports' }" :aria-pressed="mode === 'reports'" :disabled="blocked" @tap="selectMode('reports')">我的举报</FarmButton></view>
      <view v-if="mode === 'public'" class="forum-circle-options" role="group" aria-label="浏览圈子"><FarmButton v-for="item in forumCircles" :key="item.id" class="action secondary" :class="{ 'forum-reason-selected': circle === item.id }" :aria-pressed="circle === item.id" :disabled="blocked" @tap="selectCircle(item.id)">{{ item.title }}</FarmButton></view>
      <view :id="resultId" class="registry-status" role="status" aria-live="polite" tabindex="-1"><text v-if="current">已显示 {{ current.items.length }} 条{{ current.nextCursor ? '，可继续加载更早记录' : '，已全部显示' }}</text></view>
      <template v-if="mode !== 'reports'"><view v-if="!state.forumPage?.items.length && !state.forumBusy" class="panel empty-panel"><view class="section-heading">{{ mode === 'mine' ? '还没有自己的内容' : '这个圈子还没有公开动态' }}</view><text class="body-copy">{{ mode === 'mine' ? '提交后的待审核、未通过、已隐藏和已撤回内容会在这里显示。' : '可以写下种养问题或收获见闻，审核通过后会在圈子中相见。' }}</text></view><view v-for="item in state.forumPage?.items || []" :key="item.id" class="panel forum-post-card"><view class="forum-post-meta"><text>{{ forumCircleLabel(item.circle) }} · {{ item.kind === 'comment' ? '评论' : '帖子' }}</text><text>{{ item.author.self ? '我' : item.author.alias }}</text></view><view class="section-heading">{{ item.title || (item.state === 'withdrawn' ? '内容已撤回' : '我发表的评论') }}</view><text class="record-status">{{ forumStateLabel(item.state) }}</text><text class="forum-body forum-excerpt" selectable>{{ item.body }}</text><text class="helper">{{ farmRecordDate(item.createdAt) }} · 北京时间</text><FarmButton v-if="item.state !== 'withdrawn'" class="action secondary" :disabled="blocked" @tap="requestNavigation(() => openForumPost(item.parentId || item.id))">{{ item.kind === 'comment' ? '查看原帖与评论' : '查看帖子' }}</FarmButton><FarmForumActions :content="item" /></view></template>
      <template v-else><view v-if="!state.forumReports?.items.length && !state.forumBusy" class="panel empty-panel"><view class="section-heading">还没有举报记录</view><text class="body-copy">举报只保存理由和处理状态，不在这里复制他人的正文。</text></view><view v-for="item in state.forumReports?.items || []" :key="item.id" class="panel"><view class="section-heading">{{ item.kind === 'post' ? '帖子' : '评论' }}举报</view><text class="record-status">{{ reportResult(item) }}</text><text class="helper">{{ farmRecordDate(item.createdAt) }} · 北京时间</text><text class="body-copy">处理中不会自动全站隐藏，处理结束也不代表已由真人查看。</text></view></template>
      <FarmButton v-if="current?.nextCursor" class="action secondary" :disabled="blocked" :loading="state.forumBusy" @tap="refresh(current.nextCursor!, $event)">加载更早记录</FarmButton>
    </template>
  </FarmScreen>
</template>
