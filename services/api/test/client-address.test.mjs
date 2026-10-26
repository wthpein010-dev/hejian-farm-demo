import test from 'node:test';
import assert from 'node:assert/strict';

let implementation = {};
try { implementation = await import('../src/client-address.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function resolver(cidrs = []) {
  assert.equal(typeof implementation.createClientAddressResolver, 'function', 'trusted proxy resolver must exist');
  return implementation.createClientAddressResolver(cidrs);
}
function request(peer = '127.0.0.1', forwarded, options = {}) {
  return { socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    rawHeaders: forwarded === undefined ? [] : ['X-Forwarded-For', forwarded], ...options };
}
function rejectsAddress(resolve, input) {
  assert.throws(() => resolve(input), error => {
    assert.ok(error instanceof implementation.ClientAddressError);
    assert.equal(error.message, '代理来源信息无效');
    assert.equal(error.name, 'ClientAddressError');
    return true;
  });
}

test('default resolver normalizes socket addresses and never reads forwarding headers', () => {
  const resolve = resolver();
  const cases = [
    ['192.0.2.7', '192.0.2.7'], ['::ffff:192.0.2.7', '192.0.2.7'],
    ['0:0:0:0:0:ffff:c000:207', '192.0.2.7'],
    ['2001:0DB8:0000:0000:0001:0000:0000:0007', '2001:db8::1:0:0:7'],
    ['2001:db8:0:1:0:0:0:0', '2001:db8:0:1::'], ['::', '::'], ['::1', '::1'],
    ['2001:db8::192.0.2.7', '2001:db8::c000:207'],
  ];
  for (const [peer, expected] of cases) {
    const input = { socket: { remoteAddress: peer }, get headers() { throw Error('must not read'); }, get rawHeaders() { throw Error('must not read'); } };
    assert.equal(resolve(input), expected);
  }
});

test('explicit trust uses X-Forwarded-For only for a trusted socket peer', () => {
  const resolve = resolver(['127.0.0.1']);
  assert.equal(resolve(request('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('127.0.0.2', '198.51.100.7')), '127.0.0.2');
  assert.equal(resolve(request('127.0.0.2', ['malformed', 'headers'], { rawHeaders: ['X-Forwarded-For', 'a', 'x-forwarded-for', 'b'] })), '127.0.0.2');
  assert.equal(resolve(request('127.0.0.1')), '127.0.0.1');
  assert.equal(resolve(request('127.0.0.1', undefined, { headers: { forwarded: 'for=203.0.113.10', 'x-real-ip': '203.0.113.11' } })), '127.0.0.1');
});

test('walks right to left and stops at the first untrusted hop instead of trusting the leftmost prefix', () => {
  const resolve = resolver(['10.0.0.0/8', '192.0.2.0/24']);
  assert.equal(resolve(request('10.1.2.3', '198.51.100.7, 192.0.2.12')), '198.51.100.7');
  assert.equal(resolve(request('10.1.2.3', '203.0.113.90, 198.51.100.7, 192.0.2.12')), '198.51.100.7');
  assert.equal(resolve(request('10.1.2.3', '203.0.113.90, 198.51.100.7, 198.51.100.8')), '198.51.100.8');
  assert.equal(resolve(request('10.1.2.3', '10.20.30.40, 192.0.2.12')), '10.20.30.40');
});

test('IPv4 mapped peers and forwarded hops share the same IPv4 trust and rate-limit key', () => {
  const resolve = resolver(['127.0.0.1/32', '192.0.2.0/24']);
  assert.equal(resolve(request('::ffff:127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('0:0:0:0:0:ffff:7f00:1', '::ffff:c000:20c')), '192.0.2.12');
  assert.equal(resolve(request('127.0.0.1', '198.51.100.7, ::ffff:192.0.2.12')), '198.51.100.7');
});

test('IPv4 CIDR compares real network boundaries including /31 and exact /32', () => {
  const resolve = resolver(['192.0.2.0/31', '198.51.100.7/32']);
  assert.equal(resolve(request('192.0.2.0', '203.0.113.9')), '203.0.113.9');
  assert.equal(resolve(request('192.0.2.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(resolve(request('192.0.2.2', '203.0.113.9')), '192.0.2.2');
  assert.equal(resolve(request('198.51.100.7', '203.0.113.9')), '203.0.113.9');
  assert.equal(resolve(request('198.51.100.8', '203.0.113.9')), '198.51.100.8');
});

test('IPv6 CIDR compares binary network boundaries and canonicalizes alternate spelling', () => {
  const resolve = resolver(['2001:db8:1::/64', '2001:db8:2::2/127', '::1/128']);
  assert.equal(resolve(request('2001:0DB8:1:0:ffff:ffff:ffff:ffff', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('2001:db8:1:1::', '198.51.100.7')), '2001:db8:1:1::');
  assert.equal(resolve(request('2001:db8:2::2', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('2001:db8:2::3', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('2001:db8:2::4', '198.51.100.7')), '2001:db8:2::4');
  assert.equal(resolve(request('::1', '2001:0db8::0001,2001:db8:1::9')), '2001:db8::1');
});

test('a trusted header accepts only bare IP tokens with HTTP optional whitespace', () => {
  const resolve = resolver(['127.0.0.1']);
  assert.equal(resolve(request('127.0.0.1', ' \t2001:0DB8::0007\t ')), '2001:db8::7');
  const invalid = ['', ' ', ',198.51.100.7', '198.51.100.7,', '198.51.100.7,,192.0.2.1',
    'unknown', 'localhost', '198.51.100.7:123', '[2001:db8::1]', '[2001:db8::1]:443',
    '"198.51.100.7"', 'for=198.51.100.7', '192.168.01.1', 'fe80::1%eth0',
    '\n198.51.100.7', '198.51.100.7\r', '\u00a0198.51.100.7', '198.51.100.7;proto=https'];
  for (const value of invalid) rejectsAddress(resolve, request('127.0.0.1', value));
  for (const value of [null, 17, ['198.51.100.7'], {}]) rejectsAddress(resolve, request('127.0.0.1', value));
});

test('validates the entire bounded header even when an untrusted right-hand hop stops traversal', () => {
  const resolve = resolver(['127.0.0.1']);
  rejectsAddress(resolve, request('127.0.0.1', 'invalid-secret-token,198.51.100.7'));
  rejectsAddress(resolve, request('127.0.0.1', '203.0.113.1,'.repeat(32) + '198.51.100.7'));
});

test('rejects duplicate raw X-Forwarded-For fields regardless of case or parser coalescing', () => {
  const resolve = resolver(['127.0.0.1']);
  rejectsAddress(resolve, request('127.0.0.1', '198.51.100.7, 198.51.100.8', {
    rawHeaders: ['Host', 'localhost', 'X-Forwarded-For', '198.51.100.7', 'x-FoRwArDeD-fOr', '198.51.100.8'],
  }));
  rejectsAddress(resolve, request('127.0.0.1', '198.51.100.7', { rawHeaders: [] }));
  rejectsAddress(resolve, request('127.0.0.1', '198.51.100.7', { rawHeaders: null }));
  rejectsAddress(resolve, request('127.0.0.1', undefined, { rawHeaders: ['X-Forwarded-For', ''] }));
});

test('enforces exactly the configured hop and header-size budgets', () => {
  const resolve = resolver(['127.0.0.1']);
  const hops = Array.from({ length: 32 }, (_, i) => `198.51.100.${i + 1}`).join(', ');
  assert.equal(resolve(request('127.0.0.1', hops)), '198.51.100.32');
  rejectsAddress(resolve, request('127.0.0.1', hops + ', 198.51.100.33'));
  const atLimit = '198.51.100.7'.padEnd(2048, ' ');
  assert.equal(resolve(request('127.0.0.1', atLimit)), '198.51.100.7');
  rejectsAddress(resolve, request('127.0.0.1', atLimit + ' '));
});

test('configuration is an explicit bounded array of canonical networks, never names or arbitrary masks', () => {
  resolver(['10.0.0.0/8', '2001:db8::/32']);
  assert.throws(() => resolver(Array(1)), TypeError);
  assert.throws(() => resolver(['127.0.0.1', , '192.0.2.1']), TypeError);
  for (const invalid of [null, '127.0.0.1', {}, true, ['*'], ['0.0.0.0/0'], ['::/0'],
    ['10.0.0.1/8'], ['2001:db8::1/32'], ['10.0.0.0/33'], ['2001:db8::/129'],
    ['10.0.0.0/-1'], ['10.0.0.0/08'], ['10.0.0.0/8/8'], ['10.0.0.0/255.0.0.0'],
    ['127.0.0.1:443'], ['[::1]'], ['fe80::%lo/64'], ['localhost'], [' 127.0.0.1'],
    ['::ffff:192.0.2.0/120'], ['::ffff:c000:200/120'], [3], ['']]) {
    assert.throws(() => resolver(invalid), error => error instanceof TypeError && error.message === '可信代理配置无效');
  }
  const thirtyTwo = Array.from({ length: 32 }, (_, i) => `198.51.100.${i}`);
  resolver(thirtyTwo);
  assert.throws(() => resolver([...thirtyTwo, '203.0.113.1']), TypeError);
});

test('duplicate configurations are rejected after canonical network normalization and arrays are copied', () => {
  for (const cidrs of [['127.0.0.1', '127.0.0.1/32'], ['2001:db8::/32', '2001:0DB8:0:0:0:0:0:0/32'], ['::1', '0:0:0:0:0:0:0:1/128']]) {
    assert.throws(() => resolver(cidrs), TypeError);
  }
  const configuration = ['127.0.0.1']; const resolve = resolver(configuration);
  configuration[0] = '198.51.100.1'; configuration.push('192.0.2.0/24');
  assert.equal(resolve(request('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(resolve(request('192.0.2.1', '203.0.113.9')), '192.0.2.1');
});

test('invalid socket addresses fail closed with a fixed non-sensitive error', () => {
  const resolve = resolver();
  for (const peer of [undefined, null, '', 'unknown-sensitive-value', 'fe80::1%eth0', '127.0.0.1:40', '[::1]']) {
    rejectsAddress(resolve, { socket: { remoteAddress: peer }, headers: {}, rawHeaders: [] });
  }
});
