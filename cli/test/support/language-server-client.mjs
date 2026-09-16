/**
 * One stdio client for the language server.
 *
 * Framing, id correlation and the diagnostics stream are needed by three callers, twice
 * in the suites and again in the workload that measures editor latency, and three copies
 * of a wire format disagree eventually. Callers get messages, and nobody else counts
 * bytes to a separator.
 *
 * Raw `frame` and `write` stay exposed because atomicity is part of what a caller tests.
 * A request and the `$/cancelRequest` that withdraws it have to reach the server in one
 * read, and so do two opens that must not queue behind each other.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'language-server/server.mjs');

/**
 * Start one server over stdio.
 *
 * @param {{
 *   root?: string,
 *   capabilities?: any,
 *   timeout?: number,
 *   onPublish?: (publish: { uri: string, diagnostics: any[], at: number }) => void,
 * }} [options]
 *   `root` is the repository the server analyses, and `capabilities` is what the client
 *   claims, which decides what the server asks of it.
 */
export function startLanguageServer(options = {}) {
  const root = options.root ?? process.cwd();
  const capabilities = options.capabilities ?? {};
  const timeout = options.timeout ?? 30_000;
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: { ...process.env, SRL_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = Buffer.alloc(0);
  let stderr = '';
  let lastId = 0;
  /** @type {Map<string | number, (message: any) => void>} */
  const waiting = new Map();
  /** Requests the server sent this client. @type {any[]} */
  const serverRequests = [];
  /** @type {Map<string, (message: any) => void>} */
  const watchingFor = new Map();
  /** Every publishDiagnostics notification, in arrival order. @type {Array<{ uri: string, diagnostics: any[], at: number }>} */
  const publishes = [];
  /** @type {Map<string, (diagnostics: any[]) => void>} */
  const wantedDiagnostics = new Map();

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const separator = buffer.indexOf('\r\n\r\n');
      if (separator === -1) break;
      const header = buffer.subarray(0, separator).toString('ascii');
      const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
      const end = separator + 4 + length;
      if (buffer.length < end) break;
      const message = JSON.parse(buffer.subarray(separator + 4, end).toString('utf8'));
      buffer = buffer.subarray(end);
      receive(message);
    }
  });

  /** @param {any} message */
  function receive(message) {
    if (message.method === 'textDocument/publishDiagnostics') {
      const publish = { uri: message.params.uri, diagnostics: message.params.diagnostics, at: performance.now() };
      publishes.push(publish);
      options.onPublish?.(publish);
      const wanted = wantedDiagnostics.get(publish.uri);
      if (wanted !== undefined) {
        wantedDiagnostics.delete(publish.uri);
        wanted(publish.diagnostics);
      }
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) serverRequests.push(message);
      watchingFor.get(message.method)?.(message);
      watchingFor.delete(message.method);
      return;
    }
    const answer = waiting.get(message.id);
    if (answer !== undefined) {
      waiting.delete(message.id);
      answer(message);
    }
  }

  /** @param {string} what @param {(resolveMessage: (value: any) => void) => void} register @returns {Promise<any>} */
  function awaiting(what, register) {
    return new Promise((resolveMessage, reject) => {
      register(resolveMessage);
      const expired = setTimeout(() => reject(new Error(`Timed out waiting for ${what}. ${stderr}`)), timeout);
      expired.unref();
    });
  }

  /** @param {unknown} message @returns {Buffer} */
  function frame(message) {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`), body]);
  }

  /** One write, so the server reads every message in it together. @param {Buffer[]} frames */
  function write(frames) {
    child.stdin.write(Buffer.concat(frames));
  }

  /** @param {string | number} id @returns {Promise<any>} */
  function expect(id) {
    return awaiting(`response ${String(id)}`, (answer) => waiting.set(id, answer));
  }

  return {
    capabilities,
    publishes,
    serverRequests,
    frame,
    write,
    expect,
    stderr: () => stderr,
    /** The id the next request will carry, for a message that has to name it. */
    nextId: () => (lastId += 1),

    /**
     * Send a request and get its answer. The promise carries the id it was sent with.
     *
     * @param {string} method
     * @param {unknown} [params]
     * @returns {Promise<any> & { id: number }}
     */
    request(method, params) {
      const id = (lastId += 1);
      const answer = /** @type {Promise<any> & { id: number }} */ (expect(id));
      answer.id = id;
      write([frame({ jsonrpc: '2.0', id, method, params: params ?? null })]);
      return answer;
    },

    /** @param {string} method @param {unknown} [params] */
    notify(method, params) {
      write([frame({ jsonrpc: '2.0', method, params })]);
    },

    /** @param {string} uri @param {string} languageId @param {number} version @param {string} text */
    open(uri, languageId, version, text) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    },

    /** Whole-document sync, which is what the server declares. @param {string} uri @param {number} version @param {string} text */
    change(uri, version, text) {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    },

    /** @param {string} uri */
    close(uri) {
      this.notify('textDocument/didClose', { textDocument: { uri } });
    },

    /** A request the server sends this client. @param {string} method @returns {Promise<any>} */
    serverRequest(method) {
      const existing = serverRequests.find((message) => message.method === method);
      if (existing !== undefined) return Promise.resolve(existing);
      return awaiting(method, (answer) => watchingFor.set(method, answer));
    },

    /** The diagnostics this document already has, or the next ones published for it. @param {string} uri @returns {Promise<any[]>} */
    diagnostics(uri) {
      const already = publishes.findLast((publish) => publish.uri === uri);
      if (already !== undefined) return Promise.resolve(already.diagnostics);
      return this.nextDiagnostics(uri);
    },

    /** The next diagnostics published for this document, whatever it has now. @param {string} uri @returns {Promise<any[]>} */
    nextDiagnostics(uri) {
      return awaiting(`diagnostics for ${uri}`, (answer) => wantedDiagnostics.set(uri, answer));
    },

    /** @returns {Promise<number>} */
    exit() {
      this.notify('exit');
      return new Promise((answer) => child.once('exit', (code) => answer(code ?? 0)));
    },

    kill() {
      if (child.exitCode === null) child.kill();
    },
  };
}
