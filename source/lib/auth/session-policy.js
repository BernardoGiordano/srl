import { readJson } from '@core/foundation/json.js';

/** @import { Session } from '@auth/types.js' */

/**
 * Session admission: how an untrusted authentication payload becomes session
 * state, and the one place a failed exchange is classified.
 *
 * A store reads its own payload and calls `sessionFrom()` with the values it
 * found. The validators below are exported for that: a store gets the same
 * refusals and the same never-print-the-value messages without restating them.
 *
 *     const payload = asRecord(await readPayload(response, where), where);
 *     return sessionFrom(
 *       {
 *         subject: payload.sub,
 *         name: payload.name,
 *         scopes: scopesFromSpaceDelimited(payload.scope, `${where}: scope`),
 *         expiresAt: expiryFromLifetime(payload.expires_in, `${where}: expires_in`),
 *       },
 *       where,
 *     );
 *
 * ## Two failures, and why the difference is load-bearing
 *
 * The refresh timer acts on the result with no human present, so "the server says
 * this session is over" and "the server did not answer" cannot be one error type.
 * ADR-0024.
 *
 *   `AuthRejected`     terminal. The grant was refused (4xx) or the payload could
 *                      not be admitted. Retrying sends the same credentials to the
 *                      same endpoint for the same answer. The session ends.
 *   `AuthUnavailable`  transient. Transport failed or the server answered 5xx.
 *                      The session's own expiry has not passed, so the honest
 *                      state is "not yet known" and the caller may retry until it
 *                      does.
 *
 * What belongs here: the `Session` shape, error classification and normalization.
 * What does not: performing the exchange and reading a payload (a store, which the
 * application owns), and deciding what a failure does to session state
 * (`session.js`).
 */

/** Scope lists are space-delimited per RFC 6749; any run of whitespace is one separator. */
const SCOPE_SEPARATOR = /\s+/u;

/**
 * The session cannot continue, and no retry will change that.
 *
 * Carries no payload beyond its message deliberately: everything a screen may
 * show a user is already in the message, and everything else in an auth error
 * response is either a credential, a hint about one, or a server-side detail
 * that belongs in the server's log rather than in the browser's.
 */
export class AuthRejected extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'AuthRejected';
  }
}

/** The answer is not known yet. The caller may retry; the session is untouched. */
export class AuthUnavailable extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'AuthUnavailable';
  }
}

/**
 * A transport failure, as the transient error.
 *
 * `fetch` rejects for DNS, TLS, offline and CORS alike, and the browser
 * deliberately does not say which. Treating all of them as "not known yet" is the
 * only classification the information supports.
 *
 * @param {string} where
 * @param {unknown} cause
 * @returns {AuthUnavailable}
 */
export function unreachable(where, cause) {
  return new AuthUnavailable(`${where} could not be reached.`, { cause });
}

/**
 * Turn a non-OK response into the error its status class means, with the server's
 * own error code in the message when it sent one.
 *
 * Async because reading the code means reading the body, and a caller that had to
 * remember to do that first would be a caller that sometimes did not.
 *
 * @param {Response} response
 * @param {string} where
 * @returns {Promise<AuthRejected | AuthUnavailable>}
 */
export async function failureFor(response, where) {
  const status = String(response.status);
  const code = await readErrorCode(response);
  const detail = code === null ? '' : `: ${code}`;

  return response.status >= 500
    ? new AuthUnavailable(`${where} answered ${status}${detail}.`)
    : new AuthRejected(`${where} refused the request with ${status}${detail}.`);
}

/**
 * The server's machine-readable error code, normalized across the two shapes an
 * OAuth-ish endpoint uses, or null when the body carries neither.
 *
 * Never throws. It runs on a path that is already failing, and an error while
 * building an error message replaces a diagnosable failure with an undiagnosable
 * one.
 *
 * @param {Response} response
 * @returns {Promise<string | null>}
 */
async function readErrorCode(response) {
  try {
    /** @type {unknown} */
    const body = await readJson(response);
    if (typeof body !== 'object' || body === null) return null;
    const record = /** @type {Record<string, unknown>} */ (body);
    // `error` is RFC 6749; `message` is what most hand-written endpoints send.
    for (const key of ['error', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read a successful response's body as an unadmitted value.
 *
 * A token endpoint that answers 200 with HTML is the single most common
 * misconfiguration here — a history fallback in front of a missing route — and
 * `SyntaxError: Unexpected token '<'` names neither the endpoint nor the reason.
 *
 * @param {Response} response
 * @param {string} where
 * @returns {Promise<unknown>}
 */
export async function readPayload(response, where) {
  try {
    /** @type {unknown} */
    const body = await readJson(response);
    return body;
  } catch (cause) {
    throw new AuthRejected(`${where} answered with a body that is not JSON.`, { cause });
  }
}

/**
 * Build a `Session` from values a store has read out of its own payload.
 *
 * Every field is re-validated here even though a store will usually have used the
 * validators below on the way in. That is deliberate: this is the only way to
 * obtain a `Session`, so it is the only place that has to be right, and a store
 * that mapped a field by hand cannot produce one the rest of the library then
 * trusts.
 *
 * Note what the signature does not take: an access token. A `Session` is read by
 * guards, screens and the remote host contract, and a credential on it would
 * eventually be logged, serialised into a diagnostic, or handed to a
 * micro-frontend by an `onChange` listener that copies the object. A store keeps
 * its credential in a private field; nothing else ever sees one. ADR-0021.
 *
 * @param {{ subject: unknown, name: unknown, scopes?: unknown, expiresAt: unknown }} fields
 * @param {string} where
 * @returns {Session}
 */
export function sessionFrom(fields, where) {
  /** @type {Session} */
  const session = {
    subject: requireString(fields.subject, `${where}: subject`),
    name: requireString(fields.name, `${where}: name`),
    scopes: fields.scopes === undefined ? [] : requireStrings(fields.scopes, `${where}: scopes`),
    expiresAt: requireInstant(fields.expiresAt, `${where}: expiresAt`),
  };
  Object.freeze(session.scopes);
  return Object.freeze(session);
}

/**
 * An absolute expiry from a lifetime in seconds, for the endpoints that answer
 * with one.
 *
 * The arithmetic is here rather than in each store because a store that did it
 * itself could produce `NaN` from an unchecked field and schedule a refresh that
 * never fires.
 *
 * @param {unknown} value seconds
 * @param {string} where
 * @returns {number} epoch milliseconds
 */
export function expiryFromLifetime(value, where) {
  return Date.now() + requireDuration(value, where) * 1000;
}

/**
 * A space-delimited scope string as a list, per RFC 6749, for the endpoints that
 * answer with one. Absent means no scopes rather than a malformed document.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {string[]}
 */
export function scopesFromSpaceDelimited(value, where) {
  if (value === undefined) return [];
  const raw = requireString(value, where);
  return raw.split(SCOPE_SEPARATOR).filter((scope) => scope !== '');
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
export function asRecord(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthRejected(`${where} answered with ${describe(value)} where an object was expected.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
export function requireString(value, where) {
  if (typeof value !== 'string' || value === '') {
    throw new AuthRejected(`${where} must be a non-empty string, got ${describe(value)}.`);
  }
  return value;
}

/**
 * A lifetime in seconds. Zero and negative values are refused rather than
 * clamped: a token that is already expired on arrival is a server saying
 * something is wrong with its clock or its configuration, and a session built on
 * it would refresh in a loop.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {number}
 */
export function requireDuration(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AuthRejected(`${where} must be a positive number of seconds, got ${describe(value)}.`);
  }
  return value;
}

/**
 * An absolute instant in epoch milliseconds. Not required to be in the future:
 * a `/session` probe answering with an expiry that has just passed is a race the
 * refresh path handles, not a malformed document.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {number}
 */
export function requireInstant(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuthRejected(`${where} must be epoch milliseconds, got ${describe(value)}.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string[]}
 */
export function requireStrings(value, where) {
  if (!Array.isArray(value)) {
    throw new AuthRejected(`${where} must be an array of strings, got ${describe(value)}.`);
  }
  return /** @type {unknown[]} */ (value).map((entry, index) =>
    requireString(entry, `${where}[${String(index)}]`),
  );
}

/**
 * A value named in a message without ever printing it.
 *
 * These messages describe an authentication payload, and an authentication
 * payload is exactly the object whose values must not reach a console, a log
 * shipper or a bug report. The type and, for strings, the length is enough to
 * tell a missing field from a wrong one.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a ${String(value.length)}-character string`;
  return `a value of type ${typeof value}`;
}
