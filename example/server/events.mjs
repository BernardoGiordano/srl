/**
 * Server-sent events.
 *
 * The dashboard and the stock-movement screen update without polling, and this is
 * the whole mechanism: one long-lived HTTP response per subscriber, `text/event-stream`,
 * and a `publish()` any endpoint can call.
 *
 * WHY SSE RATHER THAN A WEBSOCKET
 *
 * The traffic is one-directional — the server has news, the browser has nothing to
 * say — and SSE is plain HTTP, so it inherits the cookie authentication this
 * application already has. `EventSource` cannot set headers, which is precisely
 * why a bearer-token architecture ends up putting the token in the query string
 * here; with the `bff` strategy the browser sends the HttpOnly cookie and nothing
 * needs to be smuggled. That is a real property of the strategy choice rather than
 * a detail of this file.
 *
 * A synthetic ticker runs alongside the real events so the screen has something to
 * show without a second person clicking buttons. Both arrive on the same stream, so
 * the client cannot tell (and does not care) which is which.
 */

import { MOVEMENTS, PRODUCTS, WAREHOUSES } from './data.mjs';
import { createRandom } from './random.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

const HEARTBEAT_MS = 25_000;
const TICK_MS = 6_000;

/** @type {Set<ServerResponse>} */
const subscribers = new Set();

const random = createRandom(77);
let sequence = 0;

/**
 * @param {string} event
 * @param {unknown} data
 */
export function publish(event, data) {
  sequence += 1;
  const frame = `id: ${String(sequence)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of subscribers) {
    // A subscriber whose socket has gone is dropped rather than retried: the
    // browser reconnects on its own, which is the one thing SSE gives away free.
    if (response.writableEnded) subscribers.delete(response);
    else response.write(frame);
  }
}

/**
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 */
export function openStream(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Without this an intermediary that buffers responses holds every event
    // until the stream closes, which looks exactly like a server that sends none.
    'X-Accel-Buffering': 'no',
  });
  // Retry hint plus an immediate comment, so the browser's `onopen` fires now
  // rather than on the first real event.
  response.write('retry: 3000\n: connected\n\n');

  subscribers.add(response);

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
  };
  request.on('close', close);
  response.on('close', close);
}

/**
 * The synthetic half: a stock movement every few seconds, mutating the same arrays
 * the REST endpoints read, so a reload shows what the stream already showed.
 *
 * @returns {() => void} Stop.
 */
export function startTicker() {
  const timer = setInterval(() => {
    if (subscribers.size === 0) return;

    const product = PRODUCTS[random.int(PRODUCTS.length)];
    const warehouse = WAREHOUSES[random.int(WAREHOUSES.length)];
    if (product === undefined || warehouse === undefined) return;

    const kind = random.pick(['receipt', 'issue', 'transfer', 'adjustment']);
    const quantity = 1 + random.int(60);
    product.stock = Math.max(0, product.stock + (kind === 'issue' ? -quantity : quantity));
    product.updatedAt = new Date().toISOString();

    const movement = {
      id: `MV-${String(MOVEMENTS.length + 1).padStart(5, '0')}`,
      sku: product.sku,
      warehouse: warehouse.id,
      kind,
      quantity,
      at: product.updatedAt,
      actor: 'scheduler',
    };
    MOVEMENTS.unshift(movement);
    if (MOVEMENTS.length > 600) MOVEMENTS.length = 600;

    publish('stock.movement', {
      ...movement,
      name: product.name,
      stock: product.stock,
      belowReorder: product.stock < product.reorderPoint,
    });
  }, TICK_MS);

  // Nothing in this process should be kept alive by a demo ticker.
  timer.unref();
  return () => clearInterval(timer);
}
