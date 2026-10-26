export function mobileSnapshot(data = {}) {
  return {
    serverTime: 1793044800000, revision: 3, environment: 'development',
    profile: { id: 'member-a', displayName: '田园新友', ...data.profile },
    wallet: { points: 80, feed: 6, ...data.wallet },
    system: { cart: {}, coupons: [], inventory: { fertilizer: 2, tools: 1, seedPacks: 0, decorations: 0, eggs: 0, crops: 0, meat: 0 }, daily: { bought: {} }, purchases: [] },
    catalog: [], tasks: [], achievements: [],
    signIn: { todayClaimed: false, streak: 0, nextIndex: 0, rewards: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, label: '20积分' })) },
    season: { count: 0, total: 3, ready: false, claimed: false },
    level: { level: 3, label: '勤耕生活家', xp: 120, progress: 0, next: 220 },
    farm: { plots: [], animals: [] },
    capabilities: { pointShop: true, activities: true, care: false, adoption: false, live: false, shipping: false, payments: false, advertising: false },
    ...Object.fromEntries(Object.entries(data).filter(([name]) => !['wallet', 'profile'].includes(name)))
  };
}
