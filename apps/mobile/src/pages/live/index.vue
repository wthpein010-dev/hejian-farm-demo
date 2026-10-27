<script setup lang="ts">
import FarmButton from '../../components/FarmButton.vue';
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import FarmScreen from '../../components/FarmScreen.vue';
import EmptyPanel from '../../components/EmptyPanel.vue';
import { onFarmPageShow } from '../../core/farm';
const camera = ref<'field' | 'livestock' | 'pig'>('field');
onShow(onFarmPageShow);
</script>
<template>
  <FarmScreen title="农场实景">
    <view class="tabs" role="group" aria-label="镜头分类"><FarmButton :class="{ active: camera === 'field' }" :aria-pressed="camera === 'field'" @tap="camera = 'field'">菜园</FarmButton><FarmButton :class="{ active: camera === 'livestock' }" :aria-pressed="camera === 'livestock'" @tap="camera = 'livestock'">圈舍</FarmButton><FarmButton :class="{ active: camera === 'pig' }" :aria-pressed="camera === 'pig'" @tap="camera = 'pig'">猪的视角</FarmButton></view>
    <image class="hero-image" :src="camera === 'pig' ? '/static/photos/pig-pov.webp' : camera === 'livestock' ? '/static/photos/livestock.webp' : '/static/photos/farm-estate.webp'" mode="aspectFill" :aria-label="`${camera === 'pig' ? '猪的视角' : camera === 'livestock' ? '圈舍' : '菜园'}静态画面`" />
    <EmptyPanel title="实景服务暂未接入" description="摄像头接入并核定观看权限后，在这里查看对应地块和圈舍。当前画面仅用于了解镜头方向，不是农场直播。" />
  </FarmScreen>
</template>
