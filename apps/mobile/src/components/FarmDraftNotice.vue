<script setup lang="ts">
import FarmButton from './FarmButton.vue';
withDefaults(defineProps<{ busy?: boolean; idPrefix?: string; description?: string }>(), { idPrefix: 'forum', description: '离开后会清除本页输入，尚未提交的内容不会进入社区。' });
defineEmits<{ cancel: []; discard: [] }>();
</script>
<template><view class="panel confirm-panel" role="region" :aria-labelledby="idPrefix + '-leave-title'"><view :id="idPrefix + '-leave-title'" class="section-heading">要放弃未提交的草稿吗？</view><text class="body-copy">{{ description }}</text><FarmButton :id="idPrefix + '-leave-cancel'" class="action secondary" :disabled="busy" @tap="$emit('cancel')">返回，继续填写</FarmButton><FarmButton class="action danger" :disabled="busy" @tap="$emit('discard')">放弃草稿并离开</FarmButton></view></template>
