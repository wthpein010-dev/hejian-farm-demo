<script setup lang="ts">
import { computed, ref, watch } from 'vue';
defineOptions({ options: { virtualHost: true, styleIsolation: 'shared' } });
const props = defineProps<{ art: string; title: string }>();
const knownArt = new Set(['feed', 'fertilizer', 'tools', 'seed', 'sign', 'frame', 'bundle', 'gift']);
const source = computed(() => `/static/photos/${knownArt.has(props.art) ? props.art : 'gift'}.webp`);
const failed = ref(false);
watch(source, () => { failed.value = false; });
</script>
<template>
  <view class="goods-photo-frame">
    <image v-if="!failed" class="goods-photo" :src="source" mode="aspectFill" :aria-label="title" @error="failed = true" />
    <view v-else class="goods-photo-unavailable" role="img" :aria-label="`${title}的图片暂不可用`"><text>图片暂不可用</text></view>
  </view>
</template>
