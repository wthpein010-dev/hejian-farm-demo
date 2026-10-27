// Platform-neutral text forum contract; no financial or platform identity data.
export const FORUM_CIRCLES = Object.freeze(['harvest', 'questions', 'chat']);
export const FORUM_REASONS = Object.freeze(['spam', 'abuse', 'privacy', 'misinformation', 'other']);
export const FORUM_REFUSAL_CODES = Object.freeze(['FORUM_UNAVAILABLE', 'FRIENDS_DISABLED', 'CONTENT_UNAVAILABLE', 'CONTENT_CHANGED',
  'OWN_CONTENT_REQUIRED', 'SELF_REPORT', 'ALREADY_REPORTED', 'DAILY_POST_LIMIT', 'DAILY_COMMENT_LIMIT', 'DAILY_REPORT_LIMIT',
  'ACTIVE_LIMIT', 'BLOCK_LIMIT', 'IDEMPOTENCY_CONFLICT']);
export const FORUM_ACTIONS = Object.freeze(['submit-post', 'submit-comment', 'withdraw', 'report', 'block-author']);
export const FORUM_LIMITS = Object.freeze({ posts: 10, comments: 50, reports: 20, active: 200 });
export const FORUM_PAGE_SIZE = 20;
export const FORUM_MODERATION_STATES = Object.freeze(['pending', 'published', 'hidden', 'rejected']);
export const isForumId = v => typeof v === 'string' && /^[a-f0-9]{32}(?![\s\S])/u.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const time = v => integer(v) && v <= 8.64e15;
const key = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}(?![\s\S])/u.test(v);
const owner = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?![\s\S])/u.test(v);
const mode = v => ['development', 'production'].includes(v);
const alias = v => typeof v === 'string' && /^农友[a-f0-9]{8}(?![\s\S])/u.test(v);
function fields(v, keys) {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const own = Reflect.ownKeys(v);
  return own.length === keys.length && keys.every(k => { const d = Object.getOwnPropertyDescriptor(v, k); return d?.enumerable && Object.hasOwn(d, 'value'); });
}
function list(v, test, max = 20) {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > max || Reflect.ownKeys(v).length !== v.length + 1) return false;
  const ids = new Set();
  for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value') || !test(d.value) || ids.has(d.value.id)) return false; ids.add(d.value.id); }
  return true;
}
export function isForumText(v, min, max, multiline = true) {
  if (typeof v !== 'string' || v !== v.trim() || /[\u0000-\u0009\u000b-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v) || (!multiline && v.includes('\n'))) return false;
  const chars = [...v];
  return chars.length >= min && chars.length <= max && !chars.some(c => c.length === 1 && /[\ud800-\udfff]/u.test(c));
}
function scope(v, id, env) { return v.forumFormat === 1 && owner(v.ownerId) && v.ownerId === id && mode(v.environment) && v.environment === env && time(v.serverTime); }
const scopeKeys = ['forumFormat', 'ownerId', 'environment', 'serverTime'];
function safe(check) { try { return !!check(); } catch { return false; } }
export function isForumCommand(v) { return safe(() => {
  const d = v && Object.getOwnPropertyDescriptor(v, 'action'); if (!d || !Object.hasOwn(d, 'value')) return false;
  if (d.value === 'submit-post') return fields(v, ['action', 'circle', 'title', 'body']) && FORUM_CIRCLES.includes(v.circle) && isForumText(v.title, 4, 40, false) && isForumText(v.body, 5, 600);
  if (d.value === 'submit-comment') return fields(v, ['action', 'postId', 'expectedVersion', 'body']) && isForumId(v.postId) && integer(v.expectedVersion) && v.expectedVersion > 0 && isForumText(v.body, 1, 240);
  return ['withdraw', 'report', 'block-author'].includes(d.value) && fields(v, ['action', 'contentId', 'expectedVersion', ...(d.value === 'report' ? ['reason'] : [])]) &&
    isForumId(v.contentId) && integer(v.expectedVersion) && v.expectedVersion > 0 && (d.value !== 'report' || FORUM_REASONS.includes(v.reason));
}); }
export function isForumContent(v) { return safe(() => {
  if (!fields(v, ['id', 'kind', 'parentId', 'circle', 'author', 'title', 'body', 'state', 'version', 'createdAt', 'updatedAt', 'publishedAt', 'reasonCode']) ||
    !isForumId(v.id) || !['post', 'comment'].includes(v.kind) || !FORUM_CIRCLES.includes(v.circle) || !fields(v.author, ['peerId', 'alias', 'self']) ||
    !isForumId(v.author.peerId) || v.author.alias !== '农友' + v.author.peerId.slice(0, 8) || typeof v.author.self !== 'boolean' ||
    !['pending', 'published', 'rejected', 'hidden', 'withdrawn'].includes(v.state) || !integer(v.version) || v.version < 1 ||
    !time(v.createdAt) || !time(v.updatedAt) || v.updatedAt < v.createdAt ||
    !(v.publishedAt === null || time(v.publishedAt) && v.publishedAt >= v.createdAt && v.publishedAt <= v.updatedAt) ||
    !(v.reasonCode === null || FORUM_REASONS.includes(v.reasonCode))) return false;
  if (v.kind === 'post' ? v.parentId !== null : !isForumId(v.parentId) || v.parentId === v.id || v.title !== '') return false;
  if (v.state === 'pending' && v.version !== 1 || v.state === 'rejected' && v.version !== 2 || v.state === 'published' && v.version < 2 || v.state === 'hidden' && v.version < 3 || v.state === 'withdrawn' && v.version < 2) return false;
  if (v.state === 'withdrawn') return v.title === '' && v.body === '' && v.reasonCode === null;
  if (v.kind === 'post' ? !isForumText(v.title, 4, 40, false) || !isForumText(v.body, 5, 600) : !isForumText(v.body, 1, 240)) return false;
  return ['published', 'hidden'].includes(v.state) ? v.publishedAt !== null && (v.state === 'hidden' ? v.reasonCode !== null : v.reasonCode === null)
    : v.publishedAt === null && (v.state === 'rejected' ? v.reasonCode !== null : v.reasonCode === null);
}); }
function ordered(items) { return items.every((v, i) => !i || items[i - 1].createdAt > v.createdAt || items[i - 1].createdAt === v.createdAt && items[i - 1].id > v.id); }
function pagination(v) { return (v.nextCursor === null || isForumId(v.nextCursor) && v.items.length === 20 && v.nextCursor === v.items.at(-1).id) && ordered(v.items); }
export function isForumStatus(v, id, env) { return safe(() => fields(v, [...scopeKeys, 'available', 'canPost', 'alias', 'limits', 'usage']) && scope(v, id, env) &&
  typeof v.available === 'boolean' && typeof v.canPost === 'boolean' && (!v.canPost || v.available) && (env !== 'production' || !v.available) &&
  (v.canPost ? alias(v.alias) : v.alias === null) && fields(v.limits, Object.keys(FORUM_LIMITS)) && Object.keys(FORUM_LIMITS).every(k => v.limits[k] === FORUM_LIMITS[k]) &&
  fields(v.usage, ['posts', 'comments', 'reports']) && ['posts', 'comments', 'reports'].every(k => integer(v.usage[k]) && v.usage[k] <= FORUM_LIMITS[k]) &&
  (v.available || Object.values(v.usage).every(x => x === 0))); }
export function isForumPage(v, id, env, expectedScope, circle) { return safe(() => fields(v, [...scopeKeys, 'scope', 'circle', 'items', 'nextCursor']) && scope(v, id, env) &&
  ['public', 'mine'].includes(v.scope) && (expectedScope === undefined || v.scope === expectedScope) && ['all', ...FORUM_CIRCLES].includes(v.circle) && (circle === undefined || v.circle === circle) &&
  (v.scope !== 'mine' || v.circle === 'all') && list(v.items, c => isForumContent(c) && c.updatedAt <= v.serverTime &&
    (v.scope === 'mine' ? c.author.self : c.kind === 'post' && c.state === 'published' && (v.circle === 'all' || c.circle === v.circle))) && pagination(v) && (env !== 'production' || v.items.length === 0)); }
export function isForumDetail(v, id, env, postId) { return safe(() => fields(v, [...scopeKeys, 'post', 'comments', 'nextCursor']) && scope(v, id, env) && env === 'development' &&
  isForumContent(v.post) && v.post.kind === 'post' && (postId === undefined || v.post.id === postId) && v.post.updatedAt <= v.serverTime && (v.post.author.self || v.post.state === 'published') &&
  list(v.comments, c => isForumContent(c) && c.kind === 'comment' && c.parentId === v.post.id && c.circle === v.post.circle && c.updatedAt <= v.serverTime && c.state !== 'withdrawn' && (c.state === 'published' || c.author.self)) &&
  (v.post.state !== 'withdrawn' || v.comments.length === 0) && pagination({ items: v.comments, nextCursor: v.nextCursor })); }
export function isForumReport(v) { return safe(() => fields(v, ['id', 'contentId', 'kind', 'reason', 'status', 'resolution', 'version', 'createdAt', 'resolvedAt']) &&
  isForumId(v.id) && isForumId(v.contentId) && ['post', 'comment'].includes(v.kind) && FORUM_REASONS.includes(v.reason) && integer(v.version) && v.version > 0 && time(v.createdAt) &&
  (v.status === 'open' ? v.resolution === null && v.resolvedAt === null && v.version === 1 : v.status === 'resolved' && ['dismissed', 'hidden', 'withdrawn'].includes(v.resolution) && time(v.resolvedAt) && v.resolvedAt >= v.createdAt && v.version === 2)); }
export function isForumReports(v, id, env) { return safe(() => fields(v, [...scopeKeys, 'items', 'nextCursor']) && scope(v, id, env) && list(v.items, r => isForumReport(r) && (r.resolvedAt ?? r.createdAt) <= v.serverTime) && pagination(v) && (env !== 'production' || !v.items.length)); }
export function isForumCommandReceipt(v, id, env, operationKey, action) { return safe(() => fields(v, ['forumFormat', 'ownerId', 'environment', 'operationKey', 'action', 'outcome', 'code', 'contentId', 'completedAt']) &&
  v.forumFormat === 1 && owner(v.ownerId) && v.ownerId === id && mode(v.environment) && v.environment === env && key(v.operationKey) && v.operationKey === operationKey &&
  FORUM_ACTIONS.includes(v.action) && v.action === action && time(v.completedAt) && (v.contentId === null || isForumId(v.contentId)) &&
  (v.outcome === 'applied' ? v.code === 'OK' && v.contentId !== null && env !== 'production' : v.outcome === 'refused' && FORUM_REFUSAL_CODES.includes(v.code) && v.contentId === null)); }
export function isModerationBatch(v) { return safe(() => fields(v, ['formatVersion', 'batchId', 'operatorId', 'decisions']) && v.formatVersion === 1 && key(v.batchId) &&
  typeof v.operatorId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}(?![\s\S])/u.test(v.operatorId) && v.decisions.length > 0 && list(v.decisions, d =>
    fields(d, ['kind', 'id', 'expectedVersion', 'decision', 'reason', ...(Object.getOwnPropertyDescriptor(d, 'kind')?.value === 'report' ? ['expectedContentVersion'] : [])]) && isForumId(d.id) && integer(d.expectedVersion) && d.expectedVersion > 0 && FORUM_REASONS.includes(d.reason) &&
    (d.kind !== 'report' || integer(d.expectedContentVersion) && d.expectedContentVersion > 0) &&
    (d.kind === 'content' ? ['approve', 'reject', 'hide', 'restore'].includes(d.decision) : d.kind === 'report' && ['hide', 'dismiss'].includes(d.decision)))); }
export function isModerationQueue(v) { return safe(() => {
  if (!fields(v, ['formatVersion', 'environment', 'serverTime', 'contentState', 'contents', 'reports', 'parents']) || v.formatVersion !== 1 || v.environment !== 'development' || !time(v.serverTime) || !FORUM_MODERATION_STATES.includes(v.contentState) ||
    !list(v.contents, c => isForumContent(c) && c.state === v.contentState && !c.author.self && c.updatedAt <= v.serverTime) ||
    !list(v.parents, c => isForumContent(c) && c.kind === 'post' && !c.author.self && c.updatedAt <= v.serverTime, 40) ||
    !list(v.reports, r => { if (!fields(r, ['id', 'contentId', 'kind', 'reason', 'status', 'resolution', 'version', 'createdAt', 'resolvedAt', 'content'])) return false;
      const { content, ...report } = r; return isForumReport(report) && report.status === 'open' && isForumContent(content) && content.state !== 'withdrawn' && !content.author.self && content.id === report.contentId && content.kind === report.kind && content.updatedAt <= v.serverTime && report.createdAt <= v.serverTime; })) return false;
  const comments = [...v.contents, ...v.reports.map(r => r.content)].filter(c => c.kind === 'comment');
  return v.parents.length === new Set(comments.map(c => c.parentId)).size && comments.every(c => v.parents.some(p => p.id === c.parentId && p.circle === c.circle && p.state !== 'withdrawn'));
}); }
