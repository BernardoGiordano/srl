# Auth and the remote security model

## Sessions and tokens

`source/lib/auth/` holds one module for the authenticated request lifecycle and one for
session admission. It holds no token store, and that is the point: a store knows its
backend's endpoints, request bodies, response field names and headers, and a library that
named any of them would be dictating a contract to a server it cannot see. An application
constructs its own and hands it to `AuthSession`:

```js
provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth')));
```

`example/src/auth/` carries three worked implementations — `memory`, `bff` and `dpop` —
which are a starting point to copy rather than a menu to configure. What the library fixes
is the interface: no store exposes `getToken()`, a store authorizes a `Request` instead.
That single choice is what makes the `bff` strategy, where JavaScript genuinely cannot
read a token, implementable without changing a caller.

`AuthSession` owns everything that has to happen in an order: the single-flight refresh
every concurrent 401 shares, the refresh scheduled before expiry, the cross-tab
coordination, and disposal. `AuthSession.fetch()` and `.json()` are the interceptor
equivalent, and the store is an adapter under them rather than a peer beside them. The
single-flight refresh used to be a module-level variable in a separate `authorized-fetch.js`,
which shared it between every session in the process rather than between every caller of
one; that file is gone.

`requireSession` and `requireScope(scope)` are route guards over a settled session. Read
the header of `example/src/auth/dpop-store.js` before believing a non-extractable key
solves XSS — it explicitly does not survive script execution on the origin.

## Nothing becomes a session without admission

`source/lib/auth/session-policy.js` owns the last step of every exchange: a store reads
its own payload and calls `sessionFrom()`, which rebuilds the session field by field or
refuses it. That is the only way to obtain a `Session`, so a store that mapped a field by
hand cannot produce one the rest of the library then trusts. The module also exports the
readers a store maps with — `asRecord`, `requireString`, `requireInstant`,
`requireStrings`, `expiryFromLifetime`, `scopesFromSpaceDelimited` — so a store gets the
same refusals, and the same never-print-the-value messages, without restating them.

A token endpoint answering HTTP 200 with a body missing the subject
used to produce a client session whose every field was `undefined`, an
`isAuthenticated` signal reading true, and `Authorization: Bearer undefined` on the next
request. A correct server still refuses that request — this was never a server bypass —
but the client had already let the user past its own guards with no way back.

The same module classifies failure, because the refresh timer acts without a human
present and the two cases need opposite behaviour:

| | Meaning | What the session does |
|---|---|---|
| `AuthRejected` | the grant was refused (4xx), or the payload could not be admitted | ends, and broadcasts a logout to the other tabs |
| `AuthUnavailable` | transport failed, or the server answered 5xx | stands, and the refresh retries on a backoff bounded by the token's own expiry |

An admission failure counts as terminal deliberately: an endpoint answering 200 with a
body the client cannot read is misconfigured or hostile, and neither improves on the
third attempt. Once the instant the token names has passed with no answer, the session
ends regardless of what the network is doing.

## What crosses a micro-frontend boundary

Not a token. A capability object, passed into `mount`:

```js
// example/remotes/analytics/remote-entry.js — the whole shell-facing surface
export const contract = 2;
export const rootTag = 'analytics-root';

export async function mount(host) {
  await host.i18n.register(`${base}{locale}.json`);
  return createAnalyticsRoot(rootTag, host);   // one context for this root
}
```

```js
host.auth.fetch('/api/analytics/summary')   // authorized; refresh and retry included
host.auth.can('analytics:write')            // granted ∩ session scopes
host.auth.user()                            // { subject, name }. No token, ever
host.auth.onChange(listener)                // callbacks, not signals
host.i18n.t(key, params)                    // the shell's one message table
host.router.path() / navigate(to)
```

Callbacks rather than signals is deliberate: exposing a `Signal` would oblige every
remote to import the shell's reactive library and agree on its version, which is exactly
the coupling the contract exists to remove. `HOST_CONTRACT` is `2`, and every remote
entry declares the contract it was written against — the one boundary in this repository
that already crosses a deployment line, so it is the one thing that is versioned.

Two remotes exist on purpose. `example/remotes/billing/` imports `lit`,
`@core/foundation/reactive.js` and `@app/ui/ui-card.js` by the same bare specifiers the
shell declares, so there is exactly one Lit instance and one signal graph on the page —
Module Federation's shared-singleton guarantee, for free, because module identity is URL
identity. `example/remotes/analytics/` shares nothing: two relative imports, no bare
specifiers, a plain custom element building DOM by hand. It would behave the same if it
were React with its own bundler and its own release train.

Sharing the shell's *stack* is not licence to reach for the shell's *state*: both
remotes route off `host.router` and `host.mount` rather than importing the router, so a
capability the shell handed over cannot be bypassed by a global no `revoke()` can take
back, and a mount path is written in one file.

## Least privilege lives in the manifest

```json
{
  "name": "analytics",
  "url": "/remotes/analytics/remote-entry.js",
  "integrity": "sha384-…",
  "mount": "/analytics",
  "requires": { "session": true, "permissions": ["analytics:read"] },
  "grants": {
    "api": ["/api/analytics/"],
    "permissions": ["analytics:read", "analytics:write"]
  }
}
```

- **`requires` becomes a route guard**, and the router runs guards before `load`. An
  unauthorized visitor never downloads the remote's code — asserted by a test, because
  hiding a remote's UI while still shipping its module leaks it to anyone reading the
  network tab. Anonymous goes to `/login`, unentitled to `/forbidden`; collapsing those
  two is what sends an authenticated user round a login loop.
- **`grants.api`** is the only way out. Anything else throws before a request is made,
  naming the remote, the path and the grants it does have. A prefix must end in `/`: the
  first version accepted `/api/analytics` and matched with `startsWith`, which also
  grants `/api/analytics-admin/keys` and reads as correct in both the manifest and the
  check. The grant is compared against `new URL(path).pathname`, so
  `/api/analytics/../users` normalises to `/api/users` and is refused.
- **`grants.permissions`** is what `host.auth.permissions()` is intersected against, so a
  remote learns nothing about the user's other entitlements. Most implementations of this
  pattern hand over the whole scope list, which tells an analytics widget who can approve
  payments.
- **The context is frozen and mount-scoped.** Every `mount(host)` receives a fresh
  context. Leaving the route revokes it, drops its subscriptions, invokes optional remote
  cleanup, and makes every retained method throw. A later visit gets a new root and a new
  context; only the ESM module is cached. Caching the context beside the module is
  exactly the bug that kept authority alive after route exit.
- **Executable artifacts are same-origin and SRI-pinned.** The manifest digest must match
  the static import-map integrity entry before routing starts. The browser enforces those
  pins for the dynamic entry and its relative imports, and `npm run verify` checks every
  JavaScript artifact in each remote directory.

Adding a remote is a manifest entry, matching import-map pins, and one message key:
`ui-nav` derives its links from the manifest and asks for `nav.<name>`, while
`npm run verify` rejects a missing label, a stale digest, an unpinned sub-import or a
cross-origin entry.

## The manifest is admitted as a whole, once

Checking fields one at a time cannot decide whether a manifest is safe, because the
dangerous states are combinations. `@core/remotes/manifest-policy.js` therefore admits
the whole document before anything is built from it, and everything downstream reads
admitted values rather than the fetched JSON.

- **Every URL is a same-origin root-relative path**, normalized to the destination it
  actually reaches. That covers `auth.apiBaseUrl`, which was only checked for being
  non-empty: the API base receives the user's authorization material, so a manifest that
  named another origin was one permissive deployment away from handing it over —
  `connect-src 'self'` stopped it in a hardened deployment and nowhere else. `/\host/x` and
  `//host/x` are refused by name, because the URL parser reads both as another origin
  while they read as paths. Cross-origin authentication is not expressible here on
  purpose: it needs CORS, a token minted for that audience and a CSP that admits it, which
  is a capability of a deployment rather than a string in a file fetched at startup.
- **Locale patterns are admitted through the locales they will be used with**, since
  `/i18n/{locale}.json` is not what is fetched. A tag carrying path syntax is refused, so
  the locale list cannot choose a file outside the directory the pattern names.
- **Names and mounts are checked as a set.** A mount is a whole subtree — `${mount}/*` —
  matched first-declared-first, so a duplicate mount, or one that contains another, lets
  the order of the array decide whose `requires` guard runs and whose `grants` bound the
  context. Both are refused, as are a mount carrying router syntax (`*`, `:`) and a remote
  mounted at `/`, which would own the shell's own routes.
- **The result is frozen** all the way down, so a consumer cannot repair a grant or a
  mount after policy was decided.

The module imports nothing, which is what lets `npm run verify` load it in Node and admit
every checked-in manifest through the same code the browser runs at startup. The two
adapters differ only in where the import-map pins come from — `document` in the browser,
`index.html` in the checker — so a manifest that would be refused in production is refused
by the build instead, and neither side can drift into a policy the other does not have.

## What this is not

It is not a sandbox. A remote runs in the shell's realm on the shell's origin; hostile
remote code can reach `document` and patch `fetch`. The grants are least privilege
against mistakes and scope creep between trusted teams, plus an audit point — one file
states what each remote may touch. Isolation against untrusted code means a cross-origin
iframe and `postMessage`, which costs the shared-DOM and shared-dependency benefits that
make this architecture worth having.

The API allowlist is defence in depth, not a boundary: the server sees one session for
every remote and cannot tell which one called. Making it enforceable means the shell
exchanging its token for a per-remote, audience-restricted one (RFC 8693) at a BFF. The
contract is shaped so that change lands in `source/lib/host/remote-host.js` alone —
`auth.fetch` is already the only way out, and no remote holds a credential that would
have to be re-issued.
