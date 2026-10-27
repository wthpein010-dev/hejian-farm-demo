import { createHash, randomBytes } from 'node:crypto';
import { FORUM_CIRCLES, FORUM_LIMITS, FORUM_PAGE_SIZE, FORUM_MODERATION_STATES, isForumId, isForumCommand, isForumContent, isForumReport,
  isForumStatus, isForumPage, isForumDetail, isForumReports, isForumCommandReceipt, isModerationBatch, isModerationQueue } from '../../../shared/forum.mjs';

export const FORUM_TABLE_SQL = Object.freeze({
  forum_content: `CREATE TABLE IF NOT EXISTS forum_content (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK (kind IN ('post', 'comment')),
    parent_id TEXT, circle TEXT NOT NULL CHECK (circle IN ('harvest', 'questions', 'chat')), title TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'rejected', 'hidden', 'withdrawn')),
    version INTEGER NOT NULL CHECK (version >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    published_at INTEGER, reason_code TEXT, PRIMARY KEY (environment, id),
    FOREIGN KEY (environment, parent_id) REFERENCES forum_content(environment, id),
    CHECK ((kind = 'post' AND parent_id IS NULL) OR (kind = 'comment' AND parent_id IS NOT NULL)))`,
  forum_usage: `CREATE TABLE IF NOT EXISTS forum_usage (
    owner_id TEXT PRIMARY KEY REFERENCES users(id), environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
    day TEXT NOT NULL, posts INTEGER NOT NULL CHECK (posts BETWEEN 0 AND 10), comments INTEGER NOT NULL CHECK (comments BETWEEN 0 AND 50),
    reports INTEGER NOT NULL CHECK (reports BETWEEN 0 AND 20), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  forum_reports: `CREATE TABLE IF NOT EXISTS forum_reports (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id), content_id TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')), resolution TEXT,
    version INTEGER NOT NULL CHECK (version >= 1), created_at INTEGER NOT NULL, resolved_at INTEGER,
    PRIMARY KEY (environment, id), UNIQUE (environment, owner_id, content_id),
    FOREIGN KEY (environment, content_id) REFERENCES forum_content(environment, id))`,
  forum_commands: `CREATE TABLE IF NOT EXISTS forum_commands (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), owner_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (environment, owner_id, key))`,
  forum_moderation: `CREATE TABLE IF NOT EXISTS forum_moderation (
    environment TEXT NOT NULL CHECK (environment IN ('development', 'production')), batch_id TEXT NOT NULL,
    operator_id TEXT NOT NULL, decisions_json TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (environment, batch_id))`,
});
export const FORUM_INDEX_SQL = Object.freeze({
  forum_content_feed: 'CREATE INDEX IF NOT EXISTS forum_content_feed ON forum_content(environment, kind, state, created_at, id)',
  forum_content_owner: 'CREATE INDEX IF NOT EXISTS forum_content_owner ON forum_content(owner_id, environment, created_at, id)',
  forum_content_parent: 'CREATE INDEX IF NOT EXISTS forum_content_parent ON forum_content(environment, parent_id, created_at, id)',
  forum_reports_owner: 'CREATE INDEX IF NOT EXISTS forum_reports_owner ON forum_reports(owner_id, environment, created_at, id)',
});
export const FORUM_SQL = [...Object.values(FORUM_TABLE_SQL), ...Object.values(FORUM_INDEX_SQL)].join(';\n') + ';';
const day = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const randomId = () => randomBytes(16).toString('hex');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const time = v => Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const eligible = u => u.environment === 'development' && u.identity_provider === 'development';
const SELECT = `SELECT c.*, p.peer_id FROM forum_content c JOIN friends_profiles p ON p.owner_id = c.owner_id AND p.environment = c.environment
  JOIN users u ON u.id = c.owner_id AND u.environment = c.environment AND u.identity_provider = 'development'`;
const UNBLOCKED = `NOT EXISTS (SELECT 1 FROM friends_blocks b WHERE b.environment = c.environment AND
  ((b.owner_id = ? AND b.peer_id = c.owner_id) OR (b.owner_id = c.owner_id AND b.peer_id = ?)))`;
export class ForumError extends Error {
  constructor(code = 'INVALID_FORUM_DATA') { super('论坛操作暂不可用，请刷新后核对'); this.name = 'ForumError'; this.code = code; }
}
const fail = code => { throw new ForumError(code); };
function contentDto(row, self = false) {
  const result = { id: row.id, kind: row.kind, parentId: row.parent_id, circle: row.circle,
    author: { peerId: row.peer_id, alias: '农友' + row.peer_id.slice(0, 8), self }, title: row.title, body: row.body,
    state: row.state, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    publishedAt: row.published_at, reasonCode: row.reason_code };
  if (!isForumContent(result)) fail('INVALID_FORUM_DATA'); return result;
}
function reportDto(row) {
  const result = { id: row.id, contentId: row.content_id, kind: row.kind, reason: row.reason, status: row.status,
    resolution: row.resolution, version: row.version, createdAt: row.created_at, resolvedAt: row.resolved_at };
  if (!isForumReport(result)) fail('INVALID_FORUM_DATA'); return result;
}
function moderationResult(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'applied,ok,operation,replayed' || value.ok !== true ||
    value.operation !== 'forum-moderation' || value.replayed !== false || !Number.isSafeInteger(value.applied) || value.applied < 1 || value.applied > 20) fail('INVALID_FORUM_DATA');
  return value;
}

// FarmStore owns one IMMEDIATE transaction around every call, including friendship changes.
export function createForum({ prepare, environment, blockFromForum }) {
  const base = (user, now) => ({ forumFormat: 1, ownerId: user.id, environment, serverTime: now });
  const profile = id => prepare('SELECT * FROM friends_profiles WHERE owner_id = ? AND environment = ?').get(id, environment);
  const get = id => prepare(SELECT + ' WHERE c.environment = ? AND c.id = ?').get(environment, id);
  const usage = (id, now) => {
    const row = prepare('SELECT * FROM forum_usage WHERE owner_id = ? AND environment = ?').get(id, environment);
    return row?.day === day(now) ? { posts: row.posts, comments: row.comments, reports: row.reports } : { posts: 0, comments: 0, reports: 0 };
  };
  const consume = (id, field, now) => {
    const old = usage(id, now); old[field]++;
    prepare(`INSERT INTO forum_usage (owner_id, environment, day, posts, comments, reports, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_id) DO UPDATE SET day = excluded.day, posts = excluded.posts, comments = excluded.comments, reports = excluded.reports, updated_at = excluded.updated_at`)
      .run(id, environment, day(now), old.posts, old.comments, old.reports, now, now);
  };
  const isBlocked = (a, b) => !!prepare('SELECT 1 FROM friends_blocks WHERE environment = ? AND ((owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?))').get(environment, a, b, b, a);
  function visible(user, row, allowOwn = true) {
    if (!eligible(user) || !row || isBlocked(user.id, row.owner_id)) return false;
    if (allowOwn && row.owner_id === user.id) return true;
    if (row.state !== 'published') return false;
    if (row.kind === 'comment') { const parent = get(row.parent_id); return parent?.state === 'published' && !isBlocked(user.id, parent.owner_id); }
    return true;
  }
  function pageRows(user, type, circle, cursor) {
    if (!(cursor === 'start' || isForumId(cursor))) fail('INVALID_CURSOR');
    const anchor = cursor === 'start' ? null : get(cursor);
    if (cursor !== 'start' && (!anchor || (type === 'mine' ? anchor.owner_id !== user.id : anchor.kind !== 'post' || (circle !== 'all' && anchor.circle !== circle) || !visible(user, anchor, false)))) fail('INVALID_CURSOR');
    return prepare(SELECT + ` WHERE c.environment = ? AND (? = 'mine' AND c.owner_id = ? OR ? = 'public' AND c.kind = 'post' AND c.state = 'published' AND (? = 'all' OR c.circle = ?) AND ${UNBLOCKED})
      AND (? = 1 OR c.created_at < ? OR (c.created_at = ? AND c.id < ?)) ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
      .all(environment, type, user.id, type, circle, circle, user.id, user.id, cursor === 'start' ? 1 : 0, anchor?.created_at ?? 0, anchor?.created_at ?? 0, cursor, FORUM_PAGE_SIZE + 1);
  }
  function change(row, state, reason, now) {
    if (row.version >= Number.MAX_SAFE_INTEGER || now < row.updated_at) fail('CONTENT_CHANGED');
    prepare('UPDATE forum_content SET state = ?, version = version + 1, updated_at = ?, published_at = ?, reason_code = ?, title = ?, body = ? WHERE environment = ? AND id = ?')
      .run(state, now, state === 'published' ? row.published_at ?? now : row.published_at, reason, state === 'withdrawn' ? '' : row.title, state === 'withdrawn' ? '' : row.body, environment, row.id);
  }
  function resolveReports(contentId, resolution, now) {
    prepare("UPDATE forum_reports SET status = 'resolved', resolution = ?, version = version + 1, resolved_at = ? WHERE environment = ? AND content_id = ? AND status = 'open'")
      .run(resolution, now, environment, contentId);
  }
  return {
    status(user, now) {
      const available = eligible(user), p = available ? profile(user.id) : null;
      const result = { ...base(user, now), available, canPost: !!p?.enabled, alias: p?.enabled ? '农友' + p.peer_id.slice(0, 8) : null,
        limits: { ...FORUM_LIMITS }, usage: available ? usage(user.id, now) : { posts: 0, comments: 0, reports: 0 } };
      if (!isForumStatus(result, user.id, environment)) fail('INVALID_FORUM_DATA'); return result;
    },
    page(user, circle, cursor, now, type = 'public') {
      if (!['all', ...FORUM_CIRCLES].includes(circle) || !['public', 'mine'].includes(type) || !(cursor === 'start' || isForumId(cursor))) fail('INVALID_CURSOR');
      const rows = eligible(user) ? pageRows(user, type, circle, cursor) : [];
      const result = { ...base(user, now), scope: type, circle, items: rows.slice(0, 20).map(r => contentDto(r, r.owner_id === user.id)), nextCursor: rows.length > 20 ? rows[19].id : null };
      if (!isForumPage(result, user.id, environment, type, circle)) fail('INVALID_FORUM_DATA'); return result;
    },
    detail(user, id, cursor, now) {
      if (!isForumId(id) || !(cursor === 'start' || isForumId(cursor))) fail('INVALID_CURSOR');
      const row = get(id); if (!row || row.kind !== 'post' || !visible(user, row)) return null;
      let rows = [];
      if (row.state !== 'withdrawn') {
        const anchor = cursor === 'start' ? null : get(cursor);
        if (cursor !== 'start' && (!anchor || anchor.parent_id !== id || anchor.state === 'withdrawn' || !visible(user, anchor))) fail('INVALID_CURSOR');
        rows = prepare(SELECT + ` WHERE c.environment = ? AND c.parent_id = ? AND c.state != 'withdrawn' AND (c.state = 'published' OR c.owner_id = ?) AND ${UNBLOCKED}
          AND (? = 1 OR c.created_at < ? OR (c.created_at = ? AND c.id < ?)) ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
          .all(environment, id, user.id, user.id, user.id, cursor === 'start' ? 1 : 0, anchor?.created_at ?? 0, anchor?.created_at ?? 0, cursor, 21);
      }
      const result = { ...base(user, now), post: contentDto(row, row.owner_id === user.id), comments: rows.slice(0, 20).map(r => contentDto(r, r.owner_id === user.id)), nextCursor: rows.length > 20 ? rows[19].id : null };
      if (!isForumDetail(result, user.id, environment, id)) fail('INVALID_FORUM_DATA'); return result;
    },
    reports(user, cursor, now) {
      if (!(cursor === 'start' || isForumId(cursor))) fail('INVALID_CURSOR');
      let rows = [];
      if (eligible(user)) {
        const anchor = cursor === 'start' ? null : prepare('SELECT * FROM forum_reports WHERE environment = ? AND owner_id = ? AND id = ?').get(environment, user.id, cursor);
        if (cursor !== 'start' && !anchor) fail('INVALID_CURSOR');
        rows = prepare(`SELECT r.*, c.kind FROM forum_reports r JOIN forum_content c ON c.environment = r.environment AND c.id = r.content_id
          WHERE r.environment = ? AND r.owner_id = ? AND (? = 1 OR r.created_at < ? OR (r.created_at = ? AND r.id < ?)) ORDER BY r.created_at DESC, r.id DESC LIMIT 21`)
          .all(environment, user.id, cursor === 'start' ? 1 : 0, anchor?.created_at ?? 0, anchor?.created_at ?? 0, cursor);
      }
      const result = { ...base(user, now), items: rows.slice(0, 20).map(reportDto), nextCursor: rows.length > 20 ? rows[19].id : null };
      if (!isForumReports(result, user.id, environment)) fail('INVALID_FORUM_DATA'); return result;
    },
    command(user, key, input, now) {
      if (!isForumCommand(input)) fail('INVALID_FORUM_DATA');
      const fingerprint = digest(input), previous = prepare('SELECT * FROM forum_commands WHERE environment = ? AND owner_id = ? AND key = ?').get(environment, user.id, key);
      const receipt = (code, contentId = null) => ({ forumFormat: 1, ownerId: user.id, environment, operationKey: key, action: input.action,
        outcome: code === 'OK' ? 'applied' : 'refused', code, contentId, completedAt: now });
      if (previous) {
        if (previous.fingerprint !== fingerprint) return receipt('IDEMPOTENCY_CONFLICT');
        const result = JSON.parse(previous.result_json);
        if (!isForumCommandReceipt(result, user.id, environment, key, input.action) || (!eligible(user) && (result.outcome !== 'refused' || result.code !== 'FORUM_UNAVAILABLE'))) fail('INVALID_FORUM_DATA');
        return result;
      }
      const apply = () => {
        if (!eligible(user)) return receipt('FORUM_UNAVAILABLE');
        if (input.action !== 'withdraw' && !profile(user.id)?.enabled) return receipt('FRIENDS_DISABLED');
        const u = usage(user.id, now);
        let row = input.action === 'submit-post' ? null : get(input.postId ?? input.contentId);
        if (input.action !== 'submit-post') {
          if (!visible(user, row, input.action === 'withdraw')) return receipt('CONTENT_UNAVAILABLE');
          if (row.version !== input.expectedVersion) return receipt('CONTENT_CHANGED');
        }
        if (input.action === 'submit-post' || input.action === 'submit-comment') {
          const kind = input.action === 'submit-post' ? 'post' : 'comment', field = kind === 'post' ? 'posts' : 'comments';
          if (kind === 'comment' && (row.kind !== 'post' || row.state !== 'published')) return receipt('CONTENT_UNAVAILABLE');
          if (u[field] >= FORUM_LIMITS[field]) return receipt(kind === 'post' ? 'DAILY_POST_LIMIT' : 'DAILY_COMMENT_LIMIT');
          if (prepare("SELECT COUNT(*) AS n FROM forum_content WHERE environment = ? AND owner_id = ? AND state != 'withdrawn'").get(environment, user.id).n >= 200) return receipt('ACTIVE_LIMIT');
          const id = randomId();
          prepare(`INSERT INTO forum_content (environment,id,owner_id,kind,parent_id,circle,title,body,state,version,created_at,updated_at,published_at,reason_code)
            VALUES (?,?,?,?,?,?,?,?, 'pending',1,?,?,NULL,NULL)`).run(environment, id, user.id, kind, row?.id ?? null, row?.circle ?? input.circle, input.title ?? '', input.body, now, now);
          consume(user.id, field, now); return receipt('OK', id);
        }
        if (input.action === 'withdraw') {
          if (row.owner_id !== user.id) return receipt('OWN_CONTENT_REQUIRED');
          const children = row.kind === 'post' ? prepare(SELECT + ' WHERE c.environment = ? AND c.parent_id = ?').all(environment, row.id) : [];
          for (const target of [row, ...children]) { if (target.state !== 'withdrawn') change(target, 'withdrawn', null, now); resolveReports(target.id, 'withdrawn', now); }
          return receipt('OK', row.id);
        }
        if (row.owner_id === user.id) return receipt(input.action === 'report' ? 'SELF_REPORT' : 'CONTENT_UNAVAILABLE');
        if (input.action === 'block-author') return blockFromForum(user.id, row.owner_id, now) === 'OK' ? receipt('OK', row.id) : receipt('BLOCK_LIMIT');
        if (prepare('SELECT 1 FROM forum_reports WHERE environment = ? AND owner_id = ? AND content_id = ?').get(environment, user.id, row.id)) return receipt('ALREADY_REPORTED');
        if (u.reports >= 20) return receipt('DAILY_REPORT_LIMIT');
        prepare("INSERT INTO forum_reports (environment,id,owner_id,content_id,reason,status,resolution,version,created_at,resolved_at) VALUES (?,?,?,?,?,'open',NULL,1,?,NULL)")
          .run(environment, randomId(), user.id, row.id, input.reason, now);
        consume(user.id, 'reports', now); return receipt('OK', row.id);
      };
      const result = apply();
      if (!isForumCommandReceipt(result, user.id, environment, key, input.action)) fail('INVALID_FORUM_DATA');
      prepare('INSERT INTO forum_commands (environment,owner_id,key,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)').run(environment, user.id, key, fingerprint, JSON.stringify(result), now);
      return result;
    },
    moderationQueue(now, state = 'pending') {
      if (environment !== 'development') fail('FORUM_UNAVAILABLE');
      if (!FORUM_MODERATION_STATES.includes(state)) fail('INVALID_MODERATION_STATE');
      const contents = prepare(SELECT + ' WHERE c.environment = ? AND c.state = ? ORDER BY c.created_at, c.id LIMIT 20').all(environment, state).map(r => contentDto(r));
      const reports = prepare(`SELECT r.*, c.kind FROM forum_reports r JOIN forum_content c ON c.environment = r.environment AND c.id = r.content_id
        WHERE r.environment = ? AND r.status = 'open' ORDER BY r.created_at, r.id LIMIT 20`).all(environment).map(r => ({ ...reportDto(r), content: contentDto(get(r.content_id)) }));
      const parentIds = [...new Set([...contents, ...reports.map(r => r.content)].filter(c => c.kind === 'comment').map(c => c.parentId))];
      const parents = parentIds.map(id => contentDto(get(id)));
      const result = { formatVersion: 1, environment, serverTime: now, contentState: state, contents, reports, parents };
      if (!isModerationQueue(result)) fail('INVALID_FORUM_DATA'); return result;
    },
    applyModeration(batch, now) {
      if (environment !== 'development') fail('FORUM_UNAVAILABLE');
      if (!isModerationBatch(batch)) fail('INVALID_MODERATION_BATCH');
      const fingerprint = digest(batch), previous = prepare('SELECT * FROM forum_moderation WHERE environment = ? AND batch_id = ?').get(environment, batch.batchId);
      if (previous) { if (previous.fingerprint !== fingerprint) fail('MODERATION_CONFLICT'); return { ...moderationResult(JSON.parse(previous.result_json)), replayed: true }; }
      for (const decision of batch.decisions) {
        if (decision.kind === 'content') {
          const row = get(decision.id); if (!row || row.state === 'withdrawn') fail('CONTENT_UNAVAILABLE');
          if (row.version !== decision.expectedVersion) fail('CONTENT_CHANGED');
          const target = { approve: ['pending', 'published'], reject: ['pending', 'rejected'], hide: ['published', 'hidden'], restore: ['hidden', 'published'] }[decision.decision];
          if (row.state !== target[0]) fail('INVALID_MODERATION_TRANSITION');
          if (row.kind === 'comment' && ['approve', 'restore'].includes(decision.decision) && get(row.parent_id)?.state !== 'published') fail('CONTENT_UNAVAILABLE');
          change(row, target[1], ['hidden', 'rejected'].includes(target[1]) ? decision.reason : null, now);
        } else {
          const report = prepare('SELECT * FROM forum_reports WHERE environment = ? AND id = ?').get(environment, decision.id);
          if (!report || report.status !== 'open') fail('REPORT_UNAVAILABLE');
          if (report.version !== decision.expectedVersion) fail('REPORT_CHANGED');
          const row = get(report.content_id); if (!row || row.state === 'withdrawn') fail('CONTENT_UNAVAILABLE');
          if (row.version !== decision.expectedContentVersion) fail('CONTENT_CHANGED');
          if (decision.decision === 'hide') {
            if (!['published', 'hidden'].includes(row.state)) fail('INVALID_MODERATION_TRANSITION');
            if (row.state === 'published') change(row, 'hidden', decision.reason, now);
          }
          prepare("UPDATE forum_reports SET status = 'resolved', resolution = ?, version = version + 1, resolved_at = ? WHERE environment = ? AND id = ?")
            .run(decision.decision === 'hide' ? 'hidden' : 'dismissed', now, environment, report.id);
        }
      }
      const result = { ok: true, operation: 'forum-moderation', applied: batch.decisions.length, replayed: false };
      prepare('INSERT INTO forum_moderation (environment,batch_id,operator_id,decisions_json,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(environment, batch.batchId, batch.operatorId, JSON.stringify(canonical(batch.decisions)), fingerprint, JSON.stringify(result), now);
      return result;
    },
    deleteOwner(id) {
      prepare(`DELETE FROM forum_reports WHERE environment = ? AND (owner_id = ? OR content_id IN
        (SELECT id FROM forum_content WHERE environment = ? AND (owner_id = ? OR parent_id IN (SELECT id FROM forum_content WHERE environment = ? AND owner_id = ? AND kind = 'post'))))`)
        .run(environment, id, environment, id, environment, id);
      prepare("DELETE FROM forum_content WHERE environment = ? AND parent_id IN (SELECT id FROM forum_content WHERE environment = ? AND owner_id = ? AND kind = 'post')").run(environment, environment, id);
      prepare('DELETE FROM forum_content WHERE environment = ? AND owner_id = ?').run(environment, id);
      prepare('DELETE FROM forum_usage WHERE environment = ? AND owner_id = ?').run(environment, id);
      prepare('DELETE FROM forum_commands WHERE environment = ? AND owner_id = ?').run(environment, id);
    },
  };
}

export function validateForumDatabase(db, now) {
  const invalid = () => fail('INVALID_FORUM_DATA');
  const users = new Map(db.prepare('SELECT id,environment,identity_provider,created_at FROM users').all().map(r => [r.id, r]));
  const profiles = new Map(db.prepare('SELECT owner_id,environment,peer_id,created_at FROM friends_profiles').all().map(r => [r.owner_id, r]));
  const rows = new Map(), active = new Map();
  for (const row of db.prepare('SELECT * FROM forum_content').all()) {
    const u = users.get(row.owner_id), p = profiles.get(row.owner_id);
    if (!u || !eligible(u) || u.environment !== row.environment || !p || p.environment !== row.environment ||
      row.created_at < Math.max(u.created_at, p.created_at) || row.updated_at > now) invalid();
    contentDto({ ...row, peer_id: p.peer_id }); rows.set(row.id, row);
    if (row.state !== 'withdrawn') { const n = (active.get(row.owner_id) ?? 0) + 1; if (n > 200) invalid(); active.set(row.owner_id, n); }
  }
  for (const row of rows.values()) {
    if (row.kind !== 'comment') continue;
    const parent = rows.get(row.parent_id);
    if (!parent || parent.kind !== 'post' || parent.environment !== row.environment || parent.circle !== row.circle || parent.created_at > row.created_at ||
      (parent.state === 'withdrawn' && row.state !== 'withdrawn') || (row.published_at !== null && (parent.published_at === null || row.published_at < parent.published_at))) invalid();
  }
  for (const row of db.prepare('SELECT * FROM forum_usage').all()) {
    const u = users.get(row.owner_id);
    if (!u || !eligible(u) || row.environment !== u.environment || !time(row.created_at) || row.created_at < u.created_at || !time(row.updated_at) || row.updated_at < row.created_at || row.updated_at > now ||
      typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || Number.isNaN(Date.parse(row.day)) || new Date(row.day).toISOString().slice(0, 10) !== row.day || row.day > day(now) ||
      ['posts', 'comments', 'reports'].some(k => !Number.isSafeInteger(row[k]) || row[k] < 0 || row[k] > FORUM_LIMITS[k])) invalid();
  }
  for (const row of db.prepare('SELECT * FROM forum_reports').all()) {
    const u = users.get(row.owner_id), content = rows.get(row.content_id);
    if (!u || !eligible(u) || row.environment !== u.environment || !content || content.environment !== row.environment || content.owner_id === row.owner_id || row.created_at < Math.max(u.created_at, content.created_at) ||
      (row.resolved_at ?? row.created_at) > now || content.state === 'withdrawn' && row.status === 'open') invalid();
    reportDto({ ...row, kind: content.kind });
  }
  for (const row of db.prepare('SELECT * FROM forum_commands').all()) {
    const u = users.get(row.owner_id); let receipt; try { receipt = JSON.parse(row.result_json); } catch { invalid(); }
    if (!u || u.environment !== row.environment || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !isForumCommandReceipt(receipt, row.owner_id, row.environment, row.key, receipt?.action) ||
      (!eligible(u) && (receipt.outcome !== 'refused' || receipt.code !== 'FORUM_UNAVAILABLE')) || receipt.completedAt !== row.created_at || row.created_at < u.created_at || row.created_at > now || JSON.stringify(receipt) !== row.result_json) invalid();
  }
  for (const row of db.prepare('SELECT * FROM forum_moderation').all()) {
    let result, decisions; try { result = JSON.parse(row.result_json); decisions = JSON.parse(row.decisions_json); } catch { invalid(); }
    const batch = { formatVersion: 1, batchId: row.batch_id, operatorId: row.operator_id, decisions };
    if (row.environment !== 'development' || !isModerationBatch(batch) || row.fingerprint !== digest(batch) || !time(row.created_at) || row.created_at > now ||
      JSON.stringify(canonical(decisions)) !== row.decisions_json || moderationResult(result).applied !== decisions.length || JSON.stringify(result) !== row.result_json) invalid();
  }
}
