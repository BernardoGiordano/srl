import {
  AuthRejected,
  asRecord,
  expiryFromLifetime,
  failureFor,
  readPayload,
  requireString,
  scopesFromSpaceDelimited,
  sessionFrom,
  unreachable,
} from '@auth/session-policy.js';

/** @import { Session, TokenStore } from '@auth/types.js' */

/**
 * Access token in memory, refresh token in an HttpOnly cookie.
 *
 * THIS FILE IS APPLICATION CODE, DELIBERATELY
 *
 * The endpoint, the `grant_type` bodies and the OAuth field names below are a
 * contract with *this* application's authorization server. The library supplies
 * the `TokenStore` seam, the two error types and `sessionFrom()`, and asserts
 * nothing about the wire.
 *
 * The token lives in a private field and nowhere else. Not localStorage, not
 * sessionStorage, not IndexedDB. Those all persist across reloads, which sounds
 * like a feature until you notice it means the token is readable by any script
 * that gets a foothold on the origin, for as long as it remains valid.
 *
 * Persistence across reload comes from the refresh token instead, which the
 * authorization server sets as an HttpOnly cookie and which JavaScript therefore
 * cannot read at all. On startup `init()` spends that cookie for a fresh access
 * token. A reload costs one network round trip; an XSS payload gets a token that
 * dies with the tab and cannot be renewed once the tab closes.
 *
 * What this does not do: survive with the tab closed, or share a session between
 * tabs by itself. Each tab performs its own refresh. AuthSession's
 * BroadcastChannel coordinates logout across tabs but cannot share the in-memory
 * token, by design.
 *
 * @implements {TokenStore}
 */
export class MemoryTokenStore {
  strategy = /** @type {'memory'} */ ('memory');

  /** @type {string | null} */
  #accessToken = null;

  #tokenEndpoint;

  /** @param {string} tokenEndpoint */
  constructor(tokenEndpoint) {
    this.#tokenEndpoint = tokenEndpoint;
  }

  /** @returns {Promise<Session | null>} */
  async init() {
    // Spend the HttpOnly refresh cookie, if the browser has one. A 401 here is
    // the normal "not logged in" path, not an error.
    return this.#exchange({ grant_type: 'refresh_token' }, { allowUnauthenticated: true });
  }

  /**
   * @param {unknown} credentials
   * @returns {Promise<Session>}
   */
  async login(credentials) {
    const where = `The token endpoint ${this.#tokenEndpoint}`;
    const given = asRecord(credentials, `${where}: credentials`);
    const session = await this.#exchange(
      {
        grant_type: 'password',
        username: requireString(given.username, `${where}: credentials.username`),
        password: requireString(given.password, `${where}: credentials.password`),
      },
      { allowUnauthenticated: false },
    );
    if (session === null) throw new Error('Login failed.');
    return session;
  }

  async logout() {
    this.#accessToken = null;
    // Ask the server to clear the refresh cookie and revoke the grant. Local
    // state is already gone regardless of whether this succeeds.
    await fetch(this.#tokenEndpoint, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }

  /** @returns {Promise<Session | null>} */
  refresh() {
    return this.#exchange({ grant_type: 'refresh_token' }, { allowUnauthenticated: true });
  }

  /**
   * Not `async`: attaching a bearer header is synchronous. The interface returns a
   * Promise because the DPoP strategy has to sign, and a caller must not need to
   * know which strategy it is talking to.
   *
   * @param {Request} request
   * @returns {Promise<Request>}
   */
  authorize(request) {
    if (this.#accessToken === null) return Promise.resolve(request);
    const authorized = new Request(request);
    authorized.headers.set('Authorization', `Bearer ${this.#accessToken}`);
    return Promise.resolve(authorized);
  }

  /**
   * One token exchange, from request to admitted session.
   *
   * Every failure leaves this store holding no access token and raises one of the
   * two errors `@auth/session-policy.js` defines, because `AuthSession` schedules
   * refreshes against them: a refused grant ends the session, an unreachable
   * endpoint does not.
   *
   * @param {Record<string, string>} body
   * @param {{ allowUnauthenticated: boolean }} options
   * @returns {Promise<Session | null>}
   */
  async #exchange(body, options) {
    const where = `The token endpoint ${this.#tokenEndpoint}`;

    let response;
    try {
      response = await fetch(this.#tokenEndpoint, {
        method: 'POST',
        // Required for the refresh cookie to be sent at all.
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw unreachable(where, cause);
    }

    if (response.status === 401 || response.status === 403) {
      this.#accessToken = null;
      // The one expected non-answer: no refresh cookie, or one the server no
      // longer honours. That is "nobody is signed in", not a failure.
      if (options.allowUnauthenticated) return null;
      throw new AuthRejected(`${where} rejected the credentials.`);
    }
    if (!response.ok) {
      this.#accessToken = null;
      throw await failureFor(response, where);
    }

    // Cleared before admission and assigned only after it. The server has
    // answered, so whatever we held is now the previous answer; if this one turns
    // out to be unadmissible, `AuthSession` ends the session, and a store still
    // holding the old token would go on authorizing requests for a session that
    // no longer exists.
    this.#accessToken = null;
    const session = readTokenResponse(await readPayload(response, where), where);
    this.#accessToken = session.accessToken;
    return session.session;
  }
}

/**
 * An RFC 6749 token response, as this authorization server sends it, rebuilt into
 * a `Session` plus the credential the store keeps privately.
 *
 * The token is returned beside the session rather than on it: a `Session` reaches
 * guards, screens and the remote host contract, and a credential on it would
 * eventually be logged or copied into a diagnostic. ADR-0021, ADR-0023.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {{ accessToken: string, session: Session }}
 */
export function readTokenResponse(value, where) {
  const payload = asRecord(value, where);

  return {
    accessToken: requireString(payload.access_token, `${where}: access_token`),
    session: sessionFrom(
      {
        subject: payload.sub,
        name: payload.name,
        scopes: scopesFromSpaceDelimited(payload.scope, `${where}: scope`),
        expiresAt: expiryFromLifetime(payload.expires_in, `${where}: expires_in`),
      },
      where,
    ),
  };
}
