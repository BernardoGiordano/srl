import {
  AuthRejected,
  asRecord,
  failureFor,
  readPayload,
  requireInstant,
  requireString,
  requireStrings,
  sessionFrom,
  unreachable,
} from '@auth/session-policy.js';

/** @import { Session, TokenStore } from '@auth/types.js' */

/**
 * Backend-for-frontend. The recommended architecture, and the only one here that
 * actually removes tokens from the browser's threat model.
 *
 * THIS FILE IS APPLICATION CODE, DELIBERATELY
 *
 * Every wire fact below — the three paths, the JSON bodies, the field names in
 * the response, the `X-CSRF-Token` header — is a contract with *this*
 * application's backend, and the library has no business asserting any of it.
 * What the library supplies is the `TokenStore` seam, the two error types, and
 * `sessionFrom()`. Copy this file into your own application and change the parts
 * your server disagrees with; nothing in `source/lib/` needs to know.
 *
 * A same-origin backend performs the OAuth flow, holds the access and refresh
 * tokens in server-side session state, and proxies API calls. The browser gets
 * one HttpOnly, Secure, SameSite cookie that JavaScript cannot read, plus a
 * readable CSRF token to prove requests originate from the app rather than from
 * a cross-site form post.
 *
 * Look at `authorize()` below: it adds a CSRF header and nothing else. There is
 * no token to attach, because the browser attaches the cookie and this code never
 * possesses a credential. An XSS payload on this origin can make authenticated
 * requests, which is unavoidable in any browser architecture, but it cannot
 * exfiltrate anything reusable elsewhere, cannot mint proofs, and cannot obtain a
 * token that outlives the cookie.
 *
 * What it costs: a backend, one network hop, and session state to operate.
 *
 * Server contract expected:
 *   POST   {base}/login    credentials in, Set-Cookie + CSRF token out
 *   DELETE {base}/login    clears the cookie and revokes server-side
 *   GET    {base}/session  current session, or 401
 *
 * @implements {TokenStore}
 */
export class BffCookieTokenStore {
  strategy = /** @type {'bff'} */ ('bff');

  /**
   * Readable by design. A CSRF token is not a secret from this page; it is proof
   * that a request came from this page. Its whole job is to be attachable by our
   * JavaScript and not by a cross-origin attacker's.
   *
   * @type {string | null}
   */
  #csrfToken = null;

  #baseUrl;

  /** @param {string} baseUrl */
  constructor(baseUrl) {
    this.#baseUrl = baseUrl.replace(/\/+$/u, '');
  }

  /** @returns {Promise<Session | null>} */
  async init() {
    const where = `The session endpoint ${this.#baseUrl}/session`;
    const response = await this.#send(`${this.#baseUrl}/session`, { credentials: 'same-origin' }, where);

    // No cookie, or one the backend has already discarded. The ordinary
    // first-visit answer, not a failure.
    if (response.status === 401) {
      this.#csrfToken = null;
      return null;
    }
    if (!response.ok) throw await failureFor(response, where);
    return this.#read(response, where);
  }

  /**
   * @param {unknown} credentials
   * @returns {Promise<Session>}
   */
  async login(credentials) {
    const where = `The login endpoint ${this.#baseUrl}/login`;
    const body = asRecord(credentials, `${where}: credentials`);
    const response = await this.#send(
      `${this.#baseUrl}/login`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: requireString(body.username, `${where}: credentials.username`),
          password: requireString(body.password, `${where}: credentials.password`),
        }),
      },
      where,
    );

    if (response.status === 401 || response.status === 403) {
      throw new AuthRejected(`${where} rejected the credentials.`);
    }
    if (!response.ok) throw await failureFor(response, where);
    return this.#read(response, where);
  }

  async logout() {
    this.#csrfToken = null;
    await fetch(`${this.#baseUrl}/login`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }

  /**
   * The backend refreshes on its own schedule, transparently, as part of proxying
   * a call. From the browser's side "refresh" is just: is the session still
   * alive?
   *
   * @returns {Promise<Session | null>}
   */
  refresh() {
    return this.init();
  }

  /**
   * Adds a CSRF header and nothing else. There is no token to attach: the browser
   * sends the HttpOnly cookie, and this code never possesses a credential.
   *
   * Not `async`, because there is nothing to await. The interface returns a
   * Promise so that callers need not know which strategy they are talking to.
   *
   * @param {Request} request
   * @returns {Promise<Request>}
   */
  authorize(request) {
    const authorized = new Request(request);
    if (this.#csrfToken !== null) {
      authorized.headers.set('X-CSRF-Token', this.#csrfToken);
    }
    return Promise.resolve(authorized);
  }

  /**
   * One request, with transport failure classified as the transient error rather
   * than escaping as a bare `TypeError` that nothing upstream can tell apart from
   * a bug.
   *
   * @param {string} url
   * @param {RequestInit} init
   * @param {string} where
   * @returns {Promise<Response>}
   */
  async #send(url, init, where) {
    try {
      return await fetch(url, init);
    } catch (cause) {
      throw unreachable(where, cause);
    }
  }

  /**
   * @param {Response} response
   * @param {string} where
   * @returns {Promise<Session>}
   */
  async #read(response, where) {
    const payload = asRecord(await readPayload(response, where), where);

    // A `/session` probe need not reissue the CSRF token. Keeping the one we hold
    // when the field is absent is what makes a probe a probe rather than
    // something that can silently disarm every later write.
    if (payload.csrfToken !== undefined) {
      this.#csrfToken = requireString(payload.csrfToken, `${where}: csrfToken`);
    }

    // The expiry arrives as an absolute instant rather than a lifetime, because
    // the backend owns the token and the browser holds none to time.
    return sessionFrom(
      {
        subject: payload.sub,
        name: payload.name,
        scopes: payload.scopes === undefined ? [] : requireStrings(payload.scopes, `${where}: scopes`),
        expiresAt: requireInstant(payload.expiresAt, `${where}: expiresAt`),
      },
      where,
    );
  }
}
