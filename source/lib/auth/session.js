import { computed, signal } from '@core/foundation/reactive.js';
import { token } from '@core/foundation/inject.js';
import { readJson } from '@core/foundation/json.js';
import { AuthUnavailable } from '@auth/session-policy.js';

/** @import { Session, TokenStore } from '@auth/types.js' */

/**
 * The authenticated request lifecycle, whole.
 *
 * WHAT THIS MODULE OWNS
 *
 * One session, from restore to disposal, and every outbound request that carries
 * it. Callers get `login`, `logout`, `fetch`, `json` and three signals; they do
 * not get the ordering rules, because the ordering rules were the part that kept
 * escaping. A refresh has to be shared across concurrent 401s, coordinated across
 * tabs, scheduled before expiry, retried when the network is down but not when
 * the grant is refused, and abandoned on disposal — and each of those lived in a
 * different file, or in module scope, or nowhere.
 *
 * The single-flight refresh is a private field rather than module state, so two
 * sessions on one page do not deduplicate against each other. ADR-0022.
 *
 * WHERE TOKENS LIVE, AND WHY THAT IS AN INTERFACE
 *
 * Nowhere in this file, and that is the point. A `TokenStore` is supplied by the
 * application: it owns the endpoints, the request bodies, the response field names
 * and the headers, because those are its backend's facts and not the library's.
 * `@auth/session-policy.js` has the errors and the `Session` builder a store is
 * written against. ADR-0021 says why the seam is shaped this way, and the
 * applications in this repository each carry a worked implementation.
 *
 * Note what the interface does NOT expose: any way to get a raw token. Stores
 * authorize a `Request`; they never hand out a credential, and neither does this
 * class. They stay adapters behind that seam — they perform an exchange and admit
 * its payload, and decide nothing about session state, retries or scheduling.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<AuthSession>} */
export const AUTH_SESSION = token('AuthSession');

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Backoff for a refresh that could not reach an answer, in order; the last delay
 * repeats. Bounded by the token's own expiry in every case, so the sequence never
 * decides how long a dead session survives — the token does.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

export class AuthSession {
  /** @type {import('@core/foundation/types.js').Signal<Session | null>} */
  session = signal(/** @type {Session | null} */ (null));

  isAuthenticated = computed(() => this.session.value !== null);

  /** @type {import('@core/foundation/types.js').ReadonlySignal<readonly string[]>} */
  scopes = computed(() => this.session.value?.scopes ?? []);

  #store;

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
   * Bumped whenever something other than a refresh decides what the session is:
   * a login, a logout, a broadcast from another tab, disposal.
   *
   * An exchange that started before one of those must not apply its answer after
   * it. Without this, signing out while a refresh is in flight signs you back in
   * a moment later — the exchange resolves, applies a valid session, and the
   * screen the user just left comes back. The generation is captured when the
   * exchange starts and compared when it settles.
   */
  #generation = 0;

  #disposed = false;

  /** @param {TokenStore} store */
  constructor(store) {
    this.#store = store;
  }

  get strategy() {
    return this.#store.strategy;
  }

  /**
   * Restore a persisted session and start the refresh cycle. Call once, before
   * the router resolves its first route, so guards see a settled state rather
   * than racing the restore.
   *
   * Resolves null for "nobody is signed in", which is the ordinary first-visit
   * path and not a failure. It rejects when the token endpoint could not be
   * reached or refused the exchange for any other reason: startup owns failure
   * containment, and an application that booted to a login screen because the
   * authorization server was down would be indistinguishable, to the user, from
   * one that had signed them out.
   *
   * @returns {Promise<Session | null>}
   */
  async init() {
    // Tabs coordinate so that a logout in one is a logout in all, and so a
    // refresh in one does not race N-1 duplicate refreshes in the others.
    this.#channel = new BroadcastChannel('auth');
    this.#channel.onmessage = (event) => {
      // Anything on the origin can post here, so the payload is narrowed rather
      // than asserted.
      switch (readKind(event.data)) {
        case 'logout':
          this.#generation += 1;
          this.#apply(null);
          break;
        case 'changed': {
          // Another tab signed in or refreshed. Read our own store rather than
          // trusting the message: a session is not something a postMessage may
          // introduce. A failure here leaves this tab's state as it was — the
          // tab that actually performed the exchange is the one that reports it.
          this.#generation += 1;
          const generation = this.#generation;
          void this.#store
            .init()
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

    const restored = await this.#store.init();
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
    const next = await this.#store.login(credentials);
    this.#generation += 1;
    this.#apply(next);
    this.#broadcast('changed');
    return next;
  }

  async logout() {
    // Local state goes first and unconditionally. A logout that left the session
    // signal set because the revocation call failed would leave the user looking
    // at a screen they believe they have left.
    this.#generation += 1;
    this.#apply(null);
    this.#refreshInFlight = undefined;
    this.#broadcast('logout');
    await this.#store.logout();
  }

  /**
   * Authorize an outbound request. Delegates to the active strategy, which may
   * add an Authorization header, a DPoP proof, or nothing at all.
   *
   * @param {Request} request
   * @returns {Promise<Request>}
   */
  authorize(request) {
    return this.#store.authorize(request);
  }

  /**
   * Refresh now rather than waiting for the timer, sharing one exchange with
   * every other caller currently waiting.
   *
   * Three outcomes, and the caller can act on each:
   *
   *   a `Session`         renewed, and already applied.
   *   `null`              the session is over. Applied, and broadcast to the
   *                       other tabs.
   *   rejects `AuthUnavailable`
   *                       not known. Nothing was applied; the session stands
   *                       until its own expiry passes.
   *
   * @returns {Promise<Session | null>}
   */
  refresh() {
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
    // A Request is consumed when sent, so a retry needs a fresh one built from
    // the original inputs rather than a clone of a spent object.
    const build = () => new Request(input, init);

    const response = await globalThis.fetch(await this.authorize(build()));
    if (response.status !== 401) return response;

    // The access token may simply have aged out between the scheduled refresh and
    // this call. Refresh once, then retry exactly once. Never loop: a server that
    // keeps returning 401 on a fresh token is telling us the session is over.
    /** @type {Session | null} */
    let renewed;
    try {
      renewed = await this.refresh();
    } catch (cause) {
      // Could not tell. The 401 already in hand is the honest answer, and a retry
      // would send the same unauthorized request a second time.
      if (cause instanceof AuthUnavailable) return response;
      throw cause;
    }
    if (renewed === null) return response;

    return globalThis.fetch(await this.authorize(build()));
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
    const response = await this.fetch(input, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`${String(response.status)} ${response.statusText} for ${String(input)}`);
    }
    return readJson(response);
  }

  /**
   * Stop the machinery: no scheduled refresh fires, no broadcast is applied, no
   * in-flight refresh is shared with a later caller.
   *
   * The session signal is deliberately left as it was. Disposal happens while a
   * page is being torn down, and clearing it there would push one last render
   * through every screen currently reading it, on its way out.
   *
   * Not the same as `logout()`, which ends a session on the server as well and
   * leaves this object usable.
   */
  dispose() {
    this.#disposed = true;
    this.#generation += 1;
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
        const next = await this.#store.refresh();
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

    return settled.finally(() => {
      this.#refreshInFlight = undefined;
    });
  }

  /**
   * A scheduled refresh reached no answer. Retry on the backoff, bounded by the
   * token's own expiry: once the instant the server named has passed, the session
   * is over whatever the network is doing, because every request it could
   * authorize would now be refused.
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
   * The timer's entry point. Swallows nothing: a transient failure becomes a
   * retry and a terminal one has already ended the session inside `refresh()`.
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
    this.#apply(next);
    return true;
  }

  /** @param {Session | null} next */
  #apply(next) {
    this.#clearTimer();
    if (this.#disposed) return;

    this.session.value = next;
    if (next === null) return;

    // Clamp to zero: a session restored from storage may already be inside the
    // margin, and a negative delay would silently never fire in some engines.
    const delay = Math.max(0, next.expiresAt - Date.now() - REFRESH_MARGIN_MS);
    this.#timer = setTimeout(() => {
      this.#refreshOnSchedule(0);
    }, delay);
  }

  #clearTimer() {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** @param {'changed' | 'logout'} kind */
  #broadcast(kind) {
    this.#channel?.postMessage({ kind });
  }
}

/**
 * @param {unknown} data
 * @returns {string | undefined}
 */
function readKind(data) {
  if (typeof data !== 'object' || data === null) return undefined;
  const kind = /** @type {{ kind?: unknown }} */ (data).kind;
  return typeof kind === 'string' ? kind : undefined;
}
