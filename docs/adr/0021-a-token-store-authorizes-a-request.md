# ADR-0021: A token store authorizes a request and never returns a credential

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/auth/session.js`, `source/lib/auth/types.d.ts`, `example/src/auth/`

## Context

Where a browser application keeps its tokens is not a settled question, and this
repository does not pretend it is. Three implementations satisfy one interface. The
ranking is the current consensus, not a menu of equals:

1. **`bff`** — a same-origin backend-for-frontend holds the tokens. The browser gets an
   HttpOnly, Secure, SameSite cookie plus a CSRF token, and JavaScript never sees a token
   at all. This is the recommended architecture for browser-based OAuth and the only one
   that closes both the XSS signing-oracle attack and fresh-token acquisition. It costs a
   backend hop and the infrastructure to run it.
2. **`memory`** — access token in a private field, refresh token in an HttpOnly cookie
   issued by the authorization server, silent refresh on load. Nothing in `localStorage`,
   ever. Survives a reload through the refresh call, dies with the tab. Needs a strict CSP
   to be worth anything.
3. **`dpop`** — sender-constrained tokens signed by a non-extractable key. Defeats token
   theft and does not survive script execution on the origin (ADR-0025).

The interface shape is what decides whether that choice stays open. The obvious signature
is `getToken(): string`. Every call site that used it would hard-code bearer semantics,
and the `bff` strategy — where the token is genuinely unreachable from JavaScript — could
not be retrofitted without rewriting all of them.

The second question is who *owns* a store. An earlier arrangement kept all three in
`source/lib/auth/stores/` and had the manifest name one, which made the library the author
of a backend contract: three endpoint paths, two request bodies, seven response field
names and a header name, none of which the library can know and all of which an adopter
would have had to make their server agree with.

## Decision

The store interface exposes no way to obtain a raw token. A store authorizes a `Request`;
it never hands out a credential, and neither does `AuthSession`. Callers get `login`,
`logout`, `fetch`, `json` and three signals.

**A store is application code.** The library defines `TokenStore`, the `Session` type, the
two error classes and `sessionFrom()`; it names no endpoint, no request body, no response
field and no header, and `strategy` is a free-form label rather than a closed union. The
manifest's `auth` block is one key, `apiBaseUrl`, which is a location and not a protocol.
`example/src/auth/` carries the three implementations as worked examples to copy.

Stores stay adapters behind that seam. They perform an exchange and admit its payload
(ADR-0023); they decide nothing about session state, retries or scheduling.

## Consequences

Switching strategy is one expression in `main.js`, and a strategy that cannot expose a
token is expressible — which is the whole reason the storage question can be left open in
a repository that has to ship something today.

An adopter whose authorization server calls its fields something else changes their own
store and nothing in `source/lib/`. The price is that adopting this library does not
hand you a working store: you copy one of the three and edit it, which is the honest
representation of a job only you can do.

The cost of the interface itself is that anything genuinely needing a bearer string, such
as a third-party SDK that only accepts one, cannot be served by it and has to be given its
own narrow path with its own record.
