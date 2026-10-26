import { isIP } from 'node:net';

const CONFIG_ERROR = '可信代理配置无效';
const MAX_TRUSTED_NETWORKS = 32;
const MAX_FORWARDED_HOPS = 32;
const MAX_FORWARDED_LENGTH = 2048;

export class ClientAddressError extends Error {
  constructor() { super('代理来源信息无效'); this.name = 'ClientAddressError'; }
}

function formatIPv6(groups) {
  let start = -1, length = 0;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) { i++; continue; }
    const at = i;
    while (i < groups.length && groups[i] === 0) i++;
    if (i - at > length && i - at >= 2) { start = at; length = i - at; }
  }
  const text = groups.map(value => value.toString(16));
  return start < 0 ? text.join(':') : text.slice(0, start).join(':') + '::' + text.slice(start + length).join(':');
}

function parseAddress(input) {
  if (typeof input !== 'string' || input.length > 45 || input.includes('%')) return null;
  const family = isIP(input);
  if (!family) return null;
  if (family === 4) {
    const value = input.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
    return { family: 4, bits: 32, value, text: input, mapped: false };
  }
  let expanded = input;
  if (input.includes('.')) {
    const end = input.lastIndexOf(':'), bytes = input.slice(end + 1).split('.').map(Number);
    expanded = input.slice(0, end + 1) + ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const sections = expanded.split('::');
  const left = sections[0] ? sections[0].split(':') : [];
  const right = sections.length > 1 && sections[1] ? sections[1].split(':') : [];
  const groups = (sections.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]).map(part => parseInt(part, 16));
  const value = groups.reduce((n, part) => (n << 16n) | BigInt(part), 0n);
  // Normalize both dotted and hexadecimal mapped spellings before trust lookup.
  if ((value >> 32n) === 0xffffn) {
    const mapped = value & 0xffffffffn;
    const bytes = [24n, 16n, 8n, 0n].map(shift => Number((mapped >> shift) & 255n));
    return { family: 4, bits: 32, value: mapped, text: bytes.join('.'), mapped: true };
  }
  return { family: 6, bits: 128, value, text: formatIPv6(groups), mapped: false };
}

function network(input) {
  if (typeof input !== 'string') throw new TypeError(CONFIG_ERROR);
  const parts = input.split('/');
  const address = parseAddress(parts[0]);
  // IPv4-mapped configuration is deliberately rejected. Configure its IPv4
  // network instead, matching the normalized socket and forwarded addresses.
  if (!address || address.mapped || parts.length > 2) throw new TypeError(CONFIG_ERROR);
  const prefix = parts.length === 1 ? address.bits : /^[1-9][0-9]*$/.test(parts[1]) ? Number(parts[1]) : 0;
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > address.bits) throw new TypeError(CONFIG_ERROR);
  const shift = BigInt(address.bits - prefix);
  if ((address.value & ((1n << shift) - 1n)) !== 0n) throw new TypeError(CONFIG_ERROR);
  return { family: address.family, shift, value: address.value >> shift, key: `${address.family}:${address.value}:${prefix}` };
}

function forwardedAddresses(request) {
  const raw = request.rawHeaders ?? [];
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new ClientAddressError();
  let occurrences = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (typeof raw[i] !== 'string' || typeof raw[i + 1] !== 'string') throw new ClientAddressError();
    if (raw[i].toLowerCase() === 'x-forwarded-for') occurrences++;
  }
  const header = request.headers?.['x-forwarded-for'];
  if (header === undefined && occurrences === 0) return [];
  if (occurrences !== 1 || typeof header !== 'string' || !header.length || header.length > MAX_FORWARDED_LENGTH) throw new ClientAddressError();
  const tokens = header.split(',');
  if (tokens.length > MAX_FORWARDED_HOPS) throw new ClientAddressError();
  return tokens.map(token => {
    // HTTP OWS is SP/HTAB only. Quotes, brackets, ports, zones, control chars
    // and Unicode whitespace are not accepted as alternate address syntax.
    if (!/^[ \t]*[0-9a-fA-F:.]+[ \t]*$/.test(token)) throw new ClientAddressError();
    const address = parseAddress(token.replace(/^[ \t]+|[ \t]+$/g, ''));
    if (!address) throw new ClientAddressError();
    return address;
  });
}

export function createClientAddressResolver(cidrs = []) {
  if (!Array.isArray(cidrs) || cidrs.length > MAX_TRUSTED_NETWORKS) throw new TypeError(CONFIG_ERROR);
  const networks = Array.from(cidrs, network);
  if (new Set(networks.map(item => item.key)).size !== networks.length) throw new TypeError(CONFIG_ERROR);
  const trusted = address => networks.some(item => item.family === address.family && (address.value >> item.shift) === item.value);
  return request => {
    let address = parseAddress(request?.socket?.remoteAddress);
    if (!address) throw new ClientAddressError();
    // Untrusted peers cannot opt themselves into forwarding, even by sending
    // malformed or repeated headers. The default empty configuration is safe.
    if (!trusted(address)) return address.text;
    const chain = forwardedAddresses(request);
    for (let i = chain.length - 1; i >= 0 && trusted(address); i--) address = chain[i];
    return address.text;
  };
}
