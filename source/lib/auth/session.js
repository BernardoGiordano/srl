import { computed, signal } from '@core/foundation/reactive.js';
import { token } from '@core/foundation/inject.js';
import { readJson } from '@core/foundation/json.js';
import { AuthUnavailable } from '@auth/session-policy.js';

/** @import { AuthSessionOptions, Session, TokenStore } from '@auth/types.js' */

/**
 * The authenticated request lifecycle, whole.
 *
 * This module owns one session, from restore to disposal, and every outbound request
 * that carries it. Callers get `login`, `logout`, `fetch`, `json` and three signals.
 * They do not get the ordering rules, because those are the part that keeps escaping. A
 * refresh has to be shared across concurrent 401s, coordinated across tabs, scheduled
 * before expiry, retried when the network is down but not when the grant is refused,
 * and abandoned on disposal. Spread across files, module scope and nowhere, those five
 * rules do not hold together.
 *
 * The single-flight refresh is a private field rather than module state, so two sessions
 * on one page do not deduplicate against each other. ADR-0022.
 *
 * No token lives in this file, and that is what makes the seam an interface. A
 * `TokenStore` is supplied by the application, and it owns the endpoints, the request
 * bodies, the response field names and the headers, because those are its backend's
 * facts rather than the library's. `@auth/session-policy.js` has the errors and the
 * `Session` builder a store is written against. ADR-0021 says why the seam is shaped
 * this way, and the applications in this repository each carry a worked implementation.
 *
 * The interface exposes no way to get a raw token. Stores authorize a `Request`, never
 * hand out a credential, and neither does this class. They stay adapters behind that
 * seam, performing an exchange and admitting its payload, and deciding nothing about
 * session state, retries or scheduling.
 *
 * This class makes three decisions a store never sees. Audience says which origins a
 * request may carry credentials to. Renewal extends only a live session, so a 401 after
 * logout cannot restore one. Cadence keeps the refresh timer from looping on a short
 * lifetime, a skewed clock or an expiry past the timer's range. ADR-0130.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<AuthSession>} */
export const AUTH_SESSION = token('AuthSession');

/** Refresh this long before the access token expires, or halfway through a shorter lifetime. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * A refresh whose answer is due again sooner than this bought no time. A lifetime under
 * it, or a clock ahead of the server's, causes that, and the second such answer in a
 * row waits on the backoff.
 */
const REFRESH_FLOOR_MS = 5_000;

/** The longest delay `setTimeout` honours. Engines fire a longer one at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Marks this document's broadcasts. Another session in the same page shares no state
 * with this one, so it ignores them. `getRandomValues` works outside a secure context.
 */
const DOCUMENT_ID = Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) => part.toString(36)).join('');

/**
 * Backoff for a refresh that could not reach an answer, in order, and the last delay
 * repeats. Bounded by the token's own expiry in every case, so the token decides how
 * long a dead session survives rather than the sequence. The timer also waits on it
 * when refreshes keep arriving already due.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

export class AuthSession {
  /** @type {import('@core/foundation/types.js').Signal<Session | null>} */
  session = signal(/** @type {Session | null} */ (null));

  isAuthenticated = computed(() => this.session.value !== null);

  /** @type {import('@core/foundation/types.js').ReadonlySignal<readonly string[]>} */
  scopes = computed(() => this.session.value?.scopes ?? []);

  #store;

  /** The cross-tab channel's name. */
  #channelName;

  /** Origins a request may carry credentials to. */
  /** @type {ReadonlySet<string>} */
  #audience;

  /** Consecutive sessions applied with their refresh already due within the floor. */
  #dueStreak = 0;

  /** Scheduled refresh, or the backoff retry after one could not reach an answer. */
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;

  /** @type {BroadcastChannel | undefined} */
  #channel;

  /**
   * The one refresh every concurrent caller waits on. Cleared when it settles, so
   * the next 401 starts a new one rather than resolving against a stale answer.
   *
   * @type {Promise<Session | null> | undefined}
   */
  #refreshInFlight;

  /**
   * Bumped whenever something other than a refresh decides what the session is, such
   * as a login, a logout, a broadcast from another tab, or disposal.
   *
   * An exchange that started before one of those must not apply its answer after it.
   * Without this, signing out while a refresh is in flight signs you back in a moment
   * later, because the exchange resolves, applies a valid session, and the screen the
   * user just left comes back. The generation is captured when the exchange starts and
   * compared when it settles.
   */
  #generation = 0;

  #disposed = false;

  #requests = new AbortController();

  /** Store mutations run in order, including cleanup after a superseded exchange. */
  #storeWork = Promise.resolve();

  /**
   * Settles when the latest login, logout or restore has reached the store. Requests
   * wait for it before authorizing, but never for a refresh alone, because a refresh
   * keeps the subject and the current token stays valid until it lands.
   */
  #identityWork = Promise.resolve();

  /**
   * @param {TokenStore} store
   * @param {AuthSessionOptions} [options]
   */
  constructor(store, options = {}) {
    this.#store = store;
    this.#channelName = `srl-auth:${requireName(options.name ?? 'default')}`;
    this.#audience = new Set((options.audience ?? [location.origin]).map(requireOrigin));
  }

  get strategy() {
    return this.#store.strategy;
  }

  /**
   * Restore a persisted session and start the refresh cycle. Call once, before
   * the router resolves its first route, so guards see a settled state rather
   * than racing the restore.
   *
   * Resolves null for "nobody is signed in", which is the ordinary first-visit path
   * rather than a failure. It rejects when the token endpoint could not be reached or
   * refused the exchange for any other reason, because startup owns failure containment
   * and an application that booted to a login screen because the authorization server
   * was down would be indistinguishable, to the user, from one that had signed them
   * out.
   *
   * A login, logout or cross-tab change that lands during the restore wins. `init`
   * then resolves with the session that change produced.
   *
   * @returns {Promise<Session | null>}
   */
  async init() {
    this.#assertCurrent(this.#generation);
    // Tabs coordinate so that a logout in one is a logout in all, and so a
    // refresh in one does not race N-1 duplicate refreshes in the others. The
    // channel is named per application, because every tab on the origin can hear it.
    this.#channel = new BroadcastChannel(this.#channelName);
    this.#channel.onmessage = (event) => {
      // Anything on the origin can post here, so the payload is narrowed rather
      // than asserted.
      const message = readMessage(event.data);
      if (message.from === DOCUMENT_ID) return;
      switch (message.kind) {
        case 'logout':
          this.#changeGeneration();
          this.#apply(null);
          void this.#withIdentity(() => this.#store.logout()).catch(() => undefined);
          break;
        case 'changed': {
          // Another tab signed in or refreshed. Read this tab's own store rather
          // than trusting the message, because a session is not something a
          // postMessage may introduce. A failure here leaves this tab's state as it
          // was, and the tab that performed the exchange is the one that reports
          // it.
          this.#changeGeneration();
          const generation = this.#generation;
          void this.#withIdentity(() => this.#store.init())
            .then((next) => {
              this.#applyIfCurrent(generation, next);
            })
            .catch(() => undefined);
          break;
        }
        default:
          break;
      }
    };

    const generation = this.#generation;
    const restored = await this.#withIdentity(() => this.#store.init());
    if (generation !== this.#generation && !this.#disposed) {
      // A login, a logout or another tab decided the session during the restore.
      // Startup receives that decision once its store work lands, not a failure.
      await this.#identityWork;
      return this.session.value;
    }
    this.#assertCurrent(generation);
    this.#apply(restored);
    return restored;
  }

  /**
   * Whatever the sign-in screen collected, handed to the store unread. This class
   * never inspects credentials, so it never has to be changed for an application
   * whose second factor, one-time code or redirect result is not a password.
   *
   * @param {unknown} credentials
   * @returns {Promise<Session>}
   */
  async login(credentials) {
    this.#changeGeneration();
    const generation = this.#generation;
    const next = await this.#withIdentity(() => {
      this.#assertCurrent(generation);
      return this.#store.login(credentials);
    });
    this.#assertCurrent(generation);
    this.#apply(next);
    this.#broadcast('changed');
    return next;
  }

  async logout() {
    // Local state goes first and unconditionally. A logout that left the session
    // signal set because the revocation call failed would leave the user looking
    // at a screen they believe they have left.
    this.#changeGeneration();
    this.#apply(null);
    this.#refreshInFlight = undefined;
    this.#broadcast('logout');
    await this.#withIdentity(() => this.#store.logout());
  }

  /**
   * Authorize an outbound request. Delegates to the active strategy, which may
   * add an Authorization header, a DPoP proof, or nothing at all.
   *
   * A request outside the audience comes back unchanged, because the store would
   * attach its credential to any URL it is handed.
   *
   * @param {Request} request
   * @returns {Promise<Request>}
   */
  async authorize(request) {
    const generation = this.#generation;
    await this.#identityWork;
    this.#assertCurrent(generation);
    if (!this.#admits(request.url)) return request;
    const authorized = await this.#store.authorize(request);
    this.#assertCurrent(generation);
    return authorized;
  }

  /**
   * Refresh now rather than waiting for the timer, sharing one exchange with
   * every other caller currently waiting.
   *
   * Three outcomes, and the caller can act on each:
   *
   *   a `Session`         renewed, and already applied.
   *   `null`              no session was live, or the session is over. An ended
   *                       session is applied and broadcast to the other tabs.
   *   rejects `AuthUnavailable`
   *                       not known. Nothing was applied; the session stands
   *                       until its own expiry passes.
   *
   * Renewal extends a live session and never restores one. A store's refresh can
   * still find a cookie a failed revocation left behind, so asking it with no session
   * would sign the user back in. Restoring is `init()`'s job.
   *
   * @returns {Promise<Session | null>}
   */
  refresh() {
    if (this.session.value === null) return Promise.resolve(null);
    this.#refreshInFlight ??= this.#exchangeRefresh();
    return this.#refreshInFlight;
  }

  /**
   * The outbound HTTP path. Angular's `HttpInterceptor`, minus the pipeline
   * abstraction nobody needed.
   *
   * Every API call goes through here so that authorization is not something each
   * service remembers to do, and so that a burst of expired-token 401s costs one
   * refresh rather than one per call.
   *
   * @param {string | URL} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async fetch(input, init) {
    const generation = this.#generation;
    this.#assertCurrent(generation);
    const signal = AbortSignal.any([
      this.#requests.signal,
      ...(init?.signal === null || init?.signal === undefined ? [] : [init.signal]),
    ]);
    // A Request is consumed when sent, so a retry needs a fresh one built from
    // the original inputs rather than a clone of a spent object.
    const build = () => new Request(input, { ...init, signal });

    /** @param {Request} request */
    const send = async (request) => {
      const authorized = await this.authorize(request);
      this.#assertCurrent(generation);
      // Keep cancellation even if a store rebuilt the request without its signal.
      return globalThis.fetch(new Request(authorized, { signal }));
    };
    const first = build();
    const response = await send(first);
    this.#assertCurrent(generation);
    // A request outside the audience carried no credential, so its 401 says nothing
    // about this session.
    if (response.status !== 401 || !this.#admits(first.url)) return response;

    // The access token may simply have aged out between the scheduled refresh and
    // this call. Refresh once, then retry exactly once, and never loop, because a
    // server that keeps returning 401 on a fresh token is saying the session is
    // over.
    /** @type {Session | null} */
    let renewed;
    try {
      renewed = await this.refresh();
    } catch (cause) {
      // Could not tell. The 401 already in hand is the honest answer, and a retry
      // would send the same unauthorized request a second time.
      this.#assertCurrent(generation);
      if (cause instanceof AuthUnavailable) return response;
      throw cause;
    }
    this.#assertCurrent(generation);
    if (renewed === null) return response;

    const retried = await send(build());
    this.#assertCurrent(generation);
    return retried;
  }

  /**
   * JSON convenience wrapper. Throws on non-2xx so callers handle one failure
   * mode rather than checking `response.ok` at every site.
   *
   * @template T
   * @param {string | URL} input
   * @param {RequestInit} [init]
   * @returns {Promise<T>}
   */
  async json(input, init) {
    const generation = this.#generation;
    const response = await this.fetch(input, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`${String(response.status)} ${response.statusText} for ${String(input)}`);
    }
    const body = /** @type {unknown} */ (await readJson(response));
    this.#assertCurrent(generation);
    return /** @type {T} */ (body);
  }

  /**
   * Stop the machinery, so no scheduled refresh fires, no broadcast is applied, and
   * no in-flight refresh is shared with a later caller.
   *
   * The session signal is deliberately left as it was. Disposal happens while a page is
   * being torn down, and clearing it there would push one last render through every
   * screen currently reading it, on its way out.
   *
   * Not the same as `logout()`, which ends a session on the server as well and leaves
   * this object usable.
   */
  dispose() {
    this.#disposed = true;
    this.#changeGeneration();
    this.#clearTimer();
    this.#refreshInFlight = undefined;
    this.#channel?.close();
    this.#channel = undefined;
  }

  /**
   * One refresh exchange, classified.
   *
   * The `finally` clears the shared promise before any caller's `then` runs, so a
   * 401 that arrives while this one is settling starts a new exchange instead of
   * receiving this one's already-stale answer.
   *
   * @returns {Promise<Session | null>}
   */
  #exchangeRefresh() {
    const generation = this.#generation;

    const settled = (async () => {
      try {
        const next = await this.#withStore(() => {
          this.#assertCurrent(generation);
          return this.#store.refresh();
        });
        if (!this.#applyIfCurrent(generation, next)) return this.session.value;
        if (next === null) this.#broadcast('logout');
        return next;
      } catch (cause) {
        if (cause instanceof AuthUnavailable) throw cause;
        // Terminal: the grant was refused, or the payload could not be admitted.
        // Both mean this session is over, and neither improves with a retry.
        if (this.#applyIfCurrent(generation, null)) this.#broadcast('logout');
        return null;
      }
    })();

    const shared = settled.finally(() => {
      if (this.#refreshInFlight === shared) this.#refreshInFlight = undefined;
    });
    return shared;
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #withStore(operation) {
    const next = this.#storeWork.then(operation);
    this.#storeWork = next.then(() => {}, () => {});
    return next;
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #withIdentity(operation) {
    const next = this.#withStore(operation);
    this.#identityWork = this.#storeWork;
    return next;
  }

  #changeGeneration() {
    this.#generation += 1;
    this.#requests.abort(new DOMException('The authentication session changed.', 'AbortError'));
    this.#requests = new AbortController();
    this.#refreshInFlight = undefined;
  }

  /** @param {number} generation */
  #assertCurrent(generation) {
    if (this.#disposed || generation !== this.#generation) {
      throw new DOMException('The authentication session changed.', 'AbortError');
    }
  }

  /**
   * A scheduled refresh reached no answer. Retry on the backoff, bounded by the
   * token's own expiry. Once the instant the server named has passed, the session is
   * over whatever the network is doing, because every request it could authorize would
   * now be refused.
   *
   * @param {number} attempt
   */
  #retryRefresh(attempt) {
    const current = this.session.value;
    if (this.#disposed || current === null) return;

    const remaining = current.expiresAt - Date.now();
    if (remaining <= 0) {
      this.#apply(null);
      this.#broadcast('logout');
      return;
    }

    const backoff = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 0;
    this.#timer = setTimeout(() => {
      this.#refreshOnSchedule(attempt + 1);
    }, Math.min(backoff, remaining));
  }

  /**
   * The timer's entry point. It swallows nothing, because a transient failure becomes
   * a retry and a terminal one has already ended the session inside `refresh()`.
   *
   * @param {number} attempt
   */
  #refreshOnSchedule(attempt) {
    void this.refresh().catch((cause) => {
      if (cause instanceof AuthUnavailable) {
        this.#retryRefresh(attempt);
        return;
      }
      throw cause;
    });
  }

  /**
   * Apply the result of an exchange, unless something decided the session while
   * it was in flight.
   *
   * @param {number} generation the value captured when the exchange started
   * @param {Session | null} next
   * @returns {boolean} whether it was applied
   */
  #applyIfCurrent(generation, next) {
    if (generation !== this.#generation) return false;
    const current = this.session.value;
    if (current !== null && next !== null && current.subject !== next.subject) {
      this.#changeGeneration();
    }
    this.#apply(next);
    return true;
  }

  /** @param {Session | null} next */
  #apply(next) {
    this.#clearTimer();
    if (this.#disposed) return;

    this.session.value = next;
    if (next === null) {
      this.#dueStreak = 0;
      return;
    }
    this.#armAt(Date.now() + this.#cadence(next));
  }

  /**
   * How long to wait before renewing `next`.
   *
   * The refresh runs a margin before expiry, or halfway through a lifetime shorter
   * than twice the margin. A session restored inside the margin is due at once. When
   * answers keep arriving due, the refresh is buying no time, so each one after the
   * first waits on the backoff instead of looping.
   *
   * @param {Session} next
   * @returns {number} milliseconds
   */
  #cadence(next) {
    const lead = next.expiresAt - Date.now();
    const delay = Math.max(0, lead - REFRESH_MARGIN_MS, lead / 2);
    if (delay >= REFRESH_FLOOR_MS) {
      this.#dueStreak = 0;
      return delay;
    }

    this.#dueStreak += 1;
    if (this.#dueStreak === 1) return delay;
    const step = Math.min(this.#dueStreak - 2, RETRY_DELAYS_MS.length - 1);
    return Math.max(delay, RETRY_DELAYS_MS[step] ?? 0);
  }

  /**
   * Run the scheduled refresh at `instant`. A wait past the timer's range re-arms at
   * the limit until the instant is in range.
   *
   * @param {number} instant epoch milliseconds
   */
  #armAt(instant) {
    const delay = Math.max(0, instant - Date.now());
    if (delay > MAX_TIMER_MS) {
      this.#timer = setTimeout(() => {
        this.#armAt(instant);
      }, MAX_TIMER_MS);
      return;
    }
    this.#timer = setTimeout(() => {
      this.#refreshOnSchedule(0);
    }, delay);
  }

  /** @param {string} url */
  #admits(url) {
    return this.#audience.has(new URL(url).origin);
  }

  #clearTimer() {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** @param {'changed' | 'logout'} kind */
  #broadcast(kind) {
    this.#channel?.postMessage({ kind, from: DOCUMENT_ID });
  }
}

/**
 * @param {unknown} data
 * @returns {{ kind?: string, from?: string }}
 */
function readMessage(data) {
  if (typeof data !== 'object' || data === null) return {};
  const { kind, from } = /** @type {{ kind?: unknown, from?: unknown }} */ (data);
  return {
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof from === 'string' ? { from } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireName(value) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('AuthSession name must be a non-empty string.');
  }
  return value;
}

/**
 * An audience entry is an origin, such as `https://api.example.com`. A path or a
 * trailing slash is refused rather than widened to its origin.
 *
 * @param {unknown} value
 * @returns {string}
 */
function requireOrigin(value) {
  const origin = typeof value === 'string' && URL.canParse(value) ? new URL(value).origin : 'null';
  if (origin === 'null' || origin !== value) {
    throw new TypeError(
      `AuthSession audience entries must be origins such as "https://api.example.com", got ${JSON.stringify(value)}.`,
    );
  }
  return origin;
}
