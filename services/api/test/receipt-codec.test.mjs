import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

let codec = {};
try { codec = await import('../src/receipt-codec.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const MAX_BYTES = 8 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function requireCodec() {
  assert.equal(typeof codec.encodeReceipt, 'function', 'lossless receipt encoder must exist');
  assert.equal(typeof codec.decodeReceipt, 'function', 'lossless receipt decoder must exist');
}
function envelopeFor(bytes, overrides = {}) {
  return { receiptEncoding: 'deflate-raw-v1', utf8Bytes: bytes.length, sha256: sha(bytes),
    payload: deflateRawSync(bytes, { level: 1 }).toString('base64'), ...overrides };
}
function rejects(text, options) {
  requireCodec();
  assert.throws(() => codec.decodeReceipt(text, options), error => {
    assert.ok(error instanceof codec.ReceiptCodecError);
    assert.equal(error.name, 'ReceiptCodecError');
    assert.equal(error.message, '回执编码数据无效');
    assert.equal(error.cause, undefined);
    return true;
  });
}
function snapshotFixture() {
  return { serverTime: 1793088000000, revision: 12, environment: 'development',
    profile: { id: 'receipt-fixture', displayName: '田园体验者' }, wallet: { points: 40, feed: 12 },
    system: { cart: {}, inventory: { fertilizer: 2, tools: 1 },
      purchases: [{ id: 'first-purchase', count: 2, subtotal: 60, discount: 20, total: 40,
        items: [{ id: 'feed-pack', title: '日常饲料包', quantity: 2, lineTotal: 60 }] }],
      daily: { day: '2026-10-27', bought: { 'feed-pack': 2 } } },
    catalog: Array.from({ length: 8 }, (_, i) => ({ id: `product-${i}`, title: '田园日常物资', cost: 30,
      category: 'supplies', description: '按需照料，不改变次数、间隔和设备确认。', limit: 5, art: 'feed' })),
    tasks: Array.from({ length: 3 }, (_, i) => ({ id: `task-${i}`, title: '完成今日农事', description: '以农场回执记录为准',
      reward: { points: 10 }, progress: 0, target: 1, claimed: false, ready: false })),
    signIn: { streak: 1, todayClaimed: true }, season: { count: 0, total: 3 }, achievements: [],
    level: { level: 3, label: '勤耕生活家', xp: 120 }, farm: { plots: [], animals: [] },
    capabilities: { pointShop: true, activities: true, care: false, adoption: false } };
}

test('legacy object JSON remains readable as an isolated object in either schema mode', () => {
  requireCodec();
  const original = { profile: { id: 'legacy-user', displayName: '种植者🌾' }, wallet: { points: 80, feed: 6 }, memo: '田\n园' };
  const text = JSON.stringify(original);
  for (const allowCompressed of [true, false]) {
    const decoded = codec.decodeReceipt(text, { allowCompressed });
    assert.deepEqual(decoded, original); decoded.wallet.points = 0;
  }
  assert.equal(original.wallet.points, 80);
});

test('small receipts stay raw JSON without envelope overhead', () => {
  requireCodec();
  const snapshot = { revision: 0, wallet: { points: 80, feed: 6 } };
  assert.equal(codec.encodeReceipt(snapshot), '{"revision":0,"wallet":{"points":80,"feed":6}}');
});

test('a representative historical snapshot compacts materially and round-trips every field', () => {
  requireCodec();
  const original = snapshotFixture(), raw = Buffer.from(JSON.stringify(original));
  const text = codec.encodeReceipt(original), envelope = JSON.parse(text);
  assert.deepEqual(Object.keys(envelope).sort(), ['payload', 'receiptEncoding', 'sha256', 'utf8Bytes']);
  assert.equal(envelope.receiptEncoding, 'deflate-raw-v1');
  assert.equal(envelope.utf8Bytes, raw.length); assert.equal(envelope.sha256, sha(raw));
  assert.ok(Buffer.byteLength(text) < raw.length * 0.7, 'sample storage must be reduced by at least 30 percent');
  assert.deepEqual(inflateRawSync(Buffer.from(envelope.payload, 'base64')), raw);
  assert.deepEqual(codec.decodeReceipt(text), original);
});

test('compression eligibility uses UTF-8 bytes and includes the 1024-byte boundary', () => {
  requireCodec();
  const below = { memo: 'x'.repeat(1012) }, boundary = { memo: 'x'.repeat(1013) };
  assert.equal(Buffer.byteLength(JSON.stringify(below)), 1023);
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 1024);
  assert.equal(codec.encodeReceipt(below), JSON.stringify(below));
  assert.equal(JSON.parse(codec.encodeReceipt(boundary)).receiptEncoding, 'deflate-raw-v1');
  const multibyte = { memo: '禾'.repeat(400) };
  assert.ok(JSON.stringify(multibyte).length < 1024);
  assert.equal(JSON.parse(codec.encodeReceipt(multibyte)).receiptEncoding, 'deflate-raw-v1');
  assert.deepEqual(codec.decodeReceipt(codec.encodeReceipt(multibyte)), multibyte);
});

test('incompressible receipts retain the smaller original JSON', () => {
  requireCodec();
  const memo = Array.from({ length: 40 }, (_, i) => createHash('sha256').update(`fixture-${i}`).digest('base64')).join('');
  const snapshot = { memo }, raw = JSON.stringify(snapshot);
  const attempted = JSON.stringify(envelopeFor(Buffer.from(raw)));
  assert.ok(Buffer.byteLength(attempted) >= Buffer.byteLength(raw), 'fixture must exercise the raw fallback');
  assert.equal(codec.encodeReceipt(snapshot), raw);
});

test('8 MiB is an encoding budget rather than a new business size restriction', () => {
  requireCodec();
  const boundary = { memo: 'x'.repeat(MAX_BYTES - 11) };
  const compact = codec.encodeReceipt(boundary);
  assert.equal(JSON.parse(compact).utf8Bytes, MAX_BYTES);
  assert.deepEqual(codec.decodeReceipt(compact), boundary);
  const oversized = { memo: 'x'.repeat(MAX_BYTES - 10) }, raw = JSON.stringify(oversized);
  assert.equal(Buffer.byteLength(raw), MAX_BYTES + 1);
  assert.equal(codec.encodeReceipt(oversized), raw);
  assert.deepEqual(codec.decodeReceipt(raw), oversized);
});

test('legacy schema decoding refuses compressed envelopes explicitly', () => {
  requireCodec();
  const text = codec.encodeReceipt(snapshotFixture());
  rejects(text, { allowCompressed: false });
  assert.deepEqual(codec.decodeReceipt('{"revision":1}', { allowCompressed: false }), { revision: 1 });
});

test('invalid input, non-object JSON and malformed text produce only a fixed safe codec error', () => {
  for (const value of [null, undefined, 7, {}, [], 'null', '[]', '42', '"private-fixture"', '{private-fixture']) rejects(value);
});

test('encoding cannot produce unreadable receipts from cycles, reserved envelopes or non-object serialization', () => {
  requireCodec();
  const cycle = {}; cycle.self = cycle;
  for (const value of [null, [], new Date(0), { receiptEncoding: 'unexpected-private-fixture' }, { amount: 1n }, cycle,
    { toJSON() { return []; } }, { toJSON() { return { receiptEncoding: 'private-fixture' }; } },
    { utf8Bytes: 2, sha256: '0'.repeat(64), payload: 'AAAA' }]) {
    assert.throws(() => codec.encodeReceipt(value), error => error instanceof codec.ReceiptCodecError && error.message === '回执编码数据无效');
  }
});

test('envelope shape, version, integer budget and digest metadata are strict', () => {
  const source = envelopeFor(Buffer.from('{"memo":"valid"}'));
  for (const patch of [{ receiptEncoding: 'unknown-private-fixture' }, { extra: true }, { utf8Bytes: 0 },
    { utf8Bytes: 1.5 }, { utf8Bytes: MAX_BYTES + 1 }, { utf8Bytes: '16' }, { sha256: 'A'.repeat(64) },
    { sha256: null }, { payload: [] }, { payload: '' }]) rejects(JSON.stringify({ ...source, ...patch }));
  for (const key of Object.keys(source)) { const missing = { ...source }; delete missing[key]; rejects(JSON.stringify(missing)); }
});

test('base64 must be canonical, including padding bits, with a bounded encoded input', () => {
  const source = envelopeFor(Buffer.from('{}'));
  assert.ok(source.payload.endsWith('AA=='));
  const noncanonical = source.payload.slice(0, -3) + 'B==';
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), Buffer.from(source.payload, 'base64'));
  for (const payload of [source.payload + '\n', ' ' + source.payload, source.payload.slice(0, -1), noncanonical,
    '_w==', 'AAAA=AAA', 'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 4)]) rejects(JSON.stringify({ ...source, payload }));
});

test('corrupt, truncated and trailing compressed content cannot masquerade as a valid receipt', () => {
  const source = envelopeFor(Buffer.from('{"memo":"private-fixture"}'));
  const packed = Buffer.from(source.payload, 'base64');
  const corrupt = Buffer.from(packed); corrupt[0] ^= 255;
  for (const bytes of [corrupt, packed.subarray(0, -1), Buffer.concat([packed, Buffer.from('private-trailing-fixture')]),
    Buffer.concat([packed, deflateRawSync(Buffer.from('{}'))])]) rejects(JSON.stringify({ ...source, payload: bytes.toString('base64') }));
});

test('decoded byte length and SHA-256 both have to match the stored original', () => {
  const source = envelopeFor(Buffer.from('{"memo":"original"}'));
  rejects(JSON.stringify({ ...source, utf8Bytes: source.utf8Bytes + 1 }));
  rejects(JSON.stringify({ ...source, sha256: '0'.repeat(64) }));
  rejects(JSON.stringify({ ...source, payload: deflateRawSync(Buffer.from('{"memo":"modified"}')).toString('base64') }));
});

test('expansion beyond the declared decoded budget is rejected instead of allocating the full payload', () => {
  const bytes = Buffer.from('{"memo":"' + 'x'.repeat(1024 * 1024) + '"}');
  rejects(JSON.stringify(envelopeFor(bytes, { utf8Bytes: 32 })));
  rejects(JSON.stringify(envelopeFor(Buffer.from('{}'), { utf8Bytes: MAX_BYTES + 1 })));
});

test('fatal UTF-8 decoding rejects malformed sequences even when size and checksum match', () => {
  const invalid = Buffer.concat([Buffer.from('{"memo":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  rejects(JSON.stringify(envelopeFor(invalid)));
});

test('decompressed JSON must remain an object with no silently stripped BOM', () => {
  for (const text of ['[]', 'null', '"private-fixture"', 'broken-private-fixture']) rejects(JSON.stringify(envelopeFor(Buffer.from(text))));
  rejects(JSON.stringify(envelopeFor(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]))));
});

test('one serialization captures the original result even when serialization has a side effect', () => {
  requireCodec(); let calls = 0;
  const value = { toJSON() { return { captured: ++calls, memo: '田园'.repeat(600) }; } };
  const encoded = codec.encodeReceipt(value);
  assert.equal(calls, 1); assert.deepEqual(codec.decodeReceipt(encoded), { captured: 1, memo: '田园'.repeat(600) });
});
