// One app-owned guard protects transient forms from all in-app navigation.
let guard = null;
export function setNavigationGuard(value) { guard = value; return () => { if (guard === value) guard = null; }; }
export function requestNavigation(action) { if (guard) guard(action); else action(); }
