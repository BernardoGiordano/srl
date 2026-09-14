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
 *    under the input that caused it, without parsing a message;
 *  - one request for concurrent identical GETs, because a layout route and the tab
 *    inside it ask for the same record at the same time. See `SharedRead`.
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
    // No prototype, because the keys are the server's. A code named `__proto__` is
    // kept, and `fields.constructor` is undefined rather than a function. ADR-0118.
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

  /** Reads in flight, by URL. Emptied as each one settles; see `SharedRead`. */
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
   * A read, joining one already in flight for the same URL rather than sending a
   * second. `signal` still cancels this caller alone.
   *
   * @template T
   * @param {string} path
   * @param {Query} [query]
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  get(path, query, signal) {
    const url = this.#url(path, query);

    // Already gone. `fetch` rejects an aborted signal without sending, and joining
    // would make this caller's answer wait on requests it no longer wants.
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
  #send(path, init, query) {
    return this.#sendUrl(this.#url(path, query), init, path);
  }

  /**
   * The send itself, over a URL that has already been built: `get` needs that URL
   * as the key it shares a read under, and building it twice would be building it
   * differently one day.
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
      // Appended one at a time, so an array becomes `?status=a&status=b` — the form the
      // server's `anyOf` reads, and the only form that survives a value containing a comma.
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
 * One GET in flight, and everybody waiting on it.
 *
 * WHY THIS EXISTS
 *
 * A layout route fetches the record for its header and the tab rendered inside it
 * fetches the same record for its body, on the same navigation, because the router
 * hands a child no data and the injector has one root scope. Two identical GETs
 * left the browser for every detail screen. Coalescing them is one round trip
 * saved with no interface for a screen to learn.
 *
 * WHAT IT IS NOT
 *
 * Not a cache. The entry lives from the send to the settle and no longer, so a
 * second read that starts after the first finished is a second request and reads
 * whatever the server says now. Keying, staleness and revalidation are a store's
 * decisions, and a store is application code. ADR-0076, ADR-0101.
 *
 * WHAT IT OWNS
 *
 *  - **One request, many callers.** Each gets its own copy of the body, so sharing
 *    is invisible: two screens that both mutate what they were handed cannot see
 *    each other's edits, exactly as when each had its own response to parse.
 *  - **Cancellation per caller.** One caller's `signal` rejects that caller and
 *    nothing else. The request is aborted when the *last* one leaves, because a
 *    response nobody is waiting for is one worth not receiving.
 *  - **Its listeners.** Every terminal path drops the abort listener it put on a
 *    caller's signal, which for a long-lived screen is the same rule
 *    `resource()` follows for the same reason.
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
          // Dropped before the abort, or a `get` for this URL in the window between
          // the two would join a read that is already on its way to rejecting.
          this.#release();
          this.#request.abort(signal.reason);
        }
        // What `fetch` would have rejected this caller with, had it been the only
        // one. Relayed rather than wrapped: a caller that aborts with its own reason
        // reads that reason back, and `AbortSignal.reason` is typed `any`.
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
   * Settle everybody still waiting, in the order they arrived.
   *
   * The first of them owns the parsed body: it is the caller whose request this is,
   * and cloning for it would charge the common case — one caller, nothing shared —
   * for a copy nobody can observe.
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

  /** Once. A second call would delete a newer read stored under the same URL. */
  #release() {
    if (this.#dropped) return;
    this.#dropped = true;
    this.#drop();
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
