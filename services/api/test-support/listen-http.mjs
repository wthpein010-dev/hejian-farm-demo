// Test-only TCP allocation. Keep Fetch's own port blocking enabled.
// https://fetch.spec.whatwg.org/#port-blocking
// This table also matches Node 24.15.0's bundled Undici badPorts set.
const forbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
  4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

export function isFetchPortAllowed(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535 && !forbiddenPorts.has(port);
}

async function bindEphemeral(server, host) {
  await new Promise((resolve, reject) => {
    const clean = () => { server.off('error', failed); server.off('listening', ready); };
    const failed = error => { clean(); reject(error); };
    const ready = () => { clean(); resolve(); };
    server.once('error', failed); server.once('listening', ready);
    try { server.listen(0, host); } catch (error) { failed(error); }
  });
}

export async function listenOnFetchSafePort(server, { host = '127.0.0.1', maxAttempts = 32 } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 256) throw new TypeError('Test listener allocation limit is invalid');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!server.listening) await bindEphemeral(server, host);
    const address = server.address();
    if (!address || typeof address === 'string') throw new TypeError('Test listener must use a TCP port');
    if (isFetchPortAllowed(address.port)) return address.port;
    // A host may allocate ports such as 6000 inside its dynamic range. Release
    // that unused listener and ask the OS again rather than weakening Fetch.
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('Unable to allocate a Fetch-compatible test port');
}
