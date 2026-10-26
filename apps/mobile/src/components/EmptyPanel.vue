<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>
<template><view class="panel empty-panel"><view class="empty-mark">禾</view><view class="section-heading">{{ title }}</view><text class="body-copy">{{ description }}</text><slot /></view></template>
