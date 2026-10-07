# ADR-0133: One canonical form for every path a module compares

- Status: accepted
- Date: 2026-10-07
- Affects: `source/lib/core/foundation/paths.js`, `source/lib/core/remotes/manifest-policy.js`, `source/lib/core/navigation/router.js`, `source/lib/host/remote-host.js`, `source/lib/core/http/client.js`, `cli/delivery/release-target.mjs`

## Context

Five modules compared paths, and each canonicalized them its own way. A path one
module accepted meant something else to the next.

The router resolved a link, then navigated to its pathname as text. The link
`/.//evil.example/x` resolves to the pathname `//evil.example/x`, which parses again as
another origin, so a same-origin link left the application. `navigate('javascript:…')`
reached `location.assign` and ran in the page, and a remote reached it through
`host.router.navigate`.

The remote host compared a grant to the parsed pathname with `startsWith`. The browser
keeps `%2F`, `%5C` and `..;` as written, and a server reads them afterwards. nginx decodes
`/api/analytics/..%2f..%2fadmin` before it resolves dots, and a servlet container reads
`..;` as `..`. The check also passed a call the server then redirected.

Manifest admission normalized a grant, so `//evil.example/`, `/api/../` and `/api/x?/`
became wider prefixes than the ones written. It admitted the mounts `/a//b` and `/a/b`
as two, while the router reads both as `/a/b`, so declaration order picked the guard.

`ApiClient` joined its base and a path as text. With the base `/`, the paths `//host` and
`/\host` left the origin, and `/../x` climbed out of any base path.

`validateAbsolutePath` accepted `/..`, `//` and `/srv/..` as release roots.

Three alternatives lost.

**Fixing each module in place.** Each fix would be a sixth rule beside the five. The
next module that compares paths would write a seventh.

**Normalizing instead of refusing.** A path that only lands inside a prefix after cleanup
was written to leave it. Refusing names the bad input, as ADR-0132 does for output paths.

**Refusing non-canonical paths in `ApiClient`.** An application encodes a record id with
`encodeURIComponent`, and an id holding `/` arrives as `%2F`. The client confines the
result to its base and leaves the path's spelling to the application.

## Decision

`source/lib/core/foundation/paths.js` holds the one canonical form. It imports nothing,
so Node tools and `manifest-policy.js` load it by relative path.

- `admitPath(text, where, { query })` returns root-relative text unchanged, or refuses
  it. It refuses a backslash, a missing or doubled leading `/`, a fragment, a query unless
  asked, and any text the URL parser would change. Then it applies `admitPathname`.
- `admitPathname(url, where)` refuses what a parsed URL still carries. That is an escaped
  separator or dot (`%2F`, `%5C`, `%2E`), a segment that is `.` or `..` before a `;`, and
  an empty segment other than a trailing slash.
- `within(prefix, path)` holds a path equal to the prefix or below it. Both sides are
  admitted, so the comparison is a string comparison.
- `destination(href, origin)` names a route or an external http or https URL, and
  refuses every other scheme. The URL travels whole.

The callers follow it.

- Manifest admission admits every URL, mount and grant through `admitPath`. A grant
  prefix is refused unless written as the path it confers. Mount containment uses
  `within`.
- The router carries absolute hrefs and URL objects, and never parses a pathname as a
  reference. `navigate` throws synchronously for a refused scheme. A guard or route
  redirect that leaves the origin fails the navigation.
- The remote host admits the request's pathname, compares it with `within`, and sends
  every granted call with `redirect: 'error'`.
- `ApiClient` resolves its base once and rejects a request URL that leaves the base's
  origin or path.
- `validateAbsolutePath` refuses a release root that `admitPath` refuses.

## Consequences

- A manifest grant written as `/api/reports/../analytics/` used to be admitted as
  `/api/analytics/`, and is now refused.
- A remote's call to a path holding `%2F`, `%5C`, `%2E`, `..;` or `//` is refused, even
  under its grant. A remote whose API names records by slash-holding ids needs another
  spelling.
- A remote's granted call fails when the server answers with a redirect.
- `navigate('javascript:…')` throws instead of resolving. A shell or remote that passed
  an href from data needs a try.
- `ApiClient.get` is `async`, so a refused path rejects like every other failure.
- A new module that compares paths imports `paths.js` instead of writing a rule.
