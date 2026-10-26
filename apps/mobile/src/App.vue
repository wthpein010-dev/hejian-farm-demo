<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app';
import { farmState, refreshFarm } from './core/farm';
onShow(() => { if (farmState.authenticated && !farmState.busy) void refreshFarm(); });
</script>
<style src="@/styles/app.css"></style>
