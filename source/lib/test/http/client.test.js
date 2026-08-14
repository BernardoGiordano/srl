import { ApiClient, ApiError } from '@core/http/client.js';
import { assert, present } from '../harness.js';

/**
 * The HTTP client, against a recorded transport.
 *
 * These assertions used to be untestable in the library, because the client was
 * written twice inside two applications and each copy could only be reached
 * through a running application and a fake server. Everything here is about the
 * request the client builds and the failure it reports, which is the whole of
 * what an application depends on.
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
    it('asks for JSON on every call and carries the abort signal of a get', async () => {
      const sent = transport();
      const controller = new AbortController();
      await new ApiClient('/api', { fetch: sent.fetch }).get('/orders', undefined, controller.signal);

      const call = present(sent.calls[0]);
      assert.equal(headers(call).Accept, 'application/json');
      assert.equal(call.init.signal, controller.signal);
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

    it('has no fields on a failure that is not a 422', async () => {
      const sent = transport(() => json({ error: 'boom', fields: { amount: 'required' } }, 500));
      const error = await apiError(new ApiClient('/api', { fetch: sent.fetch }).post('/movements', {}));
      assert.sameArray(Object.keys(error.fields), []);
    });
  });
});
