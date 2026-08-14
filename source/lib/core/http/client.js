import { token } from '@core/foundation/inject.js';

/**
 * The outbound JSON path every application on this library shares.
 *
 * Both applications wrote this themselves before it was pulled up here, and the
 * two copies had already drifted. ADR-0013.
 *
 * WHAT IT IS OVER `fetch`
 *
 *  - the base URL, so a deployment pointed at another API is a manifest edit and
 *    not a search for string concatenation;
 *  - query building that drops `undefined` and expands an array into repeated
 *    parameters, so no service assembles a query string by hand;
 *  - one error type carrying the status and the server's own error code, so a
 *    screen can tell "you may not" (403) from "it broke" (500) and can put a 422
 *    under the input that caused it, without parsing a message.
 *
 * WHY THE TRANSPORT IS A PARAMETER
 *
 * The authorized path lives in `@auth/session.js` and `core/` may not import
 * `auth/`, so the client takes the function it sends through. ADR-0013.
 * `@auth/session-fetch.js` is the adapter that binds it to the session; a test, a
 * public API with no session at all, or a remote handed `host.auth.fetch` supplies
 * its own and needs nothing from auth.
 *
 * `AuthSession.json()` is the shorter path and the right one for an application
 * with nothing to distinguish. This reads the response itself because screens
 * branch on the code in the body, and that body is gone by the time a thrown
 * `Error` reaches the caller.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<ApiClient>} */
export const API_CLIENT = token('ApiClient');

/**
 * What the client sends through: `AuthSession.fetch`, `host.auth.fetch`, a test
 * double, or `globalThis.fetch` for an API that needs no credential.
 *
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} HttpTransport
 */

/**
 * A query value. Arrays become repeated parameters; `undefined` is omitted.
 *
 * @typedef {string | number | boolean | undefined | readonly string[]} QueryValue
 */

/** @typedef {Record<string, QueryValue>} Query */

/**
 * How a failed response becomes the machine-readable code on the error.
 *
 * @typedef {(status: number, body: unknown) => string} ErrorCode
 */

/**
 * @typedef {object} ApiClientOptions
 * @property {HttpTransport} fetch The authorized path this client sends through.
 * @property {ErrorCode} [errorCode] The server's error shape, when it is not `{ error }`.
 */

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code Server-supplied, machine-readable.
   * @param {string} path
   * @param {unknown} [body] The parsed response body, for the details a code cannot carry.
   */
  constructor(status, code, path, body) {
    super(`${String(status)} ${code} for ${path}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.body = body;
  }

  /** Authenticated, but not entitled. The screens show this rather than retrying. */
  get forbidden() {
    return this.status === 403;
  }

  /**
   * Per-field error codes from a 422, as `{ email: 'taken' }`, or an empty object for
   * every other failure.
   *
   * The server owns rules no client can check — uniqueness, cross-record sums — so a
   * write can fail on a specific field after the form said it was valid. Returning the
   * codes rather than one sentence is what lets the screen put the message under the
   * input that caused it instead of in a banner at the top.
   *
   * @returns {Readonly<Record<string, string>>}
   */
  get fields() {
    if (this.status !== 422 || typeof this.body !== 'object' || this.body === null) return {};
    const raw = /** @type {{ fields?: unknown }} */ (this.body).fields;
    if (typeof raw !== 'object' || raw === null) return {};
    /** @type {Record<string, string>} */
    const fields = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') fields[key] = value;
    return fields;
  }
}

/**
 * `{ "error": "code" }` is the shape both servers here answer with, and the
 * fallback names the status rather than inventing agreement: a 500 from a proxy
 * that never reached the API has no code, and `http_500` says so.
 *
 * @type {ErrorCode}
 */
function defaultErrorCode(status, body) {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    return String(/** @type {{ error: unknown }} */ (body).error);
  }
  return `http_${String(status)}`;
}

export class ApiClient {
  #baseUrl;
  #fetch;
  #errorCode;

  /**
   * @param {string} baseUrl
   * @param {ApiClientOptions} options
   */
  constructor(baseUrl, options) {
    this.#baseUrl = baseUrl.replace(/\/+$/u, '');
    this.#fetch = options.fetch;
    this.#errorCode = options.errorCode ?? defaultErrorCode;
  }

  /**
   * @template T
   * @param {string} path
   * @param {Query} [query]
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  get(path, query, signal) {
    return this.#send(path, { signal }, query);
  }

  /**
   * @template T
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<T>}
   */
  post(path, body) {
    return this.#send(path, { method: 'POST', ...jsonBody(body) });
  }

  /**
   * @template T
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<T>}
   */
  patch(path, body) {
    return this.#send(path, { method: 'PATCH', ...jsonBody(body) });
  }

  /**
   * PUT, for a write whose address is the thing being written rather than an
   * identifier the server invents — one account's balance for one month, sent
   * twice, has to be one balance.
   *
   * @template T
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<T>}
   */
  put(path, body) {
    return this.#send(path, { method: 'PUT', ...jsonBody(body) });
  }

  /**
   * @template T
   * @param {string} path
   * @returns {Promise<T>}
   */
  delete(path) {
    return this.#send(path, { method: 'DELETE' });
  }

  /**
   * The event-stream URL. Not fetched through this client — `EventSource` opens
   * the connection itself — but built here so the base URL is written down once.
   *
   * @param {string} path
   * @param {Query} [query]
   * @returns {string}
   */
  streamUrl(path, query) {
    return this.#url(path, query);
  }

  /**
   * @template T
   * @param {string} path
   * @param {RequestInit} init
   * @param {Query} [query]
   * @returns {Promise<T>}
   */
  async #send(path, init, query) {
    const response = await this.#fetch(this.#url(path, query), {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    });
    const body = await readBody(response);
    if (!response.ok) throw new ApiError(response.status, this.#errorCode(response.status, body), path, body);
    return /** @type {T} */ (body);
  }

  /**
   * @param {string} path
   * @param {Query} [query]
   * @returns {string}
   */
  #url(path, query) {
    const url = new URL(`${this.#baseUrl}${path}`, location.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      // Appended one at a time, so an array becomes `?status=a&status=b` — the form the
      // server's `anyOf` reads, and the only form that survives a value containing a comma.
      for (const entry of queryValues(value)) url.searchParams.append(key, entry);
    }
    return url.href;
  }
}

/**
 * A body is serialised here rather than at each verb so that `undefined` — the
 * absent body of a DELETE — never becomes the four bytes `null` with a
 * Content-Type claiming they are JSON.
 *
 * @param {unknown} body
 * @returns {RequestInit}
 */
function jsonBody(body) {
  if (body === undefined) return {};
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * @param {Exclude<QueryValue, undefined>} value
 * @returns {string[]}
 */
function queryValues(value) {
  // `typeof === 'object'` rather than `Array.isArray`: the array is the only object in the
  // union, so this narrows to `readonly string[]` where `isArray` narrows to `any[]` and
  // spreads that `any` into every caller.
  return typeof value === 'object' ? [...value] : [String(value)];
}

/**
 * `JSON.parse` is declared to return `any`, and that `any` spreads into every caller —
 * `@core/foundation/json.js` has the same note. An annotated alias fixes it without a cast:
 * the assignment is checked (any is assignable to unknown) and every call through this name
 * returns `unknown`, which has to be narrowed rather than trusted.
 *
 * @type {(text: string) => unknown}
 */
const parseJson = JSON.parse;

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text === '') return null;
  try {
    return parseJson(text);
  } catch {
    // A JSON endpoint that answered with HTML is a routing mistake, and saying so
    // beats "Unexpected token '<'" from a parser three frames down.
    throw new ApiError(response.status, 'malformed_json', response.url);
  }
}
