<script setup lang="ts">
import FarmButton from './FarmButton.vue';
defineProps<{ busy?: boolean }>();
defineEmits<{ cancel: []; discard: [] }>();
</script>
<template><view class="panel confirm-panel" role="region" aria-labelledby="forum-leave-title"><view id="forum-leave-title" class="section-heading">要放弃未提交的草稿吗？</view><text class="body-copy">离开后会清除本页输入，尚未提交的内容不会进入社区。</text><FarmButton id="forum-leave-cancel" class="action secondary" :disabled="busy" @tap="$emit('cancel')">返回，继续填写</FarmButton><FarmButton class="action danger" :disabled="busy" @tap="$emit('discard')">放弃草稿并离开</FarmButton></view></template>
