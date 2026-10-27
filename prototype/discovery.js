/* Pure page-memory product discovery. No asset changes, persistence or platform calls. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmDiscovery = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const RESOURCES = { feed: '饲料', fertilizer: '肥料', tools: '工具', seedPacks: '种子', decorations: '装扮' };
  const pointsIn = wallet => Math.max(0, wallet.points);

  function availability(item, system) {
    const remaining = Math.max(0, item.limit - (system.daily.bought[item.id] || 0));
    const inCart = system.cart[item.id] || 0;
    const canAdd = Math.max(0, Math.min(5, remaining) - inCart);
    return { remaining, inCart, canAdd, unavailable: remaining === 0 ? '今日兑完' : canAdd === 0 ? '购物车达限' : '' };
  }

  function select(catalog, system, wallet, options = {}) {
    const { category, query = '', filter = 'all', sort = 'recommended', wishlist = [] } = options;
    const text = query.trim().toLocaleLowerCase('zh-CN');
    const wishes = new Set(wishlist), points = pointsIn(wallet);
    const items = catalog.filter(item => {
      if (category && item.category !== category) return false;
      const resources = Object.entries(RESOURCES).filter(([key]) => item.grant[key] > 0).map(([, label]) => label);
      const searchable = [item.title, item.description, ...resources].join(' ').toLocaleLowerCase('zh-CN');
      if (text && !searchable.includes(text)) return false;
      if (filter === 'affordable' && item.cost > points) return false;
      if (filter === 'available' && availability(item, system).canAdd === 0) return false;
      if (filter === 'wishlist' && !wishes.has(item.id)) return false;
      return true;
    });
    if (sort === 'cost-asc') items.sort((a, b) => a.cost - b.cost);
    if (sort === 'cost-desc') items.sort((a, b) => b.cost - a.cost);
    return items;
  }

  function toggleWishlist(catalog, ids, sku) {
    const known = new Set(catalog.map(item => item.id));
    const wishes = [...new Set(ids.filter(id => known.has(id)))];
    if (!known.has(sku)) return wishes;
    return wishes.includes(sku) ? wishes.filter(id => id !== sku) : [...wishes, sku];
  }

  function goal(catalog, wallet, sku) {
    const item = catalog.find(item => item.id === sku);
    if (!item) return null;
    const points = pointsIn(wallet);
    return { item, points, shortfall: Math.max(0, item.cost - points), percent: points >= item.cost ? 100 : Math.floor(points / item.cost * 100) };
  }

  return Object.freeze({ availability, select, toggleWishlist, goal });
});
