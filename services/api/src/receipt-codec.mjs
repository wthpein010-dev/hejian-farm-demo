import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const ENCODING = 'deflate-raw-v1';
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_COMPRESS_BYTES / 3) * 4;
const ENVELOPE_KEYS = ['payload', 'receiptEncoding', 'sha256', 'utf8Bytes'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const envelopeLike = value => Object.hasOwn(value, 'receiptEncoding') ||
  ['payload', 'sha256', 'utf8Bytes'].every(key => Object.hasOwn(value, key));

export class ReceiptCodecError extends Error {
  constructor() { super('回执编码数据无效'); this.name = 'ReceiptCodecError'; }
}

function parseObject(text) {
  const value = JSON.parse(text);
  if (!object(value)) throw new ReceiptCodecError();
  return value;
}

export function encodeReceipt(snapshot) {
  try {
    if (!object(snapshot) || envelopeLike(snapshot)) throw new ReceiptCodecError();
    // Serialize exactly once: this text is the historical result being stored.
    const text = JSON.stringify(snapshot);
    if (typeof text !== 'string' || envelopeLike(parseObject(text))) throw new ReceiptCodecError();
    const bytes = Buffer.byteLength(text);
    // This is a compression work budget, not a new receipt-size restriction.
    // Larger existing results keep the legacy JSON representation unchanged.
    if (bytes < MIN_COMPRESS_BYTES || bytes > MAX_COMPRESS_BYTES) return text;
    const original = Buffer.from(text);
    const compressed = deflateRawSync(original, { level: 1 });
    const envelope = JSON.stringify({ receiptEncoding: ENCODING, utf8Bytes: bytes,
      sha256: digest(original), payload: compressed.toString('base64') });
    return Buffer.byteLength(envelope) < bytes ? envelope : text;
  } catch { throw new ReceiptCodecError(); }
}

export function decodeReceipt(text, options = {}) {
  try {
    if (typeof text !== 'string' || !object(options) ||
      (options.allowCompressed !== undefined && typeof options.allowCompressed !== 'boolean')) throw new ReceiptCodecError();
    const value = parseObject(text);
    if (!envelopeLike(value)) return value;
    if (options.allowCompressed === false || value.receiptEncoding !== ENCODING ||
      Object.keys(value).length !== ENVELOPE_KEYS.length || ENVELOPE_KEYS.some(key => !Object.hasOwn(value, key)) ||
      !Number.isSafeInteger(value.utf8Bytes) || value.utf8Bytes < 1 || value.utf8Bytes > MAX_COMPRESS_BYTES ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.payload !== 'string' || !value.payload.length || value.payload.length > MAX_BASE64_LENGTH || value.payload.length % 4) {
      throw new ReceiptCodecError();
    }
    const compressed = Buffer.from(value.payload, 'base64');
    // Re-encoding also rejects whitespace, URL-safe aliases and nonzero unused
    // padding bits, which Buffer.from alone would otherwise silently accept.
    if (!compressed.length || compressed.length > MAX_COMPRESS_BYTES || compressed.toString('base64') !== value.payload) {
      throw new ReceiptCodecError();
    }
    const decoded = inflateRawSync(compressed, { info: true, maxOutputLength: value.utf8Bytes });
    if (decoded.engine.bytesWritten !== compressed.length || decoded.buffer.length !== value.utf8Bytes ||
      digest(decoded.buffer) !== value.sha256) throw new ReceiptCodecError();
    // Preserve a BOM instead of stripping it: JSON.parse must see the original
    // decoded content. Invalid byte sequences never become replacement text.
    const snapshot = parseObject(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded.buffer));
    if (envelopeLike(snapshot)) throw new ReceiptCodecError();
    return snapshot;
  } catch { throw new ReceiptCodecError(); }
}
