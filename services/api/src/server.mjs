import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeConfig, configFromEnvironment } from './config.mjs';
import { FarmStore } from './store.mjs';
import { PlatformIdentityError } from './providers.mjs';

const BODY_LIMIT = 16 * 1024;
const PREFIX = '/api/v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/;
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
class RequestError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const invalid = () => new RequestError(400, 'INVALID_REQUEST', '请求内容无效，请检查后重试');

function object(body, required, optional = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => ![...required, ...optional].includes(key)) ||
    required.some(key => !Object.hasOwn(body, key))) throw invalid();
}

function jsonBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    request.resume(); throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用UTF-8 JSON提交请求');
  }
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    request.resume(); throw new RequestError(413, 'BODY_TOO_LARGE', '请求内容过长，请减少内容后重试');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      request.removeListener('data', data); request.removeListener('end', end);
      request.removeListener('aborted', aborted); request.removeListener('error', failed);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) { chunks = []; finish(new RequestError(413, 'BODY_TOO_LARGE', '请求内容过长，请减少内容后重试')); }
      else chunks.push(chunk);
    };
    const end = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        finish(null, JSON.parse(text));
      } catch { finish(invalid()); }
    };
    const aborted = () => finish(new RequestError(400, 'REQUEST_ABORTED', '请求未完整收到'));
    const failed = () => finish(invalid());
    const timer = setTimeout(() => finish(new RequestError(408, 'REQUEST_TIMEOUT', '请求接收超时，请稍后重试')), 5000);
    timer.unref();
    request.on('data', data); request.on('end', end); request.on('aborted', aborted); request.on('error', failed);
  });
}

class RateLimit {
  #entries = new Map();
  constructor({ max, windowMs }) { Object.assign(this, { max, windowMs }); }
  consume(address, now) {
    if (this.#entries.size >= 5000) for (const [key, value] of this.#entries) if (value.until <= now) this.#entries.delete(key);
    let entry = this.#entries.get(address);
    if (!entry || entry.until <= now) {
      if (!entry && this.#entries.size >= 5000) return Math.ceil(this.windowMs / 1000);
      entry = { count: 0, until: now + this.windowMs }; this.#entries.set(address, entry);
    }
    entry.count++;
    return entry.count > this.max ? Math.max(1, Math.ceil((entry.until - now) / 1000)) : 0;
  }
}

async function verifyPlatform(provider, input, timeoutMs) {
  let timer;
  const controller = new AbortController();
  try {
    const result = await Promise.race([Promise.resolve().then(() => provider({ ...input, signal: controller.signal })), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Provider timeout')); }, timeoutMs); timer.unref();
    })]);
    if (!result || typeof result.subject !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.subject)) throw new Error('Invalid provider identity');
    return result.subject;
  } catch (error) {
    if (error instanceof PlatformIdentityError) throw new RequestError(error.status, error.code, error.message);
    throw new RequestError(502, 'IDENTITY_PROVIDER_FAILED', '平台身份核验暂不可用，请稍后重新登录');
  }
  finally { clearTimeout(timer); controller.abort(); }
}

export function createApp(options = {}) {
  const config = normalizeConfig(options), store = new FarmStore(config);
  const loginLimit = new RateLimit(config.authLimit), requestLimit = new RateLimit(config.requestLimit);
  let closed = false;
  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, private'); response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Request-Id', requestId);
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Vary', 'Origin');
    const send = (status, payload) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status);
      response.end(status === 204 ? undefined : JSON.stringify({ ...payload, requestId }));
    };
    try {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (!config.allowedOrigins.has(origin)) throw new RequestError(403, 'ORIGIN_FORBIDDEN', '此来源未获访问许可');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
      }
      if (!request.url || request.url.length > 1024) throw invalid();
      const url = new URL(request.url, 'http://api.internal');
      if (url.search) throw invalid();
      const pathname = url.pathname;
      if (request.method === 'OPTIONS') {
        const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (!origin || !['GET', 'POST'].includes(request.headers['access-control-request-method']) ||
          requestedHeaders.some(name => !['authorization', 'content-type', 'idempotency-key'].includes(name))) {
          throw new RequestError(403, 'PREFLIGHT_FORBIDDEN', '此跨域请求未获访问许可');
        }
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
        send(204, {}); return;
      }
      const now = store.serverNow();
      const address = request.socket.remoteAddress ?? 'unknown';
      const wait = requestLimit.consume(address, now);
      if (wait) { response.setHeader('Retry-After', String(wait)); throw new RequestError(429, 'RATE_LIMITED', '操作较频繁，请稍后重试'); }
      if (pathname === '/healthz' && request.method === 'GET') { send(200, { data: { status: 'ok' } }); return; }
      if (!pathname.startsWith(PREFIX + '/')) throw new RequestError(404, 'NOT_FOUND', '请求的服务不存在');
      const route = pathname.slice(PREFIX.length);
      if (['/auth/development', '/auth/platform'].includes(route)) {
        if (request.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '此服务只接受POST请求');
        const authWait = loginLimit.consume(address, now);
        if (authWait) { response.setHeader('Retry-After', String(authWait)); throw new RequestError(429, 'RATE_LIMITED', '登录尝试较频繁，请稍后重试'); }
        const body = await jsonBody(request);
        if (route === '/auth/development') {
          if (!config.allowDevelopmentAuth || config.mode !== 'development') throw new RequestError(503, 'CAPABILITY_UNAVAILABLE', '当前环境不提供开发登录');
          object(body, ['account']);
          if (typeof body.account !== 'string' || !/^[A-Za-z0-9_-]{3,40}$/.test(body.account)) throw invalid();
          send(200, { data: store.createIdentity('development', body.account, store.serverNow()), message: '已进入开发沙盒，资产仅用于联调' }); return;
        }
        object(body, ['platform', 'code']);
        if (!['weixin', 'toutiao'].includes(body.platform) || typeof body.code !== 'string' || body.code.length < 1 || body.code.length > 4096 || /[\u0000-\u001f]/.test(body.code)) throw invalid();
        const provider = config.platformProviders[body.platform];
        if (!provider) throw new RequestError(503, 'CAPABILITY_UNAVAILABLE', '此平台身份服务尚未配置，请联系运营方');
        const namespace = typeof provider.identityNamespace === 'string' ? provider.identityNamespace : 'custom';
        const claimedCode = store.claimPlatformCode(body.platform, namespace, body.code, store.serverNow());
        if (!claimedCode) throw new RequestError(409, 'IDENTITY_CODE_USED', '这次平台登录凭证正在核验或已使用，请重新发起平台登录');
        try {
          const subject = await verifyPlatform(provider, { platform: body.platform, code: body.code }, config.providerTimeoutMs);
          const data = store.createIdentity(body.platform, subject, store.serverNow());
          store.finishPlatformCode(claimedCode, 'used', store.serverNow());
          send(200, { data }); return;
        } catch (error) { store.finishPlatformCode(claimedCode, 'failed', store.serverNow()); throw error; }
      }
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      const userId = store.authenticate(token, now);
      if (!userId) throw new RequestError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
      const refreshSession = () => {
        const instant = store.serverNow();
        if (store.authenticate(token, instant) !== userId) throw new RequestError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
        return instant;
      };
      if (route === '/bootstrap') {
        if (request.method !== 'GET') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '此服务只接受GET请求');
        send(200, { data: store.bootstrap(userId, now) }); return;
      }
      if (route === '/auth/logout') {
        if (request.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '此服务只接受POST请求');
        const body = await jsonBody(request); object(body, []);
        store.logout(token, refreshSession()); send(200, { data: { loggedOut: true }, message: '已退出当前会话' }); return;
      }
      const routes = new Map([
        ['/cart/items', { type: 'cart', required: ['sku', 'delta', 'expectedRevision'] }],
        ['/checkout', { type: 'checkout', required: ['expectedRevision'], optional: ['couponId'] }],
        ['/events/shop-visit', { type: 'shop-visit', required: ['expectedRevision'] }],
        ['/activities/sign-in', { type: 'sign-in', required: ['expectedRevision'] }],
        ['/activities/season/claim', { type: 'season', required: ['expectedRevision'] }],
      ]);
      let operation = routes.get(route);
      const task = /^\/activities\/tasks\/([A-Za-z0-9_-]{1,64})\/claim$/.exec(route);
      const achievement = /^\/activities\/achievements\/([A-Za-z0-9_-]{1,64})\/claim$/.exec(route);
      if (task) operation = { type: 'task', taskId: task[1], required: ['expectedRevision'] };
      if (achievement) operation = { type: 'achievement', achievementId: achievement[1], required: ['expectedRevision'] };
      if (!operation) throw new RequestError(404, 'NOT_FOUND', '请求的服务不存在');
      if (request.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '此服务只接受POST请求');
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !SAFE_ID.test(idempotencyKey)) throw invalid();
      const body = await jsonBody(request); object(body, operation.required, operation.optional);
      if (!safeInt(body.expectedRevision)) throw invalid();
      if (operation.type === 'cart' && (typeof body.sku !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.sku) || !Number.isSafeInteger(body.delta) || !body.delta)) throw invalid();
      if (Object.hasOwn(body, 'couponId') && (typeof body.couponId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.couponId))) throw invalid();
      const fingerprint = createHash('sha256').update(request.method + '\n' + pathname + '\n' + JSON.stringify(canonical(body))).digest('hex');
      const result = store.mutate(userId, idempotencyKey, fingerprint, body.expectedRevision, { ...operation, ...body }, refreshSession());
      send(result.status, result.error ? { error: result.error, data: result.data } : { data: result.data, message: result.message, replayed: result.replayed });
    } catch (error) {
      if (error instanceof RequestError) send(error.status, { error: { code: error.code, message: error.message } });
      else send(500, { error: { code: 'INTERNAL_ERROR', message: '服务暂不可用，请稍后重试；可向运营方提供请求编号' } });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50; server.maxRequestsPerSocket = 100;
  return { server, store, close: async () => {
    if (closed) return;
    closed = true;
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configuration = configFromEnvironment(), app = createApp(configuration);
    app.server.listen(configuration.port, configuration.host, () => {
      process.stdout.write(`Farm API ready at ${configuration.host}:${configuration.port} (${configuration.mode})\n`);
    });
    app.server.on('error', () => { process.stderr.write('Farm API failed to start; verify server configuration.\n'); process.exitCode = 1; app.store.close(); });
    const shutdown = async () => { await app.close(); process.exitCode = 0; };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch { process.stderr.write('Farm API configuration is invalid; no service started.\n'); process.exitCode = 1; }
}
