import { nextTick, ref, watch, type ComputedRef } from 'vue';
import { onBackPress, onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { farmState } from './farm';
import { setNavigationGuard, requestNavigation } from './navigation.mjs';
export { requestNavigation };
export function useDraftGuard(dirty: ComputedRef<boolean>, clear: () => void, cancelId = 'forum-leave-cancel') {
  const leaving = ref(false); let destination: (() => void) | null = null, unregister = () => {};
  let previousFocus: HTMLElement | null = null;
  function cancelLeave() {
    leaving.value = false; destination = null;
    // #ifdef H5
    const target = previousFocus; previousFocus = null; void nextTick(() => { if (target?.isConnected) target.focus(); });
    // #endif
  }
  async function guard(action: () => void) {
    if (!dirty.value) { action(); return; }
    // #ifdef H5
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // #endif
    destination = action; leaving.value = true; await nextTick();
    // #ifdef H5
    document.getElementById(cancelId)?.focus();
    // #endif
    // #ifndef H5
    uni.pageScrollTo({ selector: '#' + cancelId, duration: 0 });
    // #endif
  }
  function discardLeave() { const action = destination; clear(); cancelLeave(); action?.(); }
  // The native App tab bar cannot be cancelled before a tab switch. While a
  // draft exists its exit is the guarded page back action, so it cannot be lost.
  // #ifdef APP-PLUS
  watch(dirty, value => { if (value) uni.hideTabBar({ animation: false }); else uni.showTabBar({ animation: false }); });
  // #endif
  watch(() => [farmState.authenticated, farmState.snapshot?.profile.id], () => { clear(); cancelLeave(); });
  onShow(() => { unregister(); unregister = setNavigationGuard(guard); });
  onHide(() => { unregister(); cancelLeave(); });
  onUnload(() => { unregister(); clear(); cancelLeave();
    // #ifdef APP-PLUS
    uni.showTabBar({ animation: false });
    // #endif
  });
  onBackPress(() => { if (!dirty.value) return false; void guard(() => uni.navigateBack({ delta: 1 })); return true; });
  return { leaving, cancelLeave, discardLeave };
}
export function useForumDraft(dirty: ComputedRef<boolean>, clear: () => void) { return useDraftGuard(dirty, clear); }
