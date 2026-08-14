import { effect } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { readJson } from '@core/foundation/json.js';
import { HOST_CONTRACT } from '@core/remotes/mfe.js';
import { currentPath, navigate } from '@core/navigation/router.js';
import { direction, locale, messageTable, registerMessages, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

/** @import { RouteGuard } from '@core/navigation/types.js' */
/** @import { HostContext, RemoteDescriptor, RemoteHost, RemoteHostProvider, Unsubscribe } from '@core/remotes/types.js' */

/**
 * The shell's side of the micro-frontend host contract.
 *
 * The one module in the library above both `core` and `auth`: it knows a session
 * exists, so that an application does not reimplement the grant enforcement
 * below. `core/remotes/mfe.js` asks the injector for a REMOTE_HOST provider and
 * this is the one installed for it, from `host/runtime.js`. An application with a
 * different policy provides its own and imports nothing from here.
 *
 * What crosses the boundary is a capability, not a credential: the remote
 * receives a function that performs an authorized request, not the means to
 * authorize one. Each remote gets its own object, bounded by its own grants, and
 * the shell can take it back. ADR-0016.
 *
 * THIS IS NOT A SANDBOX. A remote runs in the shell's realm, on the shell's
 * origin, and hostile remote code can reach `document` and patch `fetch`. The
 * grants are least privilege against mistakes and scope creep between trusted
 * teams, plus an audit point; the API allowlist is defence in depth for the same
 * reason. ADR-0026.
 */

/**
 * @returns {RemoteHostProvider}
 */
export function createRemoteHostProvider() {
  return { guard: guardFor, connect };
}

/**
 * Access control on the mount path, from the manifest's `requires` block.
 *
 * Returning `undefined` rather than a permissive guard matters: the router skips
 * the await entirely for an unguarded route, and "no guard" reads differently in
 * a debugger from "a guard that always allows".
 *
 * @param {RemoteDescriptor} remote
 * @returns {RouteGuard | undefined}
 */
function guardFor(remote) {
  const { session, permissions } = remote.requires;
  if (!session && permissions.length === 0) return undefined;

  // Two denials with two destinations. Anonymous means "sign in and come back",
  // which is a redirect to /login; signed in but unentitled means "this is not
  // for you", which must not bounce to a login form that would succeed and change
  // nothing. Collapsing them is the reason so many applications send an
  // authenticated user round a login loop.
  //
  // Synchronous, because main.js awaits `AuthSession.init()` before the router
  // resolves its first route: the session is settled by the time any guard runs.
  // Same reasoning as @auth/guard.js, and the same payoff — a deep link into a
  // remote does not race the session restore and bounce to /login.
  return () => {
    const auth = inject(AUTH_SESSION);
    if (!auth.isAuthenticated.value) return '/login';

    const held = auth.scopes.value;
    return permissions.every((permission) => held.includes(permission)) ? true : '/forbidden';
  };
}

/**
 * Build one remote's capabilities.
 *
 * @param {RemoteDescriptor} remote
 * @returns {RemoteHost}
 */
function connect(remote) {
  let revoked = false;

  /** @type {Unsubscribe[]} */
  const subscriptions = [];

  /** Guard every entry point, so a revoked context is inert rather than stale. */
  function alive() {
    if (revoked) {
      throw new Error(
        `The host context for remote "${remote.name}" has been revoked. This is a remote holding ` +
          `on to capabilities after the shell tore it down.`,
      );
    }
  }

  /**
   * Adapt a signal to a callback, which is the whole of the reactive boundary.
   *
   * `effect` runs its body immediately to collect dependencies, and that first run
   * is not a change: calling the listener during `mount` would have every
   * remote render twice on load and would make a "reload on change" handler fire
   * once before there was anything to reload.
   *
   * A listener that throws is contained. It belongs to the remote, it runs inside
   * the shell's effect, and letting it propagate would dispose that effect and
   * silently stop every later notification.
   *
   * @param {() => unknown} read
   * @param {() => void} listener
   * @returns {Unsubscribe}
   */
  function onChange(read, listener) {
    alive();
    let first = true;
    const dispose = effect(() => {
      read();
      if (first) {
        first = false;
        return;
      }
      if (revoked) return;
      try {
        listener();
      } catch (cause) {
        console.error(`[${remote.name}] a host onChange listener threw`, cause);
      }
    });
    subscriptions.push(dispose);
    return () => {
      dispose();
      const index = subscriptions.indexOf(dispose);
      if (index !== -1) subscriptions.splice(index, 1);
    };
  }

  /**
   * Resolve a request target against the remote's API grants.
   *
   * Rejecting rather than returning a 403 is deliberate: an ungranted call is a
   * bug in the remote, not a runtime condition to handle, and a thrown error
   * names the remote, the path and the grants it does have.
   *
   * @param {string} path
   * @returns {URL}
   */
  function resolveGranted(path) {
    const url = new URL(path, location.origin);

    if (url.origin !== location.origin) {
      throw new Error(
        `Remote "${remote.name}" tried to call ${url.origin} through host.auth.fetch. The host ` +
          `context authorizes same-origin API calls only; a token for another origin's audience ` +
          `is not the shell's to issue.`,
      );
    }
    if (!remote.grants.api.some((prefix) => url.pathname.startsWith(prefix))) {
      throw new Error(
        `Remote "${remote.name}" is not granted ${url.pathname}. app.manifest.json grants it ` +
          `${remote.grants.api.length === 0 ? 'no API paths' : remote.grants.api.join(', ')}. ` +
          `Widen the grant in the manifest if this call is intended, so the change is reviewable ` +
          `where every other remote's authority is written down.`,
      );
    }
    return url;
  }

  /** @returns {readonly string[]} */
  function permissions() {
    const held = inject(AUTH_SESSION).scopes.value;
    // Intersection, not the session's own list. A remote may ask about the
    // permissions it was granted and learns nothing about the rest of the user's
    // entitlements, which is a real leak in most implementations of this pattern:
    // handing over the whole scope list tells an analytics widget who can approve
    // payments.
    return remote.grants.permissions.filter((permission) => held.includes(permission));
  }

  /** @type {HostContext} */
  const context = {
    contract: HOST_CONTRACT,
    name: remote.name,
    mount: remote.mount,

    auth: {
      user() {
        alive();
        const session = inject(AUTH_SESSION).session.value;
        // Rebuilt rather than passed through: `Session` also carries `scopes` and
        // `expiresAt`, and the second of those is a hint about token lifetime that
        // a remote has no use for and might start scheduling against.
        return session === null ? null : { subject: session.subject, name: session.name };
      },

      permissions() {
        alive();
        return permissions();
      },

      can(permission) {
        alive();
        return permissions().includes(permission);
      },

      onChange(listener) {
        return onChange(() => inject(AUTH_SESSION).session.value, listener);
      },

      // `async` so that an ungranted path arrives as a rejected promise rather
      // than a synchronous throw. Otherwise every call site needs both a
      // try/catch and a .catch to cover one failure.
      async fetch(path, init) {
        alive();
        return inject(AUTH_SESSION).fetch(resolveGranted(path), init);
      },

      async json(path, init) {
        alive();
        const response = await inject(AUTH_SESSION).fetch(resolveGranted(path), {
          ...init,
          headers: { Accept: 'application/json', ...init?.headers },
        });
        if (!response.ok) {
          throw new Error(`${String(response.status)} ${response.statusText} for ${path}`);
        }
        // `unknown`, not a generic. The remote is across a deployment boundary from
        // whatever produced this JSON, so it is the one place in the application
        // that must validate rather than assert. See readSummary in
        // remotes/analytics/analytics-root.js.
        /** @type {unknown} */
        const body = await readJson(response);
        return body;
      },
    },

    router: {
      path() {
        alive();
        return currentPath.value;
      },
      navigate(to) {
        alive();
        // Not restricted to the remote's own mount path. A URL change is not a
        // privilege: a remote can already render an <a href> to anywhere, and the
        // guards decide what the destination is allowed to show.
        //
        // The completion is dropped rather than handed across the seam: a remote
        // that could await the shell's navigation would learn when a guard
        // redirected it somewhere else.
        void navigate(to);
      },
      onChange(listener) {
        return onChange(() => currentPath.value, listener);
      },
    },

    i18n: {
      locale() {
        alive();
        return locale.value;
      },
      direction() {
        alive();
        return direction.value;
      },
      t(key, params) {
        alive();
        return t(key, params);
      },
      register(pattern) {
        alive();
        return registerMessages(pattern);
      },
      onChange(listener) {
        // Both, because a remote loading later merges its bundle into the table
        // without touching the locale.
        return onChange(() => [locale.value, messageTable.value], listener);
      },
    },
  };

  return {
    // Frozen so a remote cannot swap `auth.fetch` for its own and leave the next
    // remote using it. Shallow is enough: the nested objects are frozen too.
    context: deepFreeze(context),

    revoke() {
      revoked = true;
      for (const dispose of subscriptions.splice(0)) dispose();
    },
  };
}

/**
 * @template {object} T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null) deepFreeze(nested);
  }
  return Object.freeze(value);
}
