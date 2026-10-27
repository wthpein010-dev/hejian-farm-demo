import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeReceipt, decodeReceipt } from './receipt-codec.mjs';
import { normalizeFarmBatch } from '../../../shared/farm-records.mjs';
import { FARM_REGISTRY_SQL, createFarmRegistry, FarmRegistryError } from './farm-registry.mjs';

const require = createRequire(import.meta.url);
const Systems = require('../../../prototype/systems.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const DELETION_SESSION_MAX_AGE = 5 * 60_000;
const DELETION_CONFIRMATION_TTL = 2 * 60_000;
const PRIVACY_CATEGORIES = [
  { id: 'account', title: '账户资料', description: '账户标识、显示名称及创建与更新时间' },
  { id: 'assets', title: '田园资产与活动', description: '积分、饲料、购物车、库存、签到与活动进度' },
  { id: 'history', title: '操作记录', description: '兑换和奖励回执、用于防止重复记账的操作记录' },
  { id: 'farm-records', title: '农场归属与观测记录', description: '归属档案、种养轮次及农场来源的观测历史' },
  { id: 'sessions', title: '登录会话', description: '会话摘要、有效期限与退出状态' },
];

function initialState(sandbox, now) {
  const system = Systems.createState(now);
  if (!sandbox) {
    for (const name of Object.keys(system.inventory)) system.inventory[name] = 0;
    system.coupons = []; system.xp = 0;
  }
  return { system, wallet: { points: sandbox ? 80 : 0, feed: sandbox ? 6 : 0,
    adToday: 0, inviteCount: 0, welcomeClaimed: false, receipts: [] } };
}

export class FarmStore {
  #database;
  #config;
  #closed = false;
  #statements = new Map();
  #farmRegistry;

  constructor(config) {
    this.#config = config;
    if (config.databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(config.databasePath);
    try {
      const schema = this.#prepare('PRAGMA user_version').get().user_version;
      if (schema > 5) throw new Error('数据库schema版本高于服务支持版本，请勿降级启动');
      this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS server_clock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_time INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO server_clock (singleton, last_time) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        identity_provider TEXT NOT NULL,
        identity_subject TEXT NOT NULL,
        display_name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (environment, identity_provider, identity_subject)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS idempotency (
        user_id TEXT NOT NULL REFERENCES users(id),
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        success_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS code_claims (
        code_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'used', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_confirmations (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        session_hash TEXT NOT NULL,
        expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deletion_confirmations_user ON deletion_confirmations(user_id);
      CREATE TABLE IF NOT EXISTS deletion_receipts (
        token_hash TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      );
      ${FARM_REGISTRY_SQL}
      PRAGMA user_version = 5;
    `);
      this.#farmRegistry = createFarmRegistry({ prepare: sql => this.#prepare(sql), environment: config.mode });
    } catch (error) { this.#database.close(); this.#statements.clear(); throw error; }
  }

  #prepare(sql) {
    // The key space is the fixed SQL below, never request data. Each invocation
    // still binds fresh arguments with get/run and reads the current database.
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #transaction(work) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  readiness() {
    if (this.#closed) return false;
    try {
      const row = this.#prepare('SELECT last_time FROM server_clock WHERE singleton = 1').get();
      return Number.isSafeInteger(row?.last_time) && row.last_time >= 0;
    } catch { return false; }
  }

  prepareShutdown() {
    // A synchronous SQLite lock wait would block both the shutdown timer and
    // every other request on this event loop. This connection-local setting
    // lets already accepted work finish only when its write lock is available.
    if (!this.#closed) this.#database.exec('PRAGMA busy_timeout = 0');
  }

  serverNow() {
    const now = this.#config.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('服务器时间无效');
    return this.#prepare('UPDATE server_clock SET last_time = MAX(last_time, ?) WHERE singleton = 1 RETURNING last_time').get(now).last_time;
  }

  #user(userId) {
    const row = this.#prepare('SELECT * FROM users WHERE id = ? AND environment = ?').get(userId, this.#config.mode);
    if (!row) throw new Error('Session user is unavailable');
    return row;
  }

  #sandbox(row) { return row.environment === 'development' && row.identity_provider === 'development'; }

  #snapshot(row, state, now) {
    const sandbox = this.#sandbox(row);
    return {
      serverTime: now, revision: row.revision, environment: row.environment,
      profile: { id: row.id, displayName: row.display_name },
      wallet: state.wallet, system: state.system, catalog: Systems.getCatalog(),
      tasks: Systems.getTasks(state.system, now), signIn: Systems.getSignIn(state.system, now),
      season: Systems.getSeasonStatus(state.system, now), achievements: Systems.getAchievements(state.system),
      level: Systems.getLevel(state.system), farm: { plots: [], animals: [] },
      capabilities: { pointShop: sandbox, activities: sandbox, care: false, adoption: false,
        live: false, shipping: false, payments: false, advertising: false },
    };
  }

  #sync(row, now) {
    const state = JSON.parse(row.state_json), system = Systems.syncDay(state.system, now);
    if (system.daily.day !== state.system.daily.day) {
      state.system = system; state.wallet.adToday = 0; row.revision++;
      row.state_json = JSON.stringify(state);
      this.#prepare('UPDATE users SET state_json = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(row.state_json, row.revision, now, row.id);
    }
    return state;
  }

  createIdentity(provider, subject, now) {
    return this.#transaction(() => {
      let row = this.#prepare('SELECT * FROM users WHERE environment = ? AND identity_provider = ? AND identity_subject = ?')
        .get(this.#config.mode, provider, subject);
      if (!row) {
        const id = randomUUID(), sandbox = this.#config.mode === 'development' && provider === 'development';
        this.#prepare('INSERT INTO users (id, environment, identity_provider, identity_subject, display_name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
          .run(id, this.#config.mode, provider, subject, sandbox ? '沙盒体验者' : '田园新友', JSON.stringify(initialState(sandbox, now)), now, now);
        row = this.#user(id);
      }
      const token = randomBytes(32).toString('base64url'), expiresAt = now + this.#config.sessionTtlMs;
      if (!Number.isSafeInteger(expiresAt)) throw new RangeError('会话期限无效');
      this.#prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(now);
      this.#prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(hash(token), row.id, now, expiresAt);
      return { token, expiresAt, profile: { id: row.id, displayName: row.display_name } };
    });
  }

  authenticate(token, now) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.#session(hash(token), now)?.user_id ?? null;
  }

  #session(tokenHash, now) {
    return this.#prepare(`SELECT sessions.user_id, sessions.created_at FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.revoked_at IS NULL AND users.environment = ?`)
      .get(tokenHash, now, this.#config.mode);
  }

  logout(token, now) { this.#prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(now, hash(token)); }

  claimPlatformCode(provider, namespace, code, now) {
    const codeHash = hash(provider + '\0' + namespace + '\0' + code);
    return this.#transaction(() => {
      const result = this.#prepare('INSERT OR IGNORE INTO code_claims (code_hash, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(codeHash, provider, 'pending', now, now);
      return result.changes === 1 ? codeHash : null;
    });
  }

  finishPlatformCode(codeHash, status, now) {
    if (!['used', 'failed'].includes(status)) throw new TypeError('登录凭证状态无效');
    this.#prepare('UPDATE code_claims SET status = ?, updated_at = ? WHERE code_hash = ? AND status = ?')
      .run(status, now, codeHash, 'pending');
  }

  bootstrap(userId, now) {
    return this.#transaction(() => { const row = this.#user(userId); return this.#snapshot(row, this.#sync(row, now), now); });
  }

  farmPage(userId, kind, cursor = 'start', now) {
    return this.#transaction(() => { this.#user(userId); return this.#farmRegistry.page(userId, kind, cursor, now); });
  }

  farmDetail(userId, id, beforeVersion = 0, now) {
    return this.#transaction(() => { this.#user(userId); return this.#farmRegistry.detail(userId, id, beforeVersion, now); });
  }

  importFarmBatch(batch, now) {
    let normalized;
    try { normalized = normalizeFarmBatch(batch, { environment: this.#config.mode, now }); }
    catch { throw new FarmRegistryError('INVALID_FARM_DATA'); }
    return this.#transaction(() => this.#farmRegistry.applyBatch(normalized, now));
  }

  privacy(userId) {
    const row = this.#user(userId);
    return { profile: { id: row.id, displayName: row.display_name }, createdAt: row.created_at,
      updatedAt: row.updated_at, dataCategories: PRIVACY_CATEGORIES, deletionSupported: true };
  }

  prepareDeletion(userId, token, expectedRevision, now) {
    return this.#transaction(() => {
      const sessionHash = hash(token), session = this.#session(sessionHash, now);
      if (!session || session.user_id !== userId || now - session.created_at > DELETION_SESSION_MAX_AGE) {
        return { status: 401, error: { code: 'REAUTH_REQUIRED', message: '注销账户需要近期登录，请重新登录后再核对' } };
      }
      const row = this.#user(userId), state = this.#sync(row, now);
      if (row.revision !== expectedRevision) return { status: 409,
        error: { code: 'REVISION_CONFLICT', message: '田园状态已有更新，请核对最新明细后重新确认' }, data: this.#snapshot(row, state, now) };
      const confirmationToken = randomBytes(32).toString('base64url'), expiresAt = now + DELETION_CONFIRMATION_TTL;
      if (!Number.isSafeInteger(expiresAt)) throw new RangeError('确认凭证期限无效');
      this.#prepare('DELETE FROM deletion_confirmations WHERE user_id = ?').run(userId);
      this.#prepare('INSERT INTO deletion_confirmations (token_hash, user_id, session_hash, expected_revision, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(hash(confirmationToken), userId, sessionHash, row.revision, expiresAt);
      return { status: 200, data: { confirmationToken, expiresAt, serverTime: now } };
    });
  }

  confirmDeletion(confirmationToken, now) {
    return this.#transaction(() => {
      const tokenHash = hash(confirmationToken);
      const receipt = this.#prepare('SELECT completed_at FROM deletion_receipts WHERE token_hash = ?').get(tokenHash);
      if (receipt) return { status: 200, data: { deleted: true, completedAt: receipt.completed_at } };
      const pending = this.#prepare(`SELECT deletion_confirmations.* FROM deletion_confirmations
        JOIN users ON users.id = deletion_confirmations.user_id WHERE deletion_confirmations.token_hash = ? AND users.environment = ?`)
        .get(tokenHash, this.#config.mode);
      const failure = (status, code, message) => ({ status, error: { code, message } });
      if (!pending) return failure(410, 'DELETION_INVALID', '此确认凭证无效或已撤销，请返回账户页重新核对');
      if (pending.expires_at <= now) return failure(410, 'DELETION_EXPIRED', '此确认凭证已过期，请返回账户页重新核对');
      const session = this.#session(pending.session_hash, now);
      if (!session || session.user_id !== pending.user_id) return failure(401, 'REAUTH_REQUIRED', '原登录已失效，账户未注销，请重新登录后再核对');
      const row = this.#user(pending.user_id);
      this.#sync(row, now);
      if (row.revision !== pending.expected_revision) return failure(409, 'DELETION_STATE_CHANGED', '账户数据已有变化，账户未注销，请返回账户页刷新并重新核对');
      this.#prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      this.#prepare('DELETE FROM idempotency WHERE user_id = ?').run(row.id);
      this.#prepare('DELETE FROM deletion_confirmations WHERE user_id = ?').run(row.id);
      this.#farmRegistry.deleteOwner(row.id);
      this.#prepare('DELETE FROM users WHERE id = ?').run(row.id);
      this.#prepare('INSERT INTO deletion_receipts (token_hash, completed_at) VALUES (?, ?)').run(tokenHash, now);
      return { status: 200, data: { deleted: true, completedAt: now } };
    });
  }

  mutate(userId, key, fingerprint, expectedRevision, operation, now) {
    return this.#transaction(() => {
      const row = this.#user(userId);
      const existing = this.#prepare('SELECT fingerprint, success_json FROM idempotency WHERE user_id = ? AND key = ?').get(userId, key);
      if (existing?.fingerprint === fingerprint && existing.success_json) {
        const recovered = decodeReceipt(existing.success_json);
        if (recovered.profile?.id !== userId || recovered.environment !== row.environment) throw new Error('回执归属未能确认');
        return { status: 200, data: recovered, replayed: true, message: '这次操作已经完成，已恢复原结果' };
      }
      const state = this.#sync(row, now);
      const failure = (status, code, message) => ({ status, error: { code, message }, data: this.#snapshot(row, state, now) });
      if (existing && existing.fingerprint !== fingerprint) return failure(409, 'IDEMPOTENCY_CONFLICT', '此操作编号已用于其他请求，请核对最新状态后重新操作');
      if (!existing) this.#prepare('INSERT INTO idempotency (user_id, key, fingerprint, created_at) VALUES (?, ?, ?, ?)').run(userId, key, fingerprint, now);
      if (row.revision !== expectedRevision) return failure(409, 'REVISION_CONFLICT', '田园状态已有更新，请核对最新明细后重新确认');
      if (!this.#sandbox(row)) return failure(503, 'CAPABILITY_UNAVAILABLE', '真实经营服务尚未配置，暂不可提交此操作');
      const receiptId = 'api-' + hash(userId + '\n' + key);
      let result;
      switch (operation.type) {
        case 'cart': result = Systems.addCart(state.system, operation.sku, operation.delta, now); break;
        case 'checkout': result = Systems.checkout(state.system, state.wallet, { now, receiptId, couponId: operation.couponId }); break;
        case 'shop-visit': result = { ok: true, system: Systems.recordEvent(state.system, { type: 'browse', eventId: `api-shop-${state.system.daily.day}`, now }), reason: '已记录今日商城访问' }; break;
        case 'sign-in': result = Systems.signIn(state.system, state.wallet, { now, receiptId }); break;
        case 'task': result = Systems.claimTask(state.system, state.wallet, { now, receiptId, taskId: operation.taskId }); break;
        case 'achievement': result = Systems.claimAchievement(state.system, state.wallet, { now, receiptId, achievementId: operation.achievementId }); break;
        case 'season': result = Systems.claimSeason(state.system, state.wallet, { now, receiptId }); break;
        default: throw new TypeError('Unknown internal mutation');
      }
      if (!result.ok) return failure(422, 'BUSINESS_RULE', result.reason);
      const next = { system: result.system, wallet: result.wallet ?? state.wallet }, serialized = JSON.stringify(next);
      if (serialized !== row.state_json) {
        row.revision++; row.state_json = serialized;
        this.#prepare('UPDATE users SET state_json = ?, revision = ?, updated_at = ? WHERE id = ?')
          .run(serialized, row.revision, now, userId);
      }
      const snapshot = this.#snapshot(row, next, now);
      this.#prepare('UPDATE idempotency SET success_json = ? WHERE user_id = ? AND key = ?').run(encodeReceipt(snapshot), userId, key);
      return { status: 200, data: snapshot, replayed: false, message: result.reason };
    });
  }

  close() { if (!this.#closed) { this.#database.close(); this.#statements.clear(); this.#closed = true; } }
}
