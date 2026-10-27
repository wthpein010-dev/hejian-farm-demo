export class PlatformIdentityError extends Error {
  constructor(status) {
    super(status === 401 ? '平台登录凭证无效，请重新发起登录' : '平台身份核验暂不可用，请稍后重新登录');
    this.name = 'PlatformIdentityError';
    this.status = status === 401 ? 401 : 502;
    this.code = status === 401 ? 'PLATFORM_CODE_REJECTED' : 'IDENTITY_PROVIDER_FAILED';
  }
}

const unavailable = () => new PlatformIdentityError(502);

// This reader is shared by the separate mini-program and native OAuth adapters.
// It does not retain upstream errors or return the response outside the adapter.
export async function limitedJSON(response, signal, limit) {
  if (!response || response.status !== 200) {
    if (response?.body) void response.body.cancel().catch(() => {});
    throw unavailable();
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) { abort(); throw unavailable(); }
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw unavailable();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { abort(); throw unavailable(); }
      chunks.push(Buffer.from(value));
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
    return parsed;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
