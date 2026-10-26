import { fileURLToPath } from 'node:url';
import { platformProvidersFromEnvironment } from './providers.mjs';

const DEFAULT_DATABASE = fileURLToPath(new URL('../data/farm.sqlite', import.meta.url));

const integer = (value, fallback, min, max, label) => {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new TypeError(`${label}配置无效`);
  return number;
};

function origins(values, mode) {
  if (!Array.isArray(values)) throw new TypeError('allowedOrigins必须为明确的域名列表');
  return new Set(values.map(value => {
    if (typeof value !== 'string' || value === '*' || value === 'null') throw new TypeError('CORS来源配置无效');
    let url;
    try { url = new URL(value); } catch { throw new TypeError('CORS来源配置无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password ||
      (mode === 'production' && url.protocol !== 'https:')) throw new TypeError('CORS来源必须为明确的HTTPS域名；开发环境可使用HTTP');
    return value;
  }));
}

export function normalizeConfig(options = {}) {
  const mode = options.mode ?? 'production';
  if (!['development', 'production'].includes(mode)) throw new TypeError('mode必须为development或production');
  const allowDevelopmentAuth = options.allowDevelopmentAuth ?? false;
  if (typeof allowDevelopmentAuth !== 'boolean' || (mode === 'production' && allowDevelopmentAuth)) {
    throw new TypeError('production禁止开启development开发登录');
  }
  const databasePath = options.databasePath ?? DEFAULT_DATABASE;
  if (typeof databasePath !== 'string' || !databasePath.length || databasePath.includes('\0')) throw new TypeError('数据库路径配置无效');
  const providers = options.platformProviders ?? {};
  if (!providers || typeof providers !== 'object' || Array.isArray(providers) ||
    Object.entries(providers).some(([name, fn]) => !['weixin', 'toutiao'].includes(name) || typeof fn !== 'function')) {
    throw new TypeError('平台身份provider配置无效');
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new TypeError('clock时钟必须为服务端函数');
  const authLimit = options.developmentAuthLimit ?? {};
  const requestLimit = options.requestRateLimit ?? {};
  return Object.freeze({
    mode, allowDevelopmentAuth, databasePath,
    allowedOrigins: origins(options.allowedOrigins ?? [], mode),
    clock: typeof options.clock === 'function' ? options.clock : Date.now,
    sessionTtlMs: integer(options.sessionTtlMs, 30 * 60_000, 1000, 30 * 86400000, '会话时长'),
    providerTimeoutMs: integer(options.providerTimeoutMs, 8000, 100, 30_000, '平台请求超时'),
    platformProviders: Object.freeze({ ...providers }),
    authLimit: Object.freeze({ max: integer(authLimit.maxAttempts, 10, 1, 1000, '登录限速'),
      windowMs: integer(authLimit.windowMs, 60_000, 1000, 3600_000, '登录窗口') }),
    requestLimit: Object.freeze({ max: integer(requestLimit.maxRequests, 240, 1, 10000, '请求限速'),
      windowMs: integer(requestLimit.windowMs, 60_000, 1000, 3600_000, '请求窗口') }),
  });
}

export function configFromEnvironment(env = process.env) {
  if (env.NODE_ENV === 'production' && env.FARM_MODE === 'development') throw new TypeError('production进程禁止开发环境登录');
  const boolean = value => value === undefined ? false : value === 'true' ? true : value === 'false' ? false : (() => { throw new TypeError('布尔环境配置必须为true或false'); })();
  const port = Number(env.FARM_PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('FARM_PORT配置无效');
  return {
    mode: env.FARM_MODE ?? 'production', allowDevelopmentAuth: boolean(env.FARM_ALLOW_DEVELOPMENT_AUTH),
    databasePath: env.FARM_DATABASE_PATH ?? DEFAULT_DATABASE,
    allowedOrigins: env.FARM_ALLOWED_ORIGINS ? env.FARM_ALLOWED_ORIGINS.split(',').map(value => value.trim()) : [],
    platformProviders: platformProvidersFromEnvironment(env),
    host: env.FARM_HOST ?? '127.0.0.1', port,
  };
}
