import { token } from '@core/foundation/inject.js';

/**
 * The outbound JSON client every application on this library shares. ADR-0013.
 *
 * It adds four things to `fetch`:
 *
 * - a base URL, so pointing at another API is a manifest edit
 * - query building that drops `undefined` and repeats array values
 * - one error type with the status and the server's error code, so a screen can tell
 *   403 from 500 and put a 422 under the right input
 * - one request for concurrent identical GETs (see `SharedRead`)
 *
 * The transport is a parameter, because the authorized path lives in `@auth/session.js`
 * and `core/` may not import `auth/`. `@auth/session-fetch.js` binds it to the session,
 * and tests, public APIs and remotes pass their own.
 *
 * `AuthSession.json()` is shorter when a screen doesn't branch on error codes. This
 * client reads the body itself, because the code lives in the body.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<ApiClient>} */
export const API_CLIENT = token('ApiClient');

/**
 * What the client sends through: `AuthSession.fetch`, `host.auth.fetch`, a test double
 * or `globalThis.fetch`.
 *
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} HttpTransport
 */

/**
 * A query value. Arrays become repeated parameters, and `undefined` is omitted.
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

  /** True when the user is authenticated but not entitled. Screens show a message instead of retrying. */
  get forbidden() {
    return this.status === 403;
  }

  /**
   * Per-field error codes from a 422, such as `{ email: 'taken' }`, or an empty object
   * for other failures.
   *
   * The server enforces rules the client can't, such as uniqueness, so a write can fail
   * on one field after the form looked valid. Codes let the screen show the message
   * under that input.
   *
   * @returns {Readonly<Record<string, string>>}
   */
  get fields() {
    // No prototype, because the keys come from the server.
    /** @type {unknown} */
    const empty = Object.create(null);
    const fields = /** @type {Record<string, string>} */ (empty);
    if (this.status !== 422 || typeof this.body !== 'object' || this.body === null) return fields;
    const raw = /** @type {{ fields?: unknown }} */ (this.body).fields;
    if (typeof raw !== 'object' || raw === null) return fields;
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') fields[key] = value;
    return fields;
  }
}

/**
 * Reads `{ "error": "code" }`, the shape both servers here send. Anything else becomes
 * `http_<status>`, such as a 500 from a proxy that never reached the API.
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

  /** Reads in flight, keyed by URL. Each entry is removed when it settles. */
  /** @type {Map<string, SharedRead>} */
  #reads = new Map();

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
   * A GET that joins a read already in flight for the same URL. `signal` still cancels
   * only this caller.
   *
   * @template T
   * @param {string} path
   * @param {Query} [query]
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  get(path, query, signal) {
    const url = this.#url(path, query);

    // An already aborted signal rejects without joining, as `fetch` would.
    if (signal?.aborted === true) return this.#sendUrl(url, { signal }, path);

    const joined = this.#reads.get(url);
    if (joined !== undefined) return /** @type {Promise<T>} */ (joined.join(signal));

    const read = new SharedRead(
      (shared) => this.#sendUrl(url, { signal: shared }, path),
      () => this.#reads.delete(url),
    );
    this.#reads.set(url, read);
    return /** @type {Promise<T>} */ (read.join(signal));
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
   * PUT, for a write addressed by what it writes, such as one account's balance for one
   * month. Sending it twice still leaves one balance.
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
   * The event-stream URL. `EventSource` opens the connection itself, and building the
   * URL here keeps the base URL in one place.
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
  #send(path, init, query) {
    return this.#sendUrl(this.#url(path, query), init, path);
  }

  /**
   * Send to an already built URL. `get` builds the URL once and also uses it as the
   * sharing key.
   *
   * @template T
   * @param {string} url
   * @param {RequestInit} init
   * @param {string} path Carried on the error, where the base URL would be noise.
   * @returns {Promise<T>}
   */
  async #sendUrl(url, init, path) {
    const response = await this.#fetch(url, {
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
      // Append each value, so an array becomes `?status=a&status=b`, which survives
      // values that contain commas.
      for (const entry of queryValues(value)) url.searchParams.append(key, entry);
    }
    return url.href;
  }
}

/**
 * One caller waiting on a shared read.
 *
 * @typedef {object} Waiting
 * @property {(value: unknown) => void} resolve
 * @property {(cause: unknown) => void} reject
 * @property {() => void} stopListening Drops this caller's abort listener. Called on every path that settles it.
 */

/**
 * One GET in flight and every caller waiting on it.
 *
 * A layout and the tab inside it often fetch the same record on the same navigation,
 * because the router hands a child no data. Sharing the request saves a round trip
 * without a new interface.
 *
 * It isn't a cache. The entry lives from send to settle, so a later read sends a new
 * request. Caching belongs in an application store. ADR-0076, ADR-0013.
 *
 * - Each caller gets its own copy of the body, so callers can't see each other's
 *   mutations.
 * - A caller's `signal` rejects only that caller. The request aborts when the last
 *   caller leaves.
 * - Every path that settles a caller removes its abort listener.
 */
class SharedRead {
  /** @type {Set<Waiting>} */
  #waiting = new Set();

  #request = new AbortController();

  /** @type {() => void} */
  #drop;

  #dropped = false;

  /**
   * @param {(signal: AbortSignal) => Promise<unknown>} send
   * @param {() => void} drop Removes this read from the client's map. Called once, before anybody is settled.
   */
  constructor(send, drop) {
    this.#drop = drop;
    void this.#run(send);
  }

  /**
   * Wait on this read, cancelled by `signal` alone.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<unknown>}
   */
  join(signal) {
    return new Promise((resolve, reject) => {
      /** @type {Waiting} */
      const waiting = { resolve, reject, stopListening: () => {} };
      this.#waiting.add(waiting);

      if (signal === undefined) return;

      const leave = () => {
        this.#waiting.delete(waiting);
        if (this.#waiting.size === 0) {
          // Drop the entry before aborting, so a `get` in between starts a fresh
          // request instead of joining a failing one.
          this.#release();
          this.#request.abort(signal.reason);
        }
        // Reject with the signal's own reason, as `fetch` would.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      };

      signal.addEventListener('abort', leave, { once: true });
      waiting.stopListening = () => signal.removeEventListener('abort', leave);
    });
  }

  /** @param {(signal: AbortSignal) => Promise<unknown>} send */
  async #run(send) {
    try {
      const body = await send(this.#request.signal);
      this.#release();
      this.#settle((waiting, own) => waiting.resolve(own ? body : structuredClone(body)));
    } catch (cause) {
      this.#release();
      this.#settle((waiting) => waiting.reject(cause));
    }
  }

  /**
   * Settle everyone still waiting, in arrival order. The first caller gets the parsed
   * body itself, so the common single-caller case skips the clone.
   *
   * @param {(waiting: Waiting, own: boolean) => void} settle
   */
  #settle(settle) {
    let own = true;
    for (const waiting of this.#waiting) {
      waiting.stopListening();
      settle(waiting, own);
      own = false;
    }
    this.#waiting.clear();
  }

  /** Remove the entry once. A second call would delete a newer read under the same URL. */
  #release() {
    if (this.#dropped) return;
    this.#dropped = true;
    this.#drop();
  }
}

/**
 * Serialize a JSON body. An `undefined` body, as on a DELETE, sends nothing instead of
 * `null` with a JSON content type.
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
  // `typeof === 'object'` narrows to `readonly string[]`, where `Array.isArray` would
  // narrow to `any[]`.
  return typeof value === 'object' ? [...value] : [String(value)];
}

/**
 * `JSON.parse`, typed to return `unknown` instead of `any`.
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
    // HTML from a JSON endpoint is a routing mistake, and this error says so.
    throw new ApiError(response.status, 'malformed_json', response.url);
  }
}
