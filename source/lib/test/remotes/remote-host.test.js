/*
 * Bare specifiers, not relative paths, and this is not a style choice.
 *
 * Module identity is URL identity. The code under test imports
 * `@core/foundation/inject.js`, which the import map resolves to /lib/core/foundation/inject.js;
 * reaching the same file from here as '../core/foundation/inject.js' would resolve to
 * /source/lib/core/foundation/inject.js and evaluate a SECOND copy of the module, with its
 * own injector. The test then provides AuthSession into one registry while
 * remote-host.js reads from the other, and every assertion fails with
 * "No provider for AuthSession" — a failure that looks like a missing beforeEach
 * and is really two modules with the same source and different identities.
 */
import { provide, resetInjector } from '@core/foundation/inject.js';
import { locale, setLocale } from '@core/localization/i18n.js';
import { AUTH_SESSION, AuthSession } from '@auth/session.js';
import { createRemoteHostProvider } from '@host/remote-host.js';
import { assert } from '../harness.js';

/** @import { Session, TokenStore } from '@auth/types.js' */
/** @import { RemoteDescriptor } from '@core/remotes/types.js' */

/**
 * The micro-frontend host contract.
 *
 * These are the tests that matter more than the rest of the suite put together,
 * because everything they cover is a security property and every one of them fails
 * silently. A grant check that never runs looks exactly like a grant check that
 * passes; a revoked context that still works looks exactly like a live one; an
 * intersection that returns the session's whole scope list looks exactly right on
 * screen and leaks the user's other entitlements to whoever deployed the remote.
 */

/**
 * @param {Partial<RemoteDescriptor>} [overrides]
 * @returns {RemoteDescriptor}
 */
function descriptor(overrides) {
  return {
    name: 'analytics',
    url: '/remotes/analytics/remote-entry.js',
    integrity: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    assets: [],
    shared: [],
    locales: [],
    templateFiles: [],
    mount: '/analytics',
    requires: { session: true, permissions: ['analytics:read'] },
    grants: { api: ['/api/analytics/'], permissions: ['analytics:read', 'analytics:write'] },
    ...overrides,
  };
}

/**
 * A store that authorizes by stamping a header, so a test can assert that a
 * remote's call went through the shell's outbound path rather than round it.
 *
 * @returns {TokenStore}
 */
function fakeStore() {
  return {
    strategy: 'memory',
    init: () => Promise.resolve(null),
    login: () =>
      Promise.reject(new Error('login is not exercised here')),
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(null),
    authorize: (request) => {
      const authorized = new Request(request);
      authorized.headers.set('Authorization', 'Bearer test-token');
      return Promise.resolve(authorized);
    },
  };
}

/**
 * @param {readonly string[]} scopes
 * @returns {Session}
 */
function session(scopes) {
  return {
    subject: 'user-ada',
    name: 'ada',
    scopes,
    expiresAt: Date.now() + 600_000,
  };
}

describe('remote host contract', () => {
  /** @type {AuthSession} */
  let auth;
  /** @type {typeof globalThis.fetch} */
  let nativeFetch;
  /** @type {Request[]} */
  let sent;

  beforeEach(() => {
    resetInjector();
    auth = new AuthSession(fakeStore());
    provide(AUTH_SESSION, () => auth);

    sent = [];
    nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    resetInjector();
  });

  /* ── Identity ──────────────────────────────────────────────────────────── */

  it('exposes identity without exposing a credential', () => {
    auth.session.value = session(['analytics:read']);
    const { context } = createRemoteHostProvider().connect(descriptor());

    assert.equal(context.auth.user()?.name, 'ada');
    assert.equal(context.auth.user()?.subject, 'user-ada');

    // The whole point of the contract. Anything resembling a token accessor here
    // and a remote can persist a credential, at which point the shell's storage
    // strategy is a fiction.
    const surface = Object.keys(context.auth).join(' ');
    assert.notOk(/token|credential|bearer/iu.test(surface), `auth surface: ${surface}`);
    assert.notOk(
      'expiresAt' in /** @type {object} */ (context.auth.user() ?? {}),
      'identity must not carry token lifetime',
    );
  });

  it('reports no user when signed out', () => {
    const { context } = createRemoteHostProvider().connect(descriptor());
    assert.equal(context.auth.user(), null);
  });

  /* ── Permissions ───────────────────────────────────────────────────────── */

  it('intersects granted permissions with the session, and reveals nothing else', () => {
    auth.session.value = session(['analytics:read', 'users:read', 'payments:approve']);
    const { context } = createRemoteHostProvider().connect(descriptor());

    assert.sameArray([...context.auth.permissions()], ['analytics:read']);
    assert.ok(context.auth.can('analytics:read'));

    // Held by the session, never granted to this remote: it must not be visible
    // and must not be answerable.
    assert.notOk(context.auth.can('payments:approve'), 'an ungranted scope must read as absent');
    assert.notOk(context.auth.can('users:read'));
  });

  it('reports a granted permission the session does not hold as absent', () => {
    auth.session.value = session(['analytics:read']);
    const { context } = createRemoteHostProvider().connect(descriptor());
    assert.notOk(context.auth.can('analytics:write'));
  });

  it('notifies on a session change and stops after unsubscribe', () => {
    const { context } = createRemoteHostProvider().connect(descriptor());
    let changes = 0;
    const unsubscribe = context.auth.onChange(() => {
      changes += 1;
    });

    // Not called on subscribe. A remote subscribing during mount would
    // otherwise render twice on every load.
    assert.equal(changes, 0, 'subscribing must not count as a change');

    auth.session.value = session(['analytics:read']);
    assert.equal(changes, 1);

    auth.session.value = null;
    assert.equal(changes, 2);

    unsubscribe();
    auth.session.value = session(['analytics:read']);
    assert.equal(changes, 2, 'unsubscribe must be honoured');
  });

  it('contains a listener that throws', () => {
    const { context } = createRemoteHostProvider().connect(descriptor());
    let reached = 0;

    context.auth.onChange(() => {
      throw new Error('the remote is buggy');
    });
    context.auth.onChange(() => {
      reached += 1;
    });

    auth.session.value = session(['analytics:read']);
    auth.session.value = null;

    // A remote's broken listener must not dispose the effect that feeds every
    // other subscriber, and must not propagate into the shell's signal write.
    assert.equal(reached, 2, 'a throwing listener must not stop the others');
  });

  /* ── API grants ────────────────────────────────────────────────────────── */

  it('authorizes a granted call through the shell outbound path', async () => {
    auth.session.value = session(['analytics:read']);
    const { context } = createRemoteHostProvider().connect(descriptor());

    const response = await context.auth.fetch('/api/analytics/summary');
    assert.ok(response.ok);
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]?.headers.get('Authorization'),
      'Bearer test-token',
      'the credential must have been attached by the shell, not by the remote',
    );
  });

  it('refuses a path outside the grant, before any request is made', async () => {
    auth.session.value = session(['analytics:read', 'users:read']);
    const { context } = createRemoteHostProvider().connect(descriptor());

    await assert.rejects(() => context.auth.fetch('/api/users'), 'is not granted /api/users');
    assert.equal(sent.length, 0, 'nothing may reach the network');
  });

  it('refuses a sibling path that merely shares the granted prefix', async () => {
    const { context } = createRemoteHostProvider().connect(
      descriptor({ grants: { api: ['/api/analytics/'], permissions: [] } }),
    );

    // The trailing slash the manifest validator insists on is what makes this fail.
    // Without it, `/api/analytics-admin/` starts with `/api/analytics` and passes.
    await assert.rejects(() => context.auth.fetch('/api/analytics-admin/keys'), 'is not granted');
    assert.equal(sent.length, 0);
  });

  it('refuses a cross-origin call', async () => {
    const { context } = createRemoteHostProvider().connect(descriptor());
    await assert.rejects(
      () => context.auth.fetch('https://evil.example.com/api/analytics/summary'),
      'same-origin API calls only',
    );
    assert.equal(sent.length, 0);
  });

  it('refuses everything when the remote is granted no api paths', async () => {
    const { context } = createRemoteHostProvider().connect(
      descriptor({ grants: { api: [], permissions: [] } }),
    );
    await assert.rejects(() => context.auth.fetch('/api/analytics/summary'), 'no API paths');
  });

  it('does not let a traversal escape the granted prefix', async () => {
    const { context } = createRemoteHostProvider().connect(descriptor());

    // `new URL` normalises the path before the prefix is tested, so the check runs
    // against /api/users rather than against the literal string. Doing the check on
    // the raw string instead would pass this.
    await assert.rejects(
      () => context.auth.fetch('/api/analytics/../users'),
      'is not granted /api/users',
    );
    assert.equal(sent.length, 0);
  });

  it('throws on a non-2xx from json()', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('nope', { status: 503 }));
    const { context } = createRemoteHostProvider().connect(descriptor());
    await assert.rejects(() => context.auth.json('/api/analytics/summary'), '503');
  });

  /* ── Revocation ────────────────────────────────────────────────────────── */

  it('makes every capability inert once revoked', async () => {
    auth.session.value = session(['analytics:read']);
    const host = createRemoteHostProvider().connect(descriptor());
    let changes = 0;
    host.context.auth.onChange(() => {
      changes += 1;
    });

    host.revoke();

    assert.throws(() => host.context.auth.user(), 'has been revoked');
    assert.throws(() => host.context.auth.permissions(), 'has been revoked');
    assert.throws(() => host.context.router.path(), 'has been revoked');
    assert.throws(() => host.context.i18n.locale(), 'has been revoked');
    await assert.rejects(() => host.context.auth.fetch('/api/analytics/summary'), 'has been revoked');

    // Subscriptions go with it, or a torn-down remote keeps re-rendering into
    // detached DOM on every session change.
    auth.session.value = null;
    assert.equal(changes, 0, 'revoke must drop subscriptions');
  });

  it('is frozen, so a remote cannot replace its own grant check', async () => {
    const { context } = createRemoteHostProvider().connect(descriptor());

    assert.ok(Object.isFrozen(context), 'the context must be frozen');
    assert.ok(Object.isFrozen(context.auth), 'nested capabilities must be frozen too');

    // Non-strict assignment to a frozen object is a silent no-op; module code is
    // strict and throws. Either way the swap must not take.
    try {
      /** @type {{ fetch: unknown }} */ (context.auth).fetch = () => Promise.resolve(new Response());
    } catch {
      // expected under strict mode
    }

    // Asserted by behaviour rather than by identity: had the replacement taken,
    // this would resolve instead of rejecting, and the grant check would be gone.
    await assert.rejects(() => context.auth.fetch('/api/users'), 'is not granted');
  });

  /* ── Translation and routing ───────────────────────────────────────────── */

  it('carries the shell locale and translation', async () => {
    const { context } = createRemoteHostProvider().connect(descriptor());
    const before = locale.value;
    try {
      await setLocale('en');
      assert.equal(context.i18n.locale(), 'en');
      assert.equal(context.i18n.direction(), 'ltr');

      // A missing key renders as the key. The remote gets the shell's behaviour
      // rather than a second, divergent fallback rule of its own.
      assert.equal(context.i18n.t('no.such.key.here'), 'no.such.key.here');
    } finally {
      await setLocale(before);
    }
  });

  it('exposes the shell current path', () => {
    const { context } = createRemoteHostProvider().connect(descriptor());
    assert.equal(context.router.path(), location.pathname);
  });

  /* ── Mount guards ──────────────────────────────────────────────────────── */

  it('builds no guard for a remote with no requirements', () => {
    const guard = createRemoteHostProvider().guard(
      descriptor({ requires: { session: false, permissions: [] } }),
    );
    assert.equal(guard, undefined, 'an unguarded route must not pay for an await');
  });

  it('sends an anonymous visitor to login and an unentitled one to forbidden', async () => {
    const guard = createRemoteHostProvider().guard(descriptor());
    if (guard === undefined) throw new Error('a guard was expected');

    const route = { path: '/analytics/*' };
    /** @type {import('../../core/navigation/types.js').RouteMatch} */
    const match = {
      route,
      chain: [route],
      params: {},
      pathname: '/analytics',
      query: new URLSearchParams(),
    };

    assert.equal(await guard(match), '/login', 'no session means sign in');

    // Signed in, but without the scope the manifest requires. Sending this user to
    // /login is the classic loop: they sign in successfully and land right back
    // here.
    auth.session.value = session(['users:read']);
    assert.equal(await guard(match), '/forbidden');

    auth.session.value = session(['analytics:read']);
    assert.equal(await guard(match), true);
  });
});
