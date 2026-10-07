import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { format } from 'node:util';

import { printable } from '../diagnostics/index.mjs';
import { admitsHost } from '../origin/index.mjs';

/**
 * HTTP and WebSocket requests use the same peer and Host admission.
 *
 * @param {import('node:http').IncomingMessage} request
 */
export function admitsRunnerRequest(request) {
  const address = request.socket.remoteAddress;
  if (address === undefined) return false;
  const peer = address.startsWith('::ffff:') ? address.slice(7) : address;
  return (peer === '::1' || (isIP(peer) === 4 && peer.startsWith('127.'))) &&
    admitsHost(request.headers.host);
}

/**
 * A browser upgrade must carry the complete origin of this connection. Forwarded
 * headers and fetch metadata cannot substitute for its scheme, host, and port.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {boolean} secure
 */
export function admitsRunnerUpgrade(request, secure) {
  if (!admitsRunnerRequest(request) || typeof request.headers.origin !== 'string') return false;
  try {
    const expected = new URL(`${secure ? 'https' : 'http'}://${request.headers.host}`);
    return request.headers.origin === expected.origin;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The upstream API starts detached async work for commands and results. Admit its
 * required fields before dispatch, and keep result data from replacing session
 * identity or lifecycle fields.
 *
 * @param {unknown} value
 * @param {(id: string) => boolean} admitsSession
 * @returns {asserts value is import('@web/dev-server-core').WebSocketData}
 */
function admitMessage(value, admitsSession) {
  if (!record(value)) throw new Error('Expected a WebSocket message object.');
  const data = /** @type {Record<string, unknown>} */ (value);
  if (typeof data.type !== 'string' || data.type === '') throw new Error('Missing WebSocket message type.');
  if (!data.type.startsWith('wtr-')) return;
  if (typeof data.sessionId !== 'string' || !admitsSession(data.sessionId)) {
    throw new Error(`Unknown runner session ${String(data.sessionId)}.`);
  }
  if (data.type === 'wtr-session-started') return;
  if (data.type === 'wtr-command' && typeof data.id === 'number' && typeof data.command === 'string') return;
  if (data.type === 'wtr-session-finished' && record(data.result) &&
    typeof data.userAgent === 'string' && data.userAgent !== '') {
    const result = /** @type {Record<string, unknown>} */ (data.result);
    if (!['id', 'browser', 'group', 'debug', 'testRun', 'testFile', 'status'].some((key) => key in result)) return;
  }
  throw new Error('Invalid runner WebSocket message.');
}

/**
 * Guard the upstream handshake and raw message parser through the server's hooks.
 * Invalid input never reaches the upstream parser's raw console diagnostics.
 *
 * @param {(id: string) => boolean} admitsSession
 * @returns {import('@web/test-runner').TestRunnerPlugin}
 */
export function runnerSockets(admitsSession) {
  return {
    name: 'srl-runner-sockets',
    serverStart({ config, webSockets, logger }) {
      if (webSockets === undefined) throw new Error('The runner requires a WebSocket server.');
      // The upstream facade has no listener enumeration or rejection capture.
      // Keep this compatibility check at the adapter and fail closed if it changes.
      const emitter = /** @type {{ __emitter?: unknown }} */ (/** @type {unknown} */ (webSockets)).__emitter;
      if (!(emitter instanceof EventEmitter)) throw new Error('Unsupported runner WebSocket dispatcher.');
      const server = webSockets.webSocketServer;
      server.options.verifyClient = ({ req, secure }, done) => done(admitsRunnerUpgrade(req, secure), 403);
      const report = (/** @type {unknown} */ error) => {
        logger.warn(`Rejected runner WebSocket message: ${printable(error instanceof Error ? error.message : String(error))}`);
      };
      const api = /** @type {Record<string, unknown> | undefined} */ (/** @type {unknown} */ (
        config.plugins?.find((plugin) => plugin.name === 'test-runner-api')
      ));
      if (api === undefined) throw new Error('Unsupported runner WebSocket API.');
      // The upstream API discards these promises. Guard them where they originate.
      for (const name of ['_onSessionFinished', '_onCommand', '_waitForDisconnect']) {
        const work = api[name];
        if (typeof work !== 'function') throw new Error('Unsupported runner WebSocket API.');
        const run = /** @type {(...args: unknown[]) => unknown} */ (work);
        /** @param {unknown[]} args */
        const guarded = async (...args) => {
          try { await run.apply(api, args); }
          catch (error) { report(error); }
        };
        api[name] = guarded;
      }
      const logError = logger.error.bind(logger);
      logger.error = (...messages) => logError(printable(format(...messages)));
      const emit = webSockets.emit.bind(webSockets);
      webSockets.emit = (event, message) => {
        if (event !== 'message' || message === undefined) return emit(event, message);
        for (const listener of emitter.rawListeners(event)) {
          try {
            const receive = /** @type {(received: typeof message) => unknown} */ (listener);
            const result = receive.call(emitter, message);
            void Promise.resolve(result).catch(report);
          } catch (error) {
            report(error);
          }
        }
      };
      server.on('connection', (socket) => {
        socket.on('error', report);
        const listeners = socket.rawListeners('message');
        socket.removeAllListeners('message');
        socket.on('message', (raw) => {
          if (socket.readyState !== socket.OPEN) return;
          try {
            if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) throw new Error('Expected a text WebSocket message.');
            const text = typeof raw === 'string' ? raw : raw.toString('utf8');
            admitMessage(JSON.parse(text), admitsSession);
            for (const listener of listeners) {
              const result = /** @type {unknown} */ (listener.call(socket, raw));
              void Promise.resolve(result).catch(report);
            }
          } catch (error) {
            report(error);
            socket.close(1008, 'Invalid runner message');
          }
        });
      });
    },
  };
}
