import { nextTick } from 'vue';
// When keyboard activation removes the final Load more button, keep the user
// at the result. Pointer use, failed reads and deliberate focus moves retain it.
export async function loadWithPageFocus(cursor: string, event: unknown, load: () => Promise<boolean>, hasMore: () => boolean, resultId: string) {
  // #ifdef H5
  const activation = event as MouseEvent | undefined, trigger = activation?.currentTarget;
  const keyboardTrigger = cursor !== 'start' && activation?.detail === 0 && trigger instanceof HTMLElement && document.activeElement === trigger ? trigger : null;
  // #endif
  const loaded = await load();
  // #ifdef H5
  if (keyboardTrigger && loaded && !hasMore()) {
    await nextTick();
    if (!keyboardTrigger.isConnected && (document.activeElement === document.body || document.activeElement === keyboardTrigger)) {
      const result = document.getElementById(resultId); result?.focus({ preventScroll: true }); result?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }
  // #endif
  return loaded;
}
