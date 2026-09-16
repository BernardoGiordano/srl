/**
 * The validation lane, one thread whose only work is diagnostics.
 *
 * A template check is one synchronous compiler call, so the thread that runs it is the
 * thread that stops answering. This one is not the protocol thread. Overlays arrive as
 * messages and are applied in order, and a check answers with the diagnostics for one
 * document or says it was cancelled. ADR-0090.
 *
 * Cancellation cannot be a message, because a message is only read between checks. It
 * is a shared integer holding the highest check the parent no longer wants, which the
 * compiler's own token reads while it works.
 *
 * Nothing here decides when to check. `analysis.mjs` owns that and owns this thread's
 * lifetime. This file is the isolated half of one module rather than an interface of
 * its own.
 */

import { parentPort, workerData } from 'node:worker_threads';
import ts from 'typescript';

import { SrlLanguageService } from './service.mjs';

if (parentPort === null) {
  throw new Error('validation.mjs runs as a worker thread, not as a program');
}
/** @type {import('node:worker_threads').MessagePort} */
const port = parentPort;

/** The highest check id the parent has abandoned. */
const abandoned = new Int32Array(workerData.cancellation);

const service = new SrlLanguageService();

/**
 * Messages are handled in arrival order, and the first of them is the project read.
 *
 * An overlay that arrives while a check runs is applied after it rather than
 * interleaved with it, because the check's answer describes the text it started
 * from.
 *
 * @type {Promise<void>}
 */
let running = reload();

port.on('message', (message) => {
  running = running.then(() => handle(message)).catch((cause) => {
    port.postMessage({ report: `srl validation lane failed: ${describe(cause)}` });
  });
});

/** @param {any} message */
async function handle(message) {
  switch (message.kind) {
    case 'open':
      service.open(message.uri, message.languageId, message.version, message.text);
      return;
    case 'change':
      service.change(message.uri, message.version, message.text);
      return;
    case 'close':
      service.close(message.uri);
      return;
    case 'reload':
      await reload();
      return;
    case 'check':
      await check(message.id, message.uri);
      return;
    default:
      return;
  }
}

async function reload() {
  try {
    await service.reload();
  } catch (cause) {
    port.postMessage({ report: `srl project refresh failed: ${describe(cause)}` });
  }
}

/** @param {number} id @param {string} uri */
async function check(id, uri) {
  const cancellation = token(id);
  try {
    const diagnostics = await service.diagnostics(uri, { cancellation });
    // Asked again after the check, because a token the compiler stopped polling
    // before the end still means the answer is about text nobody is looking at.
    if (cancellation.isCancellationRequested()) port.postMessage({ id, cancelled: true });
    else port.postMessage({ id, diagnostics });
  } catch (cause) {
    if (cause instanceof ts.OperationCanceledException) port.postMessage({ id, cancelled: true });
    else port.postMessage({ id, error: describe(cause) });
  }
}

/** @param {number} id @returns {ts.CancellationToken & { isCancellationRequested: () => boolean }} */
function token(id) {
  return {
    isCancellationRequested: () => Atomics.load(abandoned, 0) >= id,
    throwIfCancellationRequested() {
      // Not an Error, and it has to not be, because the compiler recognises its own
      // cancellation by this type and anything else travels as a template finding.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
    },
  };
}

/** @param {unknown} cause */
function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
