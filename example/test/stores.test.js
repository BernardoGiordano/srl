import { AuthRejected, AuthUnavailable } from '@auth/session-policy.js';
import { assert, present } from '../../source/lib/test/harness.js';

import { BffCookieTokenStore } from '../src/auth/bff-cookie-store.js';
import { DpopTokenStore } from '../src/auth/dpop-store.js';
import { MemoryTokenStore } from '../src/auth/memory-store.js';

/**
 * The real store adapters, against a stubbed origin.
 *
 * Until review 3 these three files had no direct coverage at all: the remote-host
 * suite used a fake session, and every test that touched authentication touched
 * an object that could not fail the way these can. What went untested was
 * precisely the ingress — what each store does with a response it did not write.
 *
 * The suite runs the same four questions past all three, because the answers must
 * not depend on which storage strategy a deployment chose:
 *
 *   1. does a malformed success payload become a session?          (it must not)
 *   2. is a refused grant distinguishable from an unreachable server?
 *   3. does a failed exchange leave a credential behind?           (it must not)
 *   4. what does `authorize()` put on the wire?
 */

/** @type {typeof globalThis.fetch} */
let nativeFetch;

/** Requests the store sent, in order. */
/** @type {Request[]} */
let sent;

/**
 * Answer every request with one canned response.
 *
 * @param {() => Response | Promise<Response>} answer
 */
function respondWith(answer) {
  globalThis.fetch = (input, init) => {
    sent.push(new Request(input, init));
    return Promise.resolve(answer());
  };
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN_PAYLOAD = {
  access_token: 'at-1',
  expires_in: 600,
  sub: 'user-ada',
  name: 'Ada',
  scope: 'sales:read',
};

const BFF_PAYLOAD = {
  csrfToken: 'csrf-1',
  sub: 'user-ada',
  name: 'Ada',
  scopes: ['sales:read'],
  expiresAt: Date.now() + 600_000,
};

const CREDENTIALS = { username: 'ada', password: 'admin' };

/**
 * The error a call rejected with, or a failure if it did not reject.
 *
 * `assert.rejects` matches a message; these cases are about the error's *type*,
 * which is what `AuthSession` branches on, and a `.catch()` that silently never
 * runs would assert nothing at all.
 *
 * @param {() => Promise<unknown>} run
 * @returns {Promise<Error>}
 */
async function rejection(run) {
  try {
    await run();
  } catch (cause) {
    // Normalized to an Error so a caller can read `.message` without narrowing a
    // `catch` binding at every site. A store that rejected with something else
    // would be a finding of its own.
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  throw new Error('Expected a rejection, none occurred.');
}

/**
 * The header a store put on an outbound request, after authorizing one.
 *
 * @param {{ authorize(request: Request): Promise<Request> }} store
 * @param {string} header
 * @returns {Promise<string | null>}
 */
async function authorizedHeader(store, header) {
  const authorized = await store.authorize(new Request('/api/orders'));
  return authorized.headers.get(header);
}

describe('token stores', () => {
  beforeEach(() => {
    sent = [];
    nativeFetch = globalThis.fetch.bind(globalThis);
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
  });

  describe('memory', () => {
    it('admits a well-formed token response', async () => {
      respondWith(() => json(TOKEN_PAYLOAD));
      const store = new MemoryTokenStore('/auth/token');

      const session = await store.login(CREDENTIALS);

      assert.equal(session.subject, 'user-ada');
      assert.sameArray(session.scopes, ['sales:read']);
      assert.equal(await authorizedHeader(store, 'Authorization'), 'Bearer at-1');
    });

    it('rejects the 200 that carries no access token', async () => {
      // Review 3's verified evidence: this resolved, and the session it produced
      // authorized the next request with `Bearer undefined`.
      const { access_token: _dropped, ...withoutToken } = TOKEN_PAYLOAD;
      respondWith(() => json(withoutToken));
      const store = new MemoryTokenStore('/auth/token');

      await assert.rejects(() => store.login(CREDENTIALS), 'access_token');
      assert.equal(await authorizedHeader(store, 'Authorization'), null);
    });

    it('holds no credential after an exchange that failed admission', async () => {
      // First a good login, then a refresh whose payload cannot be admitted. The
      // store must not go on authorizing requests with the token it had.
      let payload = /** @type {unknown} */ (TOKEN_PAYLOAD);
      respondWith(() => json(payload));
      const store = new MemoryTokenStore('/auth/token');
      await store.login(CREDENTIALS);

      payload = { ...TOKEN_PAYLOAD, expires_in: 'soon' };
      await assert.rejects(() => store.refresh(), 'expires_in');

      assert.equal(await authorizedHeader(store, 'Authorization'), null);
    });

    it('reads 401 on a refresh as "nobody is signed in"', async () => {
      respondWith(() => json({ error: 'invalid_grant' }, 401));
      const store = new MemoryTokenStore('/auth/token');

      assert.equal(await store.init(), null);
      assert.equal(await store.refresh(), null);
      // The same status on a login is a refusal, because credentials were offered.
      await assert.rejects(() => store.login(CREDENTIALS), 'rejected the credentials');
    });

    it('separates a refused grant from an unreachable server', async () => {
      const store = new MemoryTokenStore('/auth/token');

      respondWith(() => json({ error: 'invalid_client' }, 400));
      const refused = await rejection(() => store.refresh());
      assert.ok(refused instanceof AuthRejected, `400 gave ${String(refused)}`);
      // The server's own code, normalized into the message.
      assert.includes(refused.message, 'invalid_client');

      respondWith(() => json({}, 503));
      const unavailable = await rejection(() => store.refresh());
      assert.ok(unavailable instanceof AuthUnavailable, `503 gave ${String(unavailable)}`);

      globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      const offline = await rejection(() => store.refresh());
      assert.ok(offline instanceof AuthUnavailable, `transport failure gave ${String(offline)}`);
    });

    it('sends credentials only to its configured endpoint', async () => {
      respondWith(() => json(TOKEN_PAYLOAD));
      const store = new MemoryTokenStore('/auth/token');
      await store.login(CREDENTIALS);

      const request = present(sent[0]);
      assert.equal(new URL(request.url).pathname, '/auth/token');
      assert.equal(new URL(request.url).origin, location.origin);
    });
  });

  describe('bff cookie', () => {
    it('admits a session probe and attaches the CSRF token', async () => {
      respondWith(() => json(BFF_PAYLOAD));
      const store = new BffCookieTokenStore('/auth');

      const session = present(await store.init());

      assert.equal(session.subject, 'user-ada');
      assert.equal(await authorizedHeader(store, 'X-CSRF-Token'), 'csrf-1');
      // No Authorization header, ever. The browser sends the HttpOnly cookie and
      // this code never possesses a credential.
      assert.equal(await authorizedHeader(store, 'Authorization'), null);
    });

    it('rejects a session payload it cannot admit', async () => {
      respondWith(() => json({ sub: 'user-ada', name: 'Ada' }));
      const store = new BffCookieTokenStore('/auth');

      await assert.rejects(() => store.init(), 'expiresAt');
      assert.equal(await authorizedHeader(store, 'X-CSRF-Token'), null);
    });

    it('keeps the CSRF token across a probe that reissues none', async () => {
      // A probe that silently cleared it would disarm every later write, and the
      // failure would surface as a 403 on the next form the user submits.
      let payload = /** @type {unknown} */ (BFF_PAYLOAD);
      respondWith(() => json(payload));
      const store = new BffCookieTokenStore('/auth');
      await store.login(CREDENTIALS);

      const { csrfToken: _dropped, ...withoutCsrf } = BFF_PAYLOAD;
      payload = withoutCsrf;
      await store.refresh();

      assert.equal(await authorizedHeader(store, 'X-CSRF-Token'), 'csrf-1');
    });

    it('reads 401 as no session and 5xx as unavailable', async () => {
      respondWith(() => json({}, 401));
      const store = new BffCookieTokenStore('/auth');
      assert.equal(await store.init(), null);

      respondWith(() => json({}, 502));
      const unavailable = await rejection(() => store.init());
      assert.ok(unavailable instanceof AuthUnavailable, `502 gave ${String(unavailable)}`);
    });

    it('strips a trailing slash so the endpoints are not doubled', async () => {
      respondWith(() => json(BFF_PAYLOAD));
      await new BffCookieTokenStore('/auth/').init();
      assert.equal(new URL(present(sent[0]).url).pathname, '/auth/session');
    });
  });

  describe('dpop', () => {
    afterEach(async () => {
      // The key pair outlives the store, in IndexedDB. Left behind, it is a
      // fixture the next test did not ask for.
      globalThis.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
      await new DpopTokenStore('/auth/token').logout();
    });

    it('admits a token response and binds a proof to the request', async () => {
      respondWith(() => json(TOKEN_PAYLOAD));
      const store = new DpopTokenStore('/auth/token');

      const session = await store.login(CREDENTIALS);
      assert.equal(session.subject, 'user-ada');

      // The exchange itself carries a proof: that is how the server learns which
      // key to bind the issued token to. A root-relative endpoint has to resolve
      // to an absolute `htu` for the proof to be constructible at all.
      const exchange = present(sent[0]);
      assert.ok(exchange.headers.has('DPoP'), 'the token request carries a proof');

      const authorized = await store.authorize(new Request('/api/orders'));
      assert.equal(authorized.headers.get('Authorization'), 'DPoP at-1');
      assert.ok(authorized.headers.has('DPoP'), 'the API request carries a proof');
    });

    it('rejects a malformed token response and keeps no token', async () => {
      respondWith(() => json({ access_token: 'at-1', sub: 'user-ada', name: 'Ada' }));
      const store = new DpopTokenStore('/auth/token');

      await assert.rejects(() => store.login(CREDENTIALS), 'expires_in');
      assert.equal(await authorizedHeader(store, 'Authorization'), null);
    });
  });
});
