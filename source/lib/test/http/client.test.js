import { ApiClient, ApiError } from '@core/http/client.js';
import { assert, instrumentedAbort, present } from '../harness.js';

/**
 * The HTTP client, against a recorded transport.
 *
 * Written twice inside two applications, the client can only be reached through a
 * running application and a fake server, and these assertions cannot live in the
 * library at all. Everything here is about the request the client builds and the failure
 * it reports, which is the whole of what an application depends on.
 */

/** @typedef {{ url: string, init: RequestInit }} Call */

/**
 * A transport that records what it was asked to send and answers as directed.
 *
 * @param {(url: string) => Response} [answer]
 * @returns {{ fetch: import('@core/http/client.js').HttpTransport, calls: Call[] }}
 */
function transport(answer) {
  /** @type {Call[]} */
  const calls = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(answer?.(url) ?? json({ ok: true }));
    },
  };
}

/** @typedef {{ url: string, signal: AbortSignal | undefined, answer: (response: Response) => void }} Pending */

/**
 * A transport that hands every call to the test unanswered, and rejects one whose
 * signal aborts, which is the half of `fetch` these assertions are about.
 *
 * @returns {{ fetch: import('@core/http/client.js').HttpTransport, calls: Pending[] }}
 */
function deferred() {
  /** @type {Pending[]} */
  const calls = [];
  return {
    calls,
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        const signal = init?.signal ?? undefined;
        calls.push({ url, signal, answer: resolve });
        // An aborted signal rejects before anything is sent, and an abort while the
        // request is open rejects it. Both are `fetch`, and both matter here.
        if (signal?.aborted === true) return reject(aborted());
        signal?.addEventListener('abort', () => reject(aborted()), { once: true });
      }),
  };
}

/** @returns {Error} What `fetch` rejects an aborted request with, by default. */
function aborted() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The headers of a recorded call, as a plain object.
 *
 * @param {Call} call
 * @returns {Record<string, string>}
 */
function headers(call) {
  return /** @type {Record<string, string>} */ (call.init.headers ?? {});
}

/**
 * The `ApiError` a call rejected with, narrowed.
 *
 * `promise.catch((cause) => cause)` types the failure as `any` and spreads it
 * into every assertion below it, which is the one thing the codebase's lint rules
 * refuse. This says what a failing call is expected to produce and fails loudly
 * when it produces anything else.
 *
 * @param {Promise<unknown>} pending
 * @returns {Promise<ApiError>}
 */
async function apiError(pending) {
  try {
    await pending;
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw new Error(`Expected an ApiError, got ${String(cause)}`);
  }
  throw new Error('Expected a rejection, none occurred.');
}

describe('ApiClient', () => {
  describe('the URL it builds', () => {
    it('joins the base URL, and a trailing slash on it changes nothing', async () => {
      const sent = transport();
      await new ApiClient('/api/', { fetch: sent.fetch }).get('/orders');
      assert.equal(present(sent.calls[0]).url, `${location.origin}/api/orders`);
    });

    it('drops an undefined parameter rather than sending the word', async () => {
      const sent = transport();
      await new ApiClient('/api', { fetch: sent.fetch }).get('/orders', { status: undefined, q: 'a' });
      assert.equal(present(sent.calls[0]).url, `${location.origin}/api/orders?q=a`);
    });

    it('expands an array into repeated parameters', async () => {
      const sent = transport();
      await new ApiClient('/api', { fetch: sent.fetch }).get('/orders', { status: ['open', 'held'] });
      assert.equal(present(sent.calls[0]).url, `${location.origin}/api/orders?status=open&status=held`);
    });

    it('builds a stream URL without sending anything', async () => {
      const sent = transport();
      const client = new ApiClient('/api', { fetch: sent.fetch });
      assert.equal(client.streamUrl('/events'), `${location.origin}/api/events`);
      assert.equal(sent.calls.length, 0);
      await Promise.resolve();
    });
  });

  describe('the request it sends', () => {
    it('asks for JSON on every call', async () => {
      const sent = transport();
      await new ApiClient('/api', { fetch: sent.fetch }).get('/orders');
      assert.equal(headers(present(sent.calls[0])).Accept, 'application/json');
    });

    it('sends a get under a signal of its own, which the caller aborts through', async () => {
      const sent = deferred();
      const controller = new AbortController();
      const read = new ApiClient('/api', { fetch: sent.fetch }).get(
        '/orders',
        undefined,
        controller.signal,
      );

      // Not the caller's signal, because the request is shared and one caller leaving
      // may not cancel what the others are waiting for. It aborts when the last does.
      const call = present(sent.calls[0]);
      assert.notOk(call.signal === controller.signal, 'the request carries its own signal');

      controller.abort();
      await assert.rejects(() => read);
      assert.ok(call.signal?.aborted, 'the last caller out aborts the request');
    });

    it('serialises a body and declares its type, for each writing verb', async () => {
      const sent = transport();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      await client.post('/orders', { id: 1 });
      await client.patch('/orders/1', { status: 'held' });
      await client.put('/snapshots', { cents: 10 });

      assert.sameArray(
        sent.calls.map((call) => String(call.init.method)),
        ['POST', 'PATCH', 'PUT'],
      );
      for (const call of sent.calls) {
        assert.equal(headers(call)['Content-Type'], 'application/json');
      }
      assert.equal(present(sent.calls[0]).init.body, '{"id":1}');
    });

    it('sends a delete with no body and no content type', async () => {
      const sent = transport();
      await new ApiClient('/api', { fetch: sent.fetch }).delete('/orders/1');

      const call = present(sent.calls[0]);
      assert.equal(call.init.method, 'DELETE');
      assert.equal(call.init.body, undefined);
      assert.equal(headers(call)['Content-Type'], undefined);
    });
  });

  describe('the body it returns', () => {
    it('parses a JSON response', async () => {
      const sent = transport(() => json({ id: 7 }));
      const body = /** @type {{ id: number }} */ (
        await new ApiClient('/api', { fetch: sent.fetch }).get('/orders/7')
      );
      assert.equal(body.id, 7);
    });

    it('reads a 204 and an empty body as null rather than failing to parse', async () => {
      const empty = transport(() => new Response(null, { status: 204 }));
      assert.equal(await new ApiClient('/api', { fetch: empty.fetch }).delete('/orders/1'), null);

      const blank = transport(() => new Response('', { status: 200 }));
      assert.equal(await new ApiClient('/api', { fetch: blank.fetch }).get('/orders'), null);
    });

    it('names a JSON endpoint that answered with HTML', async () => {
      const sent = transport(
        () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      );
      await assert.rejects(
        () => new ApiClient('/api', { fetch: sent.fetch }).get('/orders'),
        'malformed_json',
      );
    });
  });

  describe('the failure it reports', () => {
    it('carries the server error code, the status and the path', async () => {
      const sent = transport(() => json({ error: 'order_closed' }, 409));
      const client = new ApiClient('/api', { fetch: sent.fetch });

      const error = await apiError(client.patch('/orders/1', { status: 'open' }));
      assert.equal(error.status, 409);
      assert.equal(error.code, 'order_closed');
      assert.equal(error.path, '/orders/1');
      assert.includes(error.message, '409 order_closed for /orders/1');
    });

    it('names the status when the failure carries no code of its own', async () => {
      const sent = transport(() => new Response('{}', { status: 502 }));
      const error = await apiError(new ApiClient('/api', { fetch: sent.fetch }).get('/orders'));
      assert.equal(error.code, 'http_502');
    });

    it('lets an application read a server error shape that is not { error }', async () => {
      const sent = transport(() => json({ detail: { reason: 'locked' } }, 409));
      const client = new ApiClient('/api', {
        fetch: sent.fetch,
        errorCode: (_status, body) =>
          String(/** @type {{ detail?: { reason?: unknown } }} */ (body).detail?.reason),
      });

      const error = await apiError(client.get('/orders'));
      assert.equal(error.code, 'locked');
    });

    it('answers a 403 as forbidden and everything else as not', async () => {
      const forbidden = transport(() => json({ error: 'not_entitled' }, 403));
      const denied = await apiError(new ApiClient('/api', { fetch: forbidden.fetch }).get('/audit'));
      assert.ok(denied.forbidden);

      const missing = transport(() => json({ error: 'not_found' }, 404));
      const gone = await apiError(new ApiClient('/api', { fetch: missing.fetch }).get('/audit'));
      assert.notOk(gone.forbidden);
    });

    it('exposes the per-field codes of a 422, and only string ones', async () => {
      const sent = transport(() =>
        json({ error: 'validation_failed', fields: { amount: 'required', rows: { nested: 1 } } }, 422),
      );
      const error = await apiError(new ApiClient('/api', { fetch: sent.fetch }).post('/movements', {}));
      assert.equal(error.fields.amount, 'required');
      assert.equal(error.fields.rows, undefined);
    });

    it('keeps the codes in a record with no prototype', async () => {
      // The keys are the server's. `__proto__` is a code like any other, and a name
      // the server did not send is absent even where Object.prototype has it. ADR-0118.
      const body = /** @type {unknown} */ (
        JSON.parse('{ "error": "validation_failed", "fields": { "__proto__": "invalid" } }')
      );
      const sent = transport(() => json(body, 422));
      const error = await apiError(new ApiClient('/api', { fetch: sent.fetch }).post('/movements', {}));
      assert.sameArray(Object.keys(error.fields), ['__proto__']);
      assert.notOk('constructor' in error.fields, 'a name the server did not send');
    });

    it('has no fields on a failure that is not a 422', async () => {
      const sent = transport(() => json({ error: 'boom', fields: { amount: 'required' } }, 500));
      const error = await apiError(new ApiClient('/api', { fetch: sent.fetch }).post('/movements', {}));
      assert.sameArray(Object.keys(error.fields), []);
    });
  });

  describe('the read it shares', () => {
    it('sends one request for two concurrent gets of the same URL, and answers both', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      /** @type {Promise<{ id: number }>} */
      const header = client.get('/orders/7');
      /** @type {Promise<{ id: number }>} */
      const tab = client.get('/orders/7');
      assert.equal(sent.calls.length, 1, 'the second get joined the first');

      present(sent.calls[0]).answer(json({ id: 7 }));
      assert.equal((await header).id, 7);
      assert.equal((await tab).id, 7);
    });

    it('hands each caller its own copy, so no screen can edit what another one holds', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      /** @type {Promise<{ lines: string[] }>} */
      const header = client.get('/orders/7');
      /** @type {Promise<{ lines: string[] }>} */
      const tab = client.get('/orders/7');
      present(sent.calls[0]).answer(json({ lines: [] }));

      const own = await header;
      const other = await tab;
      assert.notOk(own === other, 'two callers, two objects');

      own.lines.push('edited');
      assert.equal(other.lines.length, 0, 'the copy is not the same array either');
    });

    it('shares nothing between two URLs, however close', () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      void client.get('/orders', { status: 'open' });
      void client.get('/orders', { status: 'held' });
      assert.equal(sent.calls.length, 2);
    });

    it('is not a cache: a get after the first settled asks again', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      const first = client.get('/orders/7');
      present(sent.calls[0]).answer(json({ id: 7, status: 'open' }));
      await first;

      void client.get('/orders/7');
      assert.equal(sent.calls.length, 2, 'the settled read was not kept');
    });

    it('lets one caller cancel without touching what the others are waiting for', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });
      const controller = new AbortController();

      const left = client.get('/orders/7', undefined, controller.signal);
      /** @type {Promise<{ id: number }>} */
      const stayed = client.get('/orders/7');

      controller.abort();
      await assert.rejects(() => left);

      const call = present(sent.calls[0]);
      assert.notOk(call.signal?.aborted, 'one caller leaving is not a cancellation');
      call.answer(json({ id: 7 }));
      assert.equal((await stayed).id, 7);
    });

    it('starts a fresh request for a get that arrives after the last caller left', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });
      const controller = new AbortController();

      const abandoned = client.get('/orders/7', undefined, controller.signal);
      controller.abort();
      await assert.rejects(() => abandoned);

      void client.get('/orders/7');
      assert.equal(sent.calls.length, 2, 'the aborted read was not joined');
    });

    it('does not join an aborted caller to a read, or a read to it', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });
      const controller = new AbortController();
      controller.abort();

      /** @type {Promise<{ id: number }>} */
      const shared = client.get('/orders/7');
      await assert.rejects(() => client.get('/orders/7', undefined, controller.signal));

      assert.equal(sent.calls.length, 2, 'the aborted caller was sent on its own');
      present(sent.calls[0]).answer(json({ id: 7 }));
      assert.equal((await shared).id, 7);
    });

    it('reports one failure to every caller', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      const header = client.get('/orders/7');
      const tab = client.get('/orders/7');
      present(sent.calls[0]).answer(json({ error: 'not_found' }, 404));

      for (const read of [header, tab]) {
        const error = await apiError(read);
        assert.equal(error.status, 404);
        assert.equal(error.code, 'not_found');
      }
    });

    it('keeps no listener on the caller signal after the read settles', async () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });
      const { controller, listeners } = instrumentedAbort();

      const read = client.get('/orders/7', undefined, controller.signal);
      assert.equal(listeners.size, 1, 'the waiting caller listens for its own abort');

      present(sent.calls[0]).answer(json({ id: 7 }));
      await read;
      assert.equal(listeners.size, 0, 'the settled read lets the caller go');
    });

    it('shares no write, however identical', () => {
      const sent = deferred();
      const client = new ApiClient('/api', { fetch: sent.fetch });

      void client.post('/orders/7/close', {});
      void client.post('/orders/7/close', {});
      assert.equal(sent.calls.length, 2, 'two closes are two closes');
    });
  });
});
