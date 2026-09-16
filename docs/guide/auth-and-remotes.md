# Authentication and remotes

## Sessions

Applications provide a token store because each backend has its own endpoints,
payloads, and headers. The library supplies `AuthSession` and the store
interface. The example has memory, BFF cookie, and DPoP stores to copy and adapt.

```js
provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth')));
```

A store authorizes a `Request`; it does not return a token to callers. This
allows the BFF store to work even though JavaScript cannot read its HttpOnly
session cookie.

`AuthSession` owns login, restore, scheduled refresh, a refresh shared by
concurrent requests in that session, cross-tab coordination, and disposal.
`AuthSession.fetch()` and `.json()` send authorized requests. Route guards
use `requireSession` and `requireScope(scope)`.

A store calls `sessionFrom()` in `source/lib/auth/session-policy.js` to admit
a server response. It validates the identity, scopes, and expiry before the
rest of the library sees a session. The module also gives stores field readers
that reject malformed values without printing credentials.

| Failure | Meaning | Session result |
|---|---|---|
| `AuthRejected` | The server refused the grant or returned an invalid session. | End the session and notify other tabs. |
| `AuthUnavailable` | Transport failed or the server returned 5xx. | Keep the session while refresh retries before expiry. |

An expired session ends even if the network remains unavailable. DPoP can limit
the use of a stolen token, but code running on the page can still make requests
as the user. See [ADR-0025](../adr/0025-dpop-defeats-token-theft-not-xss.md).

## Remote host context

The shell passes a frozen context into each remote's `mount(host)`. The
context offers authorized fetch, limited permission checks, translation,
navigation, and the remote's mount path.

```js
host.auth.fetch('/api/analytics/summary');
host.auth.can('analytics:write');
host.auth.user();
host.i18n.t('analytics.title');
host.router.navigate('/analytics');
```

The context exposes callbacks rather than a signal type, so a remote can use
another reactive library. Billing shares the shell's import map and component
collection. Analytics uses relative imports and a plain custom element.
Neither imports the shell's route state. Each entry declares the host contract
version it supports.

A context belongs to one mount. Leaving the route revokes it, releases its
subscriptions, and runs remote cleanup. A later visit receives a new context.

## Manifest policy

A remote's `requires` block guards the route before its code loads. Its
`grants` block limits which API paths and permissions the host context offers.

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

The host checks API grants against normalized URL paths. A grant prefix ends
with `/`, so `/api/analytics/` cannot also grant
`/api/analytics-admin/`. `host.auth.permissions()` shows the intersection
of granted permissions and the user's scopes. The server still enforces its
own authorization.

`manifest-policy.js` admits the whole manifest before routes or requests
use it. It requires same-origin, root-relative URLs; checks locale patterns
against allowed locales; rejects duplicate or nested remote mounts; and
freezes the admitted result. The browser and `npm run verify` run the same
policy. The remote entry and its imports also need matching integrity hashes
in the manifest and import map.

Adding a remote means adding its manifest entry, import-map pins, and a
`nav.<name>` message key.

## Trust boundary

Remotes run on the shell's origin in the same JavaScript realm. A hostile
remote can access `document` and call browser APIs outside the host context.
The grants help trusted teams avoid accidental scope and API use; they do not
isolate untrusted code. Untrusted code needs a separate origin and an iframe
message boundary.

The server sees the user's session, not which remote issued a request. Hard
per-remote API enforcement would require the backend to issue a restricted
credential for each remote. The host's `auth.fetch` method is the place to
add that exchange because remotes receive no credential directly.
