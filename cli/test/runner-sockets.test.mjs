import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import test from 'node:test';

import { startTestRunner } from '@web/test-runner';
import WebSocket from 'ws';

import { admitsRunnerUpgrade } from '../testing/runner-sockets.mjs';
import { testRunnerConfig } from '../testing/web-test-runner.mjs';

/**
 * @param {{ peer?: string, host?: string, origin?: string }} headers
 * @param {boolean} [secure]
 */
function upgrade({ peer = '127.0.0.1', host = 'localhost:8000', origin = 'http://localhost:8000' }, secure = false) {
  return admitsRunnerUpgrade(/** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ ({
    socket: { remoteAddress: peer }, headers: { host, origin, 'sec-fetch-site': 'same-origin' },
  })), secure);
}

void test('upgrade admission checks the peer and the complete browser Origin', () => {
  assert.equal(upgrade({}), true);
  assert.equal(upgrade({ peer: '::1' }), true);
  assert.equal(upgrade({ peer: '::ffff:127.0.0.1' }), true);
  assert.equal(upgrade({ host: '[::1]:8000', origin: 'http://[::1]:8000' }), true);
  assert.equal(upgrade({ origin: 'https://localhost:8000' }, true), true);
  assert.equal(upgrade({ host: 'localhost:80', origin: 'http://localhost' }), true);
  for (const origin of [
    '', 'null', 'https://foreign.example', 'https://localhost:8000',
    'http://localhost:8001', 'http://127.0.0.1:8000', 'http://localhost:8000/',
    'http://localhost:8000/path', 'http://user@localhost:8000',
    'http://localhost:8000?query', 'http://localhost:8000#fragment',
    'http://localhost:8000, http://localhost:8000',
  ]) assert.equal(upgrade({ origin }), false, origin);
  for (const peer of ['192.168.1.20', '::ffff:10.0.0.2', '127.example', '']) {
    assert.equal(upgrade({ peer }), false, peer);
  }
  assert.equal(upgrade({ host: 'rebound.example:8000', origin: 'http://rebound.example:8000' }), false);
  assert.equal(upgrade({ origin: 'http://localhost:8000' }, true), false);
});

/**
 * @param {string} url
 * @param {import('ws').ClientOptions} options
 * @returns {Promise<number | undefined>}
 */
function refusedUpgrade(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 5000, ...options });
    socket.once('error', reject);
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('An untrusted WebSocket upgrade was admitted.'));
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      socket.terminate();
    });
  });
}

void test('the shipped runner refuses upgrades and contains invalid messages and listener failures', { timeout: 20_000 }, async (t) => {
  const preset = testRunnerConfig({ app: 'example' });
  let origin = '';
  /** @type {string[]} */
  const diagnostics = [];
  /** @param {unknown[]} messages */
  const log = (...messages) => diagnostics.push(messages.map(String).join(' '));
  const consoleErrors = t.mock.method(console, 'error', log);
  const runner = await startTestRunner({
    readCliArgs: false, readFileConfig: false, autoExitProcess: false,
    config: {
      ...preset,
      files: ['source/lib/test/foundation/paths.test.js'],
      port: 0, manual: true,
      logger: { log() {}, debug() {}, error: log, warn: log, group() {}, groupEnd() {}, logSyntaxError() {} },
      plugins: [...(preset.plugins ?? []), {
        name: 'socket-regression',
        serverStart({ server, webSockets }) {
          const address = server?.address();
          assert.ok(address && typeof address !== 'string');
          origin = `http://localhost:${address.port}`;
          webSockets?.on('message', ({ data }) => {
            if (data.type === 'probe-sync') throw new Error('sync\x1b]0;changed\x07\nforged');
          });
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          webSockets?.on('message', async ({ data }) => {
            if (data.type === 'probe-async') throw new Error('async\x1b]0;changed\x07\nforged');
            await Promise.resolve();
          });
        },
        executeCommand({ command }) {
          if (command === 'probe-error') throw new Error('command\x1b]0;changed\x07\nforged');
          if (command === 'probe-live') return 'runner alive';
        },
      }],
    },
  });
  assert.ok(runner !== undefined && !runner.stopped);
  t.after(() => runner.stop());
  const url = `${origin.replace('http:', 'ws:')}/wds`;
  const upgrades = /** @type {import('ws').ClientOptions[]} */ ([
    {}, { origin: 'https://foreign.example' }, { origin: origin.replace('http:', 'https:') },
    { origin: 'http://localhost:1' }, { origin, headers: { Host: 'rebound.example' } },
    { origin: 'null', headers: { 'Sec-Fetch-Site': 'same-origin' } },
  ]);
  for (const options of upgrades) assert.equal(await refusedUpgrade(url, options), 403);

  const rawSocket = await new Promise((/** @type {(socket: import('node:net').Socket) => void} */ resolve, reject) => {
    const handshake = request(`${origin}/wds`, { headers: {
      Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    } });
    handshake.once('upgrade', (_response, socket) => resolve(socket));
    handshake.once('error', reject);
    handshake.end();
  });
  t.after(() => rawSocket.destroy());
  rawSocket.resume();
  const frameClosed = once(rawSocket, 'close');
  rawSocket.write(Buffer.from([0x81, 0x00]));
  await frameClosed;
  assert.equal(runner.stopped, false);

  const network = Object.values(networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === 'IPv4');
  if (network) {
    const external = new URL(origin);
    external.hostname = network.address;
    assert.equal(await refusedUpgrade(`${external.href.replace('http:', 'ws:')}wds`, { origin: external.origin }), 403);
  }

  const session = runner.sessions.all().next().value;
  assert.ok(session !== undefined);
  const debug = { ...session, id: `${session.id}-debug`, debug: /** @type {const} */ (true) };
  runner.sessions.addDebug(debug);
  for (const data of [
    '{"type":"\u001b]0;changed\u0007"', 'null', '[]', '{}', '{"type":7}',
    JSON.stringify({ type: 'wtr-session-started' }),
    JSON.stringify({ type: 'wtr-session-started', sessionId: 'unknown\x1b]0;changed\x07\nforged' }),
    JSON.stringify({ type: 'wtr-session-finished', sessionId: debug.id, result: null, userAgent: 'test' }),
    JSON.stringify({ type: 'wtr-session-finished', sessionId: debug.id, result: {}, userAgent: 7 }),
    JSON.stringify({ type: 'wtr-session-finished', sessionId: session.id, result: { id: 'unknown' }, userAgent: 'test' }),
    JSON.stringify({ type: 'wtr-command', sessionId: debug.id, id: 1 }),
  ]) {
    const socket = new WebSocket(url, { origin });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(data);
    const [code] = await closed;
    assert.equal(code, 1008, data);
    assert.equal(runner.stopped, false);
  }

  const socket = new WebSocket(url, { origin });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  for (const type of ['probe-sync', 'probe-async']) {
    socket.send(JSON.stringify({ type }));
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'wtr-command', sessionId: debug.id, id: 1, command: 'probe-live' }));
    const [raw] = await response;
    assert.equal(JSON.parse(String(raw)).response.result, 'runner alive');
  }
  for (const command of ['probe-error', 'probe-live']) {
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'wtr-command', sessionId: debug.id, id: 2, command }));
    const [raw] = await response;
    const message = JSON.parse(String(raw));
    if (command === 'probe-error') assert.match(message.error, /command/u);
    else assert.equal(message.response.result, 'runner alive');
  }
  const resultFailure = t.mock.method(runner.sessions, 'updateStatus', () => {
    throw new Error('result\x1b]0;changed\x07\nforged');
  });
  socket.send(JSON.stringify({ type: 'wtr-session-finished', sessionId: session.id, result: {}, userAgent: 'test' }));
  const afterResult = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'wtr-command', sessionId: debug.id, id: 3, command: 'probe-live' }));
  await afterResult;
  resultFailure.mock.restore();
  assert.equal(consoleErrors.mock.callCount(), 0);
  assert.equal(runner.stopped, false);
  assert.ok(diagnostics.some((line) => line.includes('Unknown runner session unknown\\x1b')));
  for (const type of ['sync', 'async', 'command', 'result']) {
    assert.ok(diagnostics.some((line) => line.includes(`${type}\\x1b`)), type);
  }
  // eslint-disable-next-line no-control-regex
  const controls = /[\x00-\x1f\x7f-\x9f\u2028-\u202e]/u;
  for (const line of diagnostics) assert.doesNotMatch(line, controls);
  assert.equal((await fetch(origin)).status, 200);
});
