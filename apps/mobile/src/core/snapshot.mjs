// Validate every structure consumed by the shared pages. Missing data is never
// converted into a zero balance, an empty farm, or a successful transaction.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const flags = (value, names) => object(value) && names.every(name => typeof value[name] === 'boolean');
const records = (value, item) => Array.isArray(value) && value.every(item);
const quantities = value => object(value) && Object.entries(value).every(([name, qty]) => id(name) && count(qty));
const reward = value => object(value) && ['points', 'feed', 'fertilizer', 'tools'].every(key => value[key] === undefined || count(value[key])) && (value.coupon === undefined || object(value.coupon));
const task = value => object(value) && id(value.id) && text(value.title) && text(value.description) && count(value.target) && value.target > 0 && count(value.progress) && value.progress <= value.target && flags(value, ['claimed', 'ready']) && !(value.claimed && value.ready) && reward(value.reward);
const product = value => object(value) && id(value.id) && text(value.title) && text(value.description) && ['supplies', 'gifts'].includes(value.category) && count(value.cost) && count(value.limit) && value.limit > 0 && text(value.art);
const coupon = value => object(value) && id(value.id) && text(value.title) && count(value.min) && count(value.off) && value.off > 0 && value.off <= value.min && typeof value.used === 'boolean';
const purchase = value => object(value) && id(value.id) && typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.day) && count(value.count) && count(value.total);
const farmItem = value => object(value) && id(value.id) && text(value.name) && text(value.status);

export function isFarmSnapshot(s, ownerId) {
  if (!object(s) || !count(s.serverTime) || !count(s.revision) || !['development', 'production'].includes(s.environment)) return false;
  if (!object(s.profile) || s.profile.id !== ownerId || !id(s.profile.id) || !text(s.profile.displayName)) return false;
  if (!object(s.wallet) || !count(s.wallet.points) || !count(s.wallet.feed)) return false;
  if (!records(s.catalog, product) || new Set(s.catalog.map(p => p.id)).size !== s.catalog.length) return false;
  const system = s.system;
  if (!object(system) || !quantities(system.cart) || !object(system.daily) || !quantities(system.daily.bought)) return false;
  if (!object(system.inventory) || !['fertilizer', 'tools', 'seedPacks', 'decorations', 'eggs', 'crops', 'meat'].every(key => count(system.inventory[key]))) return false;
  if (!records(system.coupons, coupon) || !records(system.purchases, purchase)) return false;
  let subtotal = 0;
  for (const [sku, qty] of Object.entries(system.cart)) {
    const p = s.catalog.find(item => item.id === sku);
    if (!p || qty < 1 || qty > 5 || !count(p.cost * qty)) return false;
    subtotal += p.cost * qty; if (!count(subtotal)) return false;
  }
  if (!records(s.tasks, task) || !records(s.achievements, task)) return false;
  const sign = s.signIn;
  if (!object(sign) || !flags(sign, ['todayClaimed']) || !count(sign.streak) || !count(sign.nextIndex) || sign.nextIndex > 6) return false;
  if (!Array.isArray(sign.rewards) || sign.rewards.length !== 7 || !sign.rewards.every((r, i) => object(r) && r.day === i + 1 && text(r.label))) return false;
  const season = s.season;
  if (!object(season) || !count(season.total) || season.total < 1 || !count(season.count) || season.count > season.total || !flags(season, ['ready', 'claimed']) || (season.ready && season.claimed)) return false;
  const level = s.level;
  if (!object(level) || !count(level.level) || level.level < 1 || !text(level.label) || !count(level.xp) || !count(level.progress) || level.progress > 100 || !(level.next === null || count(level.next))) return false;
  if (!object(s.farm) || !records(s.farm.plots, farmItem) || !records(s.farm.animals, farmItem)) return false;
  return flags(s.capabilities, ['pointShop', 'activities', 'care', 'adoption', 'live', 'shipping', 'payments', 'advertising']);
}
