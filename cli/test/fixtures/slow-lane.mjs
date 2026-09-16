/**
 * A validation lane that is slow on purpose.
 *
 * The real lane is fast once warm, so a test that wants to observe what happens *during*
 * a check would be racing it. This one blocks its own thread for `SRL_LANE_DELAY` ms per
 * check, the way a synchronous compiler call does, and reads the same abandonment word,
 * so supersession and disposal are observable rather than inferred.
 *
 * Each answer names the thread and the check it came from, which is how a test sees that
 * a configuration change replaced the thread instead of reusing it.
 */

import { parentPort, threadId, workerData } from 'node:worker_threads';

const port = parentPort;
if (port === null) throw new Error('slow-lane.mjs runs as a worker thread');

const abandoned = new Int32Array(workerData.cancellation);
const delay = Number(process.env.SRL_LANE_DELAY ?? '200');

port.on('message', (message) => {
  if (message.kind !== 'check') return;
  const until = Date.now() + delay;
  while (Date.now() < until) {
    if (Atomics.load(abandoned, 0) >= message.id) {
      port.postMessage({ id: message.id, cancelled: true });
      return;
    }
    // Blocks this thread deliberately. It wakes on the parent's notify, and re-reads
    // the word every 10 ms regardless.
    Atomics.wait(abandoned, 0, Atomics.load(abandoned, 0), 10);
  }
  port.postMessage({
    id: message.id,
    diagnostics: [{ message: `lane ${String(threadId)} check ${String(message.id)}` }],
  });
});
