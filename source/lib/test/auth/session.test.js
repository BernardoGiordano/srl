import { AuthSession } from '@auth/session.js';
import { AuthRejected, AuthUnavailable } from '@auth/session-policy.js';
import { assert, present } from '../harness.js';

/** @import { Session, TokenStore } from '@auth/types.js' */

/**
 * The authenticated request lifecycle: one refresh shared by every caller, a
 * scheduled refresh that acts without a human present, and a disposal that
 * actually stops.
 *
 * These are the invariants that used to live between files. The single-flight
 * refresh was a module-level variable in `authorized-fetch.js`, shared by every
 * session in the process rather than by every caller of one; the refresh timer
 * had no failure behaviour at all, so a rejected refresh became an unhandled
 * rejection and left `isAuthenticated` true against a token that was already
 * dead; and nothing closed the BroadcastChannel or cleared the timer, so a
 * disposed session went on refreshing.
 *
 * Timings here are deliberate rather than arbitrary. `AuthSession` refreshes a
 * minute before expiry, so a session expiring inside that margin schedules its
 * refresh immediately — which is how these tests reach the scheduled path
 * without waiting a minute for it.
 */

/** Far enough out that no scheduled refresh fires during a test. */
const LONG = 3_600_000;

/**
 * @param {Partial<Session>} [overrides]
 * @returns {Session}
 */
function session(overrides) {
  return {
    subject: 'user-ada',
    name: 'Ada',
    scopes: ['sales:read'],
    expiresAt: Date.now() + LONG,
    ...overrides,
  };
}

/**
 * A store that records what was asked of it and answers as the test directs.
 *
 * The recording wraps the answers rather than being one of them, so a test that
 * supplies its own `refresh` is still counted. An earlier version merged the
 * overrides over the recording implementations, which made every assertion about
 * call counts silently pass with zero.
 *
 * @param {Partial<Omit<TokenStore, 'strategy'>>} [overrides]
 * @returns {TokenStore & { calls: string[] }}
 */
function fakeStore(overrides) {
  const calls = /** @type {string[]} */ ([]);

  const answers = {
    /** @returns {Promise<Session | null>} */
    init: () => Promise.resolve(null),
    /** @param {{ username: string, password: string }} _credentials @returns {Promise<Session>} */
    login: (_credentials) => Promise.resolve(session()),
    /** @returns {Promise<void>} */
    logout: () => Promise.resolve(),
    /** @returns {Promise<Session | null>} */
    refresh: () => Promise.resolve(session()),
    /** @param {Request} request @returns {Promise<Request>} */
    authorize: (request) => {
      const authorized = new Request(request);
      authorized.headers.set('Authorization', 'Bearer at-1');
      return Promise.resolve(authorized);
    },
    ...overrides,
  };

  return {
    calls,
    strategy: 'memory',
    init: () => {
      calls.push('init');
      return answers.init();
    },
    login: (credentials) => {
      calls.push('login');
      return answers.login(credentials);
    },
    logout: () => {
      calls.push('logout');
      return answers.logout();
    },
    refresh: () => {
      calls.push('refresh');
      return answers.refresh();
    },
    authorize: (request) => answers.authorize(request),
  };
}

/** @param {number} ms */
function after(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** A promise plus the handles to settle it from the test. */
function deferred() {
  /** @type {(value: Session | null) => void} */
  let resolve = () => undefined;
  /** @type {(reason: unknown) => void} */
  let reject = () => undefined;
  /** @type {Promise<Session | null>} */
  const promise = new Promise((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

describe('auth session lifecycle', () => {
  /** @type {AuthSession[]} */
  let live;
  /** @type {typeof globalThis.fetch} */
  let nativeFetch;

  beforeEach(() => {
    live = [];
    nativeFetch = globalThis.fetch.bind(globalThis);
  });

  afterEach(() => {
    // Every session opens a BroadcastChannel on the one 'auth' name. An undisposed
    // one from a finished test would apply the next test's logout to itself.
    for (const auth of live) auth.dispose();
    globalThis.fetch = nativeFetch;
  });

  /**
   * @param {Partial<TokenStore>} [overrides]
   */
  function start(overrides) {
    const store = fakeStore(overrides);
    const auth = new AuthSession(store);
    live.push(auth);
    return { auth, store };
  }

  /**
   * A session restored through `init()`, which is what schedules its refresh.
   *
   * Assigning `session.value` directly, as the request-path tests do, deliberately
   * does not: the signal is what screens read, and the timer belongs to the
   * lifecycle that applied it.
   *
   * @param {number} expiresIn milliseconds from now
   * @param {Partial<TokenStore>} [overrides]
   */
  async function startRestored(expiresIn, overrides) {
    const restored = session({ expiresAt: Date.now() + expiresIn });
    const started = start({ init: () => Promise.resolve(restored), ...overrides });
    await started.auth.init();
    return { ...started, restored };
  }

  /**
   * @param {readonly string[]} calls
   * @returns {number}
   */
  function refreshes(calls) {
    return calls.filter((call) => call === 'refresh').length;
  }

  /* ── One refresh, shared ───────────────────────────────────────────────── */

  it('shares one exchange between concurrent callers', async () => {
    const pending = deferred();
    const { auth, store } = start({ refresh: () => pending.promise });
    auth.session.value = session();

    const all = [auth.refresh(), auth.refresh(), auth.refresh()];
    pending.resolve(session());
    await Promise.all(all);

    assert.equal(store.calls.filter((call) => call === 'refresh').length, 1);
  });

  it('starts a new exchange once the shared one has settled', async () => {
    // The in-flight promise has to be cleared before any caller's continuation
    // runs, or a 401 arriving a tick later resolves against a stale answer.
    const { auth, store } = start();
    auth.session.value = session();

    await auth.refresh();
    await auth.refresh();

    assert.equal(store.calls.filter((call) => call === 'refresh').length, 2);
  });

  /* ── The request path ──────────────────────────────────────────────────── */

  it('authorizes, and on 401 refreshes once and retries once', async () => {
    /** @type {Request[]} */
    const sent = [];
    let answered = 0;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      answered += 1;
      return Promise.resolve(new Response(null, { status: answered === 1 ? 401 : 200 }));
    };

    const { auth, store } = start();
    auth.session.value = session();

    const response = await auth.fetch('/api/orders');

    assert.equal(response.status, 200);
    assert.equal(sent.length, 2, 'one retry, not a loop');
    assert.equal(present(sent[0]).headers.get('Authorization'), 'Bearer at-1');
    assert.equal(store.calls.filter((call) => call === 'refresh').length, 1);
  });

  it('costs one refresh for a burst of 401s', async () => {
    let answered = 0;
    globalThis.fetch = () => {
      answered += 1;
      // The first three calls are the burst; everything after is a retry.
      return Promise.resolve(new Response(null, { status: answered <= 3 ? 401 : 200 }));
    };

    const { auth, store } = start();
    auth.session.value = session();

    const responses = await Promise.all([
      auth.fetch('/api/a'),
      auth.fetch('/api/b'),
      auth.fetch('/api/c'),
    ]);

    assert.sameArray(
      responses.map((response) => response.status),
      [200, 200, 200],
    );
    assert.equal(store.calls.filter((call) => call === 'refresh').length, 1);
  });

  it('returns the 401 rather than retrying when the session is over', async () => {
    let sent = 0;
    globalThis.fetch = () => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    };

    const { auth } = start({ refresh: () => Promise.resolve(null) });
    auth.session.value = session();

    const response = await auth.fetch('/api/orders');

    assert.equal(response.status, 401);
    assert.equal(sent, 1, 'no retry against an ended session');
    assert.equal(auth.session.value, null);
  });

  it('returns the 401 rather than retrying when the refresh could not be reached', async () => {
    let sent = 0;
    globalThis.fetch = () => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    };

    const { auth } = start({
      refresh: () => Promise.reject(new AuthUnavailable('offline')),
    });
    const current = session();
    auth.session.value = current;

    const response = await auth.fetch('/api/orders');

    assert.equal(response.status, 401);
    assert.equal(sent, 1);
    // Not knowing is not a reason to sign the user out.
    assert.equal(auth.session.value, current);
  });

  it('throws the server error from json() rather than returning a body', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 500 }));
    const { auth } = start();
    auth.session.value = session();

    await assert.rejects(() => auth.json('/api/orders'), '500');
  });

  /* ── Scheduled refresh ─────────────────────────────────────────────────── */

  it('refreshes before expiry without being asked', async () => {
    // Restored inside the 60s refresh margin, so the timer is scheduled for now.
    const { auth, store } = await startRestored(1_000);
    await after(20);

    assert.equal(refreshes(store.calls), 1, store.calls.join(' '));
    assert.ok(present(auth.session.value).expiresAt > Date.now() + 60_000, 'renewed');
  });

  it('ends the session when a scheduled refresh is refused', async () => {
    const { auth } = await startRestored(1_000, {
      refresh: () => Promise.reject(new AuthRejected('invalid_grant')),
    });
    await after(20);

    // Terminal. Keeping the session would leave isAuthenticated true against a
    // token the server has already stopped honouring.
    assert.equal(auth.session.value, null);
    assert.notOk(auth.isAuthenticated.value, 'isAuthenticated follows');
  });

  it('ends the session when an unadmissible payload comes back', async () => {
    // Admission failure is terminal on purpose: a token endpoint answering 200
    // with a body the client cannot read does not get better on the third try.
    const { auth } = await startRestored(1_000, {
      refresh: () => Promise.reject(new AuthRejected('access_token must be a non-empty string')),
    });
    await after(20);

    assert.equal(auth.session.value, null);
  });

  it('retries a scheduled refresh that could not reach an answer', async () => {
    // Expiry 200ms out bounds the backoff to 200ms, so a retry is observable
    // without the suite waiting on the first backoff step.
    const { auth, store } = await startRestored(200, {
      refresh: () => Promise.reject(new AuthUnavailable('offline')),
    });
    await after(30);

    assert.ok(refreshes(store.calls) >= 1, 'the first attempt ran');
    // Not knowing is not a reason to sign the user out.
    assert.notOk(auth.session.value === null, 'the session survives a transient failure');
  });

  it('ends the session once its own expiry passes with no answer', async () => {
    const { auth } = await startRestored(40, {
      refresh: () => Promise.reject(new AuthUnavailable('offline')),
    });
    await after(300);

    // The token names the moment every request it could authorize starts being
    // refused. Past that, "not known yet" is no longer an honest state.
    assert.equal(auth.session.value, null);
  });

  /* ── Ordering ──────────────────────────────────────────────────────────── */

  it('does not let a refresh in flight survive a logout', async () => {
    const pending = deferred();
    const { auth } = start({ refresh: () => pending.promise });
    auth.session.value = session();

    const refreshing = auth.refresh();
    await auth.logout();
    assert.equal(auth.session.value, null, 'logout applies immediately');

    // The exchange the user signed out from underneath now answers. Applying it
    // would sign them back in.
    pending.resolve(session());
    await refreshing;

    assert.equal(auth.session.value, null);
  });

  it('clears local state even when revocation fails', async () => {
    const { auth } = start({ logout: () => Promise.reject(new Error('network')) });
    auth.session.value = session();

    await assert.rejects(() => auth.logout());

    assert.equal(auth.session.value, null);
  });

  /* ── Disposal ──────────────────────────────────────────────────────────── */

  it('stops refreshing once disposed', async () => {
    const { auth, store } = await startRestored(1_000);
    auth.dispose();
    await after(30);

    assert.equal(refreshes(store.calls), 0, store.calls.join(' '));
  });

  it('keeps the session value on disposal', () => {
    // Disposal happens while a page is torn down. Clearing the signal there would
    // push one last render through every screen reading it, on the way out.
    const store = fakeStore();
    const auth = new AuthSession(store);
    const current = session();
    auth.session.value = current;

    auth.dispose();

    assert.equal(auth.session.value, current);
  });

  it('ignores another tab after disposal', async () => {
    const store = fakeStore();
    const auth = new AuthSession(store);
    live.push(auth);
    await auth.init();
    auth.session.value = session();

    auth.dispose();
    const channel = new BroadcastChannel('auth');
    channel.postMessage({ kind: 'logout' });
    await after(20);
    channel.close();

    assert.notOk(auth.session.value === null, 'a disposed session applies nothing');
  });

  /* ── Cross-tab ─────────────────────────────────────────────────────────── */

  it('applies a logout broadcast from another tab', async () => {
    const { auth } = start();
    await auth.init();
    auth.session.value = session();

    const channel = new BroadcastChannel('auth');
    channel.postMessage({ kind: 'logout' });
    await after(20);
    channel.close();

    assert.equal(auth.session.value, null);
  });

  it('re-reads its own store rather than trusting a broadcast payload', async () => {
    // Anything on the origin can post to this channel. A session is not something
    // a postMessage may introduce, so a "changed" message is a prompt to ask the
    // store, never a session to adopt.
    const { auth, store } = start();
    await auth.init();

    const channel = new BroadcastChannel('auth');
    channel.postMessage({ kind: 'changed', session: session() });
    await after(20);
    channel.close();

    assert.equal(auth.session.value, null, 'the store answered null, and the store is the source');
    assert.ok(store.calls.includes('init'), store.calls.join(' '));
  });
});
