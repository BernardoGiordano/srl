/**
 * The dashboard and stock screen receive updates through one SSE response per client.
 * SSE uses the same session cookie as the API. The synthetic ticker publishes through
 * the same path as real changes so the screens have activity in a fresh session.
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
    // The browser reconnects after a socket closes.
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
    // Tell proxies to forward events as they arrive.
    'X-Accel-Buffering': 'no',
  });
  // Open the stream before the first event and suggest a retry delay.
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
 * Publish stock movements from the same data the REST endpoints read.
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

  // The demo ticker should not keep the server alive.
  timer.unref();
  return () => clearInterval(timer);
}
