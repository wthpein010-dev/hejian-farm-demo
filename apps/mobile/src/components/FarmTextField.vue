<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref } from 'vue';
defineOptions({ inheritAttrs: false, options: { virtualHost: true, styleIsolation: 'shared' } });
const props = withDefaults(defineProps<{ id: string; label: string; modelValue: string; help: string; placeholder?: string; error?: string; maxlength: number; multiline?: boolean; disabled?: boolean; inputMode?: 'text' | 'numeric' }>(), { placeholder: '', error: '', multiline: false, disabled: false, inputMode: 'text' });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
// Cached uni pages may contain the same logical field. Native document ids
// remain stable for this instance and cannot focus a hidden sibling page.
const actualId = `${props.id}-field-${getCurrentInstance()!.uid}`;
const focused = ref(false);
const characterCount = computed(() => [...props.modelValue].length);
const describedBy = computed(() => `${actualId}-help${props.error ? ` ${actualId}-error` : ''}`);
const inputHint = computed(() => props.placeholder || `请输入${props.label}`);
function update(event: Event | { detail: { value: string } }) {
  if (props.disabled) return;
  const value = 'detail' in event && event.detail && typeof event.detail === 'object' ? event.detail.value : ('target' in event ? (event.target as HTMLInputElement).value : '');
  emit('update:modelValue', value);
}
async function focus() {
  await nextTick();
  // #ifdef H5
  const target = document.getElementById(actualId); target?.scrollIntoView({ block: 'center', behavior: 'auto' }); target?.focus({ preventScroll: true });
  // #endif
  // #ifndef H5
  focused.value = false; await nextTick(); focused.value = true; uni.pageScrollTo({ selector: '#' + actualId, duration: 0 });
  // #endif
}
defineExpose({ focus });
</script>
<template>
  <view class="farm-text-field">
    <!-- #ifdef H5 -->
    <component :is="'label'" class="form-label" :for="actualId">{{ label }}</component>
    <component :is="multiline ? 'textarea' : 'input'" :id="actualId" :data-field-key="id" :value="modelValue" :placeholder="inputHint" :class="['text-input', { 'forum-textarea': multiline }]" :style="multiline ? { resize: 'none' } : undefined" type="text" :inputmode="inputMode" :maxlength="maxlength * 2" :disabled="disabled" :aria-invalid="!!error" :aria-describedby="describedBy" autocomplete="off" :spellcheck="false" @input="update" />
    <!-- #endif -->
    <!-- #ifndef H5 -->
    <label class="form-label" :for="actualId">{{ label }}</label>
    <textarea v-if="multiline" :id="actualId" :value="modelValue" :placeholder="inputHint" placeholder-style="color: var(--secondary); opacity: 1;" placeholder-class="input-placeholder" class="text-input forum-textarea" style="resize: none" :maxlength="maxlength * 2" :disabled="disabled" :focus="focused" :aria-invalid="!!error" :aria-describedby="describedBy" confirm-type="done" @input="update" @blur="focused = false" />
    <input v-else :id="actualId" :value="modelValue" :placeholder="inputHint" placeholder-style="color: var(--secondary); opacity: 1;" placeholder-class="input-placeholder" class="text-input" :type="inputMode === 'numeric' ? 'number' : 'text'" :maxlength="maxlength * 2" :disabled="disabled" :focus="focused" :aria-invalid="!!error" :aria-describedby="describedBy" confirm-type="done" @input="update" @blur="focused = false" />
    <!-- #endif -->
    <text :id="actualId + '-help'" class="helper">{{ help }} · {{ characterCount }} / {{ maxlength }}</text>
    <text v-if="error" :id="actualId + '-error'" class="field-error" role="alert">{{ error }}</text>
  </view>
</template>
