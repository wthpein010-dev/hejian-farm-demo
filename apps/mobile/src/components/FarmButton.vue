<script setup lang="ts">
import { nextTick, useAttrs, watch, type StyleValue } from 'vue';
defineOptions({ inheritAttrs: false, options: { virtualHost: true, styleIsolation: 'shared' } });
const props = withDefaults(defineProps<{ disabled?: boolean; loading?: boolean }>(), { disabled: false, loading: false });
const emit = defineEmits<{ tap: [event: unknown] }>();
const attrs = useAttrs();
const nativeClass = () => attrs.class as string | undefined;
const nativeStyle = () => attrs.style as StyleValue;
const attr = (name: string) => attrs[name] === undefined ? undefined : String(attrs[name]);
const pressed = () => attr('aria-pressed') === 'true' ? 'true' : attr('aria-pressed') === 'false' ? 'false' : attr('aria-pressed') === 'mixed' ? 'mixed' : undefined;
const current = () => attr('aria-current') === 'page' ? 'page' : undefined;
let focusTarget: HTMLElement | null = null, restoreFocus = false;
function activate(event: unknown) {
  if (props.disabled || props.loading) return;
  // #ifdef H5
  const target = (event as Event).currentTarget;
  focusTarget = target instanceof HTMLElement && document.activeElement === target ? target : null;
  // #endif
  emit('tap', event);
}
watch(() => props.disabled || props.loading, async blocked => {
  // #ifdef H5
  if (blocked) { restoreFocus = !!focusTarget && document.activeElement === focusTarget; return; }
  if (!restoreFocus) return;
  restoreFocus = false; await nextTick();
  if (focusTarget?.isConnected && (document.activeElement === document.body || document.activeElement === focusTarget)) focusTarget.focus({ preventScroll: true });
  // #endif
});
</script>
<template>
  <!-- #ifdef H5 -->
  <component :is="'button'" v-bind="$attrs" class="farm-button" type="button" role="button" :aria-disabled="disabled || loading" :aria-busy="loading" :disabled="disabled || loading" @click="activate"><slot /></component>
  <!-- #endif -->
  <!-- #ifndef H5 -->
  <button :id="attr('id')" :class="['farm-button', nativeClass()]" :style="nativeStyle()" role="button" :aria-label="attr('aria-label')" :aria-labelledby="attr('aria-labelledby')" :aria-describedby="attr('aria-describedby')" :aria-pressed="pressed()" :aria-current="current()" :aria-disabled="disabled || loading" :aria-busy="loading" :disabled="disabled || loading" :loading="loading" @tap="activate"><slot /></button>
  <!-- #endif -->
</template>
