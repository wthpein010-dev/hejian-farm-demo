import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let support = {};
try { support = await import('../test-support/listen-http.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

async function bind(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
}

test('test listener only accepts valid ports outside the Fetch standard denylist', () => {
  assert.equal(typeof support.isFetchPortAllowed, 'function', 'Fetch-safe test listener must exist');
  for (const port of [6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080, 22, 0, -1, 65536]) {
    assert.equal(support.isFetchPortAllowed(port), false, String(port));
  }
  for (const port of [80, 443, 3923, 49152, 65535]) assert.equal(support.isFetchPortAllowed(port), true, String(port));
});

test('real forbidden HTTP allocation is replaced while Fetch port blocking remains enabled', async t => {
  assert.equal(typeof support.listenOnFetchSafePort, 'function', 'Fetch-safe test listener must exist');
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('safe-http-listener'); });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  let forbiddenPort;
  for (const candidate of [6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]) {
    try { await bind(server, candidate); forbiddenPort = candidate; break; }
    catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
  }
  assert.ok(forbiddenPort, 'one test-only forbidden port must be available');
  await assert.rejects(fetch(`http://127.0.0.1:${forbiddenPort}`), error => error.cause?.message === 'bad port');
  assert.equal(requests, 0, 'Fetch rejected before sending a network request');
  const selected = await support.listenOnFetchSafePort(server);
  assert.notEqual(selected, forbiddenPort); assert.equal(support.isFetchPortAllowed(selected), true);
  const response = await fetch(`http://127.0.0.1:${selected}`);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'safe-http-listener');
  assert.equal(requests, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${forbiddenPort}`), error => error.cause?.message === 'bad port');
});

test('real ephemeral listeners can close and restart without retaining rejected error listeners', async t => {
  assert.equal(typeof support.listenOnFetchSafePort, 'function', 'Fetch-safe test listener must exist');
  const server = http.createServer((_request, response) => response.end('restarted'));
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  for (let restart = 0; restart < 12; restart++) {
    const port = await support.listenOnFetchSafePort(server);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'restarted');
    assert.equal(server.listenerCount('error'), 0);
    await new Promise(resolve => server.close(resolve));
  }
});
