import { provide, resetInjector } from '@core/foundation/inject.js';
import { AUTH_SESSION } from '@auth/session.js';
import { sessionFetch } from '@auth/session-fetch.js';
import { assert, present } from '../harness.js';

/**
 * The adapter that binds the HTTP client to the session.
 *
 * One assertion carries the whole reason this is a function rather than a value:
 * the session is resolved per call. A transport that captured it once would keep
 * authorizing against a session a re-bootstrap has already disposed.
 */

/**
 * @param {string} name
 * @returns {{ session: { fetch: import('@core/http/client.js').HttpTransport }, calls: string[] }}
 */
function fakeSession(name) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    session: {
      fetch: (url) => {
        calls.push(`${name} ${url}`);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    },
  };
}

describe('sessionFetch', () => {
  beforeEach(() => {
    resetInjector();
  });

  it('sends through the session provided now, not the one provided when it first ran', async () => {
    const first = fakeSession('first');
    const second = fakeSession('second');

    provide(AUTH_SESSION, () => /** @type {never} */ (first.session));
    await sessionFetch('/api/orders');

    provide(AUTH_SESSION, () => /** @type {never} */ (second.session));
    await sessionFetch('/api/orders');

    assert.sameArray(first.calls, ['first /api/orders']);
    assert.sameArray(second.calls, ['second /api/orders']);
  });

  it('passes the request init through untouched', async () => {
    /** @type {RequestInit[]} */
    const seen = [];
    provide(
      AUTH_SESSION,
      () =>
        /** @type {never} */ ({
          /** @type {import('@core/http/client.js').HttpTransport} */
          fetch: (_url, init) => {
            seen.push(init ?? {});
            return Promise.resolve(new Response('{}', { status: 200 }));
          },
        }),
    );

    await sessionFetch('/api/orders', { method: 'POST', body: '{"id":1}' });

    const init = present(seen[0]);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"id":1}');
  });
});
