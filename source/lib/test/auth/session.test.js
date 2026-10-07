import { AuthSession } from '@auth/session.js';
import { AuthRejected, AuthUnavailable } from '@auth/session-policy.js';
import { ApiClient } from '@core/http/client.js';
import { assert, present } from '../harness.js';

/** @import { Session, TokenStore } from '@auth/types.js' */

/**
 * The authenticated request lifecycle. One refresh shared by every caller, a scheduled
 * refresh that acts without a human present, and a disposal that actually stops.
 *
 * These are the invariants that fall between files. A module-level single-flight refresh
 * is shared by every session in the process rather than by every caller of one. A
 * refresh timer with no failure behaviour turns a rejected refresh into an unhandled
 * rejection and leaves `isAuthenticated` true against a token that is already dead. A
 * BroadcastChannel nothing closes and a timer nothing clears leave a disposed session
 * refreshing.
 *
 * Timings here are deliberate rather than arbitrary. `AuthSession` refreshes halfway
 * through a lifetime shorter than two minutes, so a session restored 40 ms from expiry
 * refreshes 20 ms later, which is how these tests reach the scheduled path without
 * waiting a minute for it.
 */

/** Far enough out that no scheduled refresh fires during a test. */
const LONG = 3_600_000;

/** The channel an unnamed session and its other tabs share. */
const CHANNEL = 'srl-auth:default';

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
 * The recording wraps the answers rather than being one of them, so a test that supplies
 * its own `refresh` is still counted. Merging the overrides over the recording
 * implementations instead makes every assertion about call counts silently pass with
 * zero.
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
    // An undisposed session keeps its timer and its channel open into the next test.
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
   * does not. The signal is what screens read, and the timer belongs to the lifecycle
   * that applied it.
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

  it('does not sign the user back in when a 401 arrives after logout', async () => {
    // A failed revocation leaves the refresh cookie behind, and the store's refresh
    // would spend it.
    let sent = 0;
    globalThis.fetch = () => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    };
    const { auth, store } = start({ logout: () => Promise.reject(new AuthUnavailable('offline')) });
    await auth.login({});
    await assert.rejects(() => auth.logout(), 'offline');

    const response = await auth.fetch('/api/orders');

    assert.equal(response.status, 401);
    assert.equal(sent, 1, 'no retry');
    assert.equal(refreshes(store.calls), 0, store.calls.join(' '));
    assert.equal(auth.session.value, null);
  });

  it('keeps credentials and renewal to the audience', async () => {
    /** @type {Request[]} */
    const sent = [];
    globalThis.fetch = (input, init) => {
      sent.push(new Request(input, init));
      return Promise.resolve(new Response(null, { status: 401 }));
    };
    const { auth, store } = start();
    auth.session.value = session();

    const response = await auth.fetch('https://elsewhere.example/api/orders');

    assert.equal(response.status, 401);
    assert.equal(present(sent[0]).headers.get('Authorization'), null, 'no credential off the page origin');
    assert.equal(refreshes(store.calls), 0, 'a 401 from outside the audience renews nothing');
  });

  it('carries credentials to the origins it is given, and only those', async () => {
    /** @type {Request[]} */
    const sent = [];
    globalThis.fetch = (input, init) => {
      sent.push(new Request(input, init));
      return Promise.resolve(new Response('ok'));
    };
    const auth = new AuthSession(fakeStore(), { audience: ['https://api.example.com'] });
    live.push(auth);
    auth.session.value = session();

    await auth.fetch('https://api.example.com/orders');
    await auth.fetch('/api/orders');

    assert.equal(present(sent[0]).headers.get('Authorization'), 'Bearer at-1');
    assert.equal(present(sent[1]).headers.get('Authorization'), null);
  });

  it('refuses an audience entry that is not an origin', () => {
    // Widening a path to its origin would hand the credential to every service on it.
    assert.throws(() => new AuthSession(fakeStore(), { audience: ['https://api.example.com/v1'] }), 'origins');
    assert.throws(() => new AuthSession(fakeStore(), { audience: ['api.example.com'] }), 'origins');
  });

  it('throws the server error from json() rather than returning a body', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 500 }));
    const { auth } = start();
    auth.session.value = session();

    await assert.rejects(() => auth.json('/api/orders'), '500');
  });

  /* ── Scheduled refresh ─────────────────────────────────────────────────── */

  it('refreshes before expiry without being asked', async () => {
    const { auth, store } = await startRestored(40);
    await after(80);

    assert.equal(refreshes(store.calls), 1, store.calls.join(' '));
    assert.ok(present(auth.session.value).expiresAt > Date.now() + 60_000, 'renewed');
  });

  it('refreshes a short lifetime halfway through rather than at once', async () => {
    // A lifetime under the 60s margin used to put every refresh at zero delay.
    const { auth, store } = start({ login: () => Promise.resolve(session({ expiresAt: Date.now() + 30_000 })) });
    await auth.login({});
    await after(50);

    assert.equal(refreshes(store.calls), 0, store.calls.join(' '));
  });

  it('backs off when each refresh comes back already due', async () => {
    // A client clock ahead of the server's reads every fresh expiry as past.
    const { store } = await startRestored(-60_000, {
      refresh: () => Promise.resolve(session({ expiresAt: Date.now() - 60_000 })),
    });
    await after(200);

    assert.equal(refreshes(store.calls), 1, store.calls.join(' '));
  });

  it('waits out an expiry past the timer range instead of firing at once', async () => {
    // setTimeout fires a delay above 2^31-1 ms, about 24.8 days, immediately.
    const thirtyDays = 30 * 24 * 3_600_000;
    const { store } = await startRestored(thirtyDays);
    await after(50);

    assert.equal(refreshes(store.calls), 0, store.calls.join(' '));
  });

  it('ends the session when a scheduled refresh is refused', async () => {
    const { auth } = await startRestored(40, {
      refresh: () => Promise.reject(new AuthRejected('invalid_grant')),
    });
    await after(80);

    // Terminal. Keeping the session would leave isAuthenticated true against a
    // token the server has already stopped honouring.
    assert.equal(auth.session.value, null);
    assert.notOk(auth.isAuthenticated.value, 'isAuthenticated follows');
  });

  it('ends the session when an unadmissible payload comes back', async () => {
    // Admission failure is terminal on purpose, because a token endpoint answering
    // 200 with a body the client cannot read does not get better on the third try.
    const { auth } = await startRestored(40, {
      refresh: () => Promise.reject(new AuthRejected('access_token must be a non-empty string')),
    });
    await after(80);

    assert.equal(auth.session.value, null);
  });

  it('retries a scheduled refresh that could not reach an answer', async () => {
    // The first attempt runs at 200ms, and expiry at 400ms bounds the backoff, so
    // the check at 260ms sees the attempt and a session still standing.
    const { auth, store } = await startRestored(400, {
      refresh: () => Promise.reject(new AuthUnavailable('offline')),
    });
    await after(260);

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

  it('never retries an old POST as the next signed-in user', async () => {
    let answer = /** @type {(response: Response) => void} */ (() => {});
    let sent = /** @type {() => void} */ (() => {});
    const started = new Promise((resolve) => { sent = () => resolve(undefined); });
    const pending = /** @type {Promise<Response>} */ (new Promise((resolve) => { answer = resolve; }));
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      sent();
      return pending;
    };
    const { auth } = start();
    await auth.login({});
    const writing = auth.fetch('/api/payments', { method: 'POST', body: 'old-user-payment' });
    const rejected = assert.rejects(() => writing, 'session');
    await started;
    await auth.logout();
    await auth.login({});
    answer(new Response('', { status: 401 }));
    await rejected;
    assert.equal(requests, 1);
  });

  it('does not deliver a shared GET from an earlier sign-in', async () => {
    let answer = /** @type {(response: Response) => void} */ (() => {});
    let sent = /** @type {() => void} */ (() => {});
    const started = new Promise((resolve) => { sent = () => resolve(undefined); });
    const pending = /** @type {Promise<Response>} */ (new Promise((resolve) => { answer = resolve; }));
    globalThis.fetch = () => { sent(); return pending; };
    const { auth } = start();
    await auth.login({});
    const client = new ApiClient('/api', { fetch: (url, init) => auth.fetch(url, init) });
    const oldRead = client.get('/me');
    const oldRejected = assert.rejects(() => oldRead, 'session');
    await started;
    await auth.logout();
    await auth.login({});
    const nextRead = client.get('/me');
    const nextRejected = assert.rejects(() => nextRead, 'session');
    answer(Response.json({ private: 'previous user' }));
    await Promise.all([oldRejected, nextRejected]);
    globalThis.fetch = () => Promise.resolve(Response.json({ private: 'current user' }));
    const fresh = /** @type {{ private: string }} */ (await client.get('/me'));
    assert.equal(fresh.private, 'current user');
  });

  it('keeps a late login from restoring a logged-out session or credential', async () => {
    const pending = deferred();
    const entered = deferred();
    let credential = false;
    const { auth } = start({
      login: async () => {
        entered.resolve(null);
        const next = present(await pending.promise);
        credential = true;
        return next;
      },
      logout: () => { credential = false; return Promise.resolve(); },
    });
    const loggingIn = auth.login({});
    const rejected = assert.rejects(() => loggingIn, 'session');
    await entered.promise;
    const loggingOut = auth.logout();
    assert.equal(auth.session.value, null);
    pending.resolve(session());
    await Promise.all([rejected, loggingOut]);
    assert.equal(auth.session.value, null);
    assert.equal(credential, false);
  });

  it('keeps a late restore from undoing logout', async () => {
    const pending = deferred();
    const entered = deferred();
    const { auth } = start({ init: () => { entered.resolve(null); return pending.promise; } });
    const restoring = auth.init();
    await entered.promise;
    const loggingOut = auth.logout();
    pending.resolve(session());
    const [restored] = await Promise.all([restoring, loggingOut]);
    assert.equal(restored, null, 'startup sees the logout rather than a failure');
    assert.equal(auth.session.value, null);
  });

  it('resolves a restore with the sign-in another tab made during it', async () => {
    const pending = deferred();
    const entered = deferred();
    let reads = 0;
    const { auth } = start({ init: () => {
      reads += 1;
      if (reads > 1) return Promise.resolve(session({ subject: 'user-bob' }));
      entered.resolve(null);
      return pending.promise;
    } });
    const restoring = auth.init();
    await entered.promise;

    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ kind: 'changed' });
    await after(20);
    channel.close();

    pending.resolve(session());
    const restored = present(await restoring);
    assert.equal(restored.subject, 'user-bob');
    assert.equal(present(auth.session.value).subject, 'user-bob');
  });

  it('aborts response body reads when the account changes', async () => {
    let requestSignal = /** @type {AbortSignal | undefined} */ (undefined);
    globalThis.fetch = (input) => {
      requestSignal = /** @type {Request} */ (input).signal;
      return Promise.resolve(new Response('private'));
    };
    const { auth } = start();
    await auth.login({});
    await auth.fetch('/api/me');
    assert.equal(present(requestSignal).aborted, false);
    await auth.logout();
    assert.equal(present(requestSignal).aborted, true);
  });

  it('does not retry a request when refresh restores another subject', async () => {
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      return Promise.resolve(new Response('', { status: 401 }));
    };
    const { auth } = start({ refresh: () => Promise.resolve(session({ subject: 'another-user' })) });
    await auth.login({});
    await assert.rejects(() => auth.fetch('/api/payments', { method: 'POST' }), 'session');
    assert.equal(requests, 1);
    assert.equal(present(auth.session.value).subject, 'another-user');
  });

  it('rejects outbound requests after disposal without authorizing them', async () => {
    let authorized = false;
    const { auth } = start({ authorize: (request) => {
      authorized = true;
      return Promise.resolve(request);
    } });
    auth.dispose();
    await assert.rejects(() => auth.fetch('/api/me'), 'session');
    assert.equal(authorized, false);
  });

  it('sends requests while a refresh is pending', async () => {
    const pending = deferred();
    const entered = deferred();
    globalThis.fetch = () => Promise.resolve(new Response('ok'));
    const { auth } = start({ refresh: () => { entered.resolve(null); return pending.promise; } });
    await auth.login({});
    const refreshing = auth.refresh();
    await entered.promise;

    const sent = await Promise.race([
      auth.fetch('/api/me').then(() => true),
      after(50).then(() => false),
    ]);
    pending.resolve(session());
    await refreshing;

    assert.ok(sent, 'the current token stays valid until the refresh lands');
  });

  it('authorizes after logout only once the pending refresh and cleanup have run', async () => {
    const pending = deferred();
    const entered = deferred();
    const order = /** @type {string[]} */ ([]);
    globalThis.fetch = () => Promise.resolve(new Response('ok'));
    const { auth } = start({
      refresh: () => { entered.resolve(null); return pending.promise; },
      logout: () => { order.push('logout'); return Promise.resolve(); },
      authorize: (request) => { order.push('authorize'); return Promise.resolve(request); },
    });
    await auth.login({});
    const refreshing = auth.refresh();
    await entered.promise;

    const loggingOut = auth.logout();
    const sending = auth.fetch('/api/public');
    pending.resolve(session());
    await Promise.all([refreshing, loggingOut, sending]);

    assert.sameArray(order, ['logout', 'authorize']);
  });

  it('does not let a refresh in flight survive a logout', async () => {
    const pending = deferred();
    const { auth } = start({ refresh: () => pending.promise });
    auth.session.value = session();

    const refreshing = auth.refresh();
    await Promise.resolve();
    const loggingOut = auth.logout();
    assert.equal(auth.session.value, null, 'logout applies immediately');

    // The exchange the user signed out from underneath now answers. Applying it
    // would sign them back in.
    pending.resolve(session());
    await Promise.all([refreshing, loggingOut]);

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
    const { auth, store } = await startRestored(40);
    auth.dispose();
    await after(80);

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
    const channel = new BroadcastChannel(CHANNEL);
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

    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ kind: 'logout' });
    await after(20);
    channel.close();

    assert.equal(auth.session.value, null);
  });

  it('keeps two sessions in one page apart', async () => {
    // A shell and a remote with its own session share a document, and the shared
    // name is the default one.
    const shell = start();
    const remote = start();
    await Promise.all([shell.auth.init(), remote.auth.init()]);
    shell.auth.session.value = session();
    remote.auth.session.value = session({ subject: 'service-account' });

    await shell.auth.logout();
    await after(20);

    assert.equal(present(remote.auth.session.value).subject, 'service-account');
  });

  it('ignores a session with another name', async () => {
    const auth = new AuthSession(fakeStore(), { name: 'billing' });
    live.push(auth);
    await auth.init();
    auth.session.value = session();

    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ kind: 'logout' });
    await after(20);
    channel.close();

    assert.notOk(auth.session.value === null, 'another application on the origin logged out');
  });

  it('re-reads its own store rather than trusting a broadcast payload', async () => {
    // Anything on the origin can post to this channel. A session is not something
    // a postMessage may introduce, so a "changed" message is a prompt to ask the
    // store, never a session to adopt.
    const { auth, store } = start();
    await auth.init();

    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ kind: 'changed', session: session() });
    await after(20);
    channel.close();

    assert.equal(auth.session.value, null, 'the store answered null, and the store is the source');
    assert.ok(store.calls.includes('init'), store.calls.join(' '));
  });
});
