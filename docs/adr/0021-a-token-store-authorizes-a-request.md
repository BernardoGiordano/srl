# ADR-0021: A token store authorizes a request and never returns a credential

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/auth/session.js`, `source/lib/auth/session-policy.js`, `source/lib/auth/types.d.ts`, `example/src/auth/`

## Context

Where a browser application keeps its tokens is an open question. Current guidance ranks three strategies.

1. `bff` keeps tokens in a same-origin backend. The browser holds an HttpOnly, Secure, SameSite cookie and a CSRF token, and JavaScript never sees a token. This is the recommended design for browser OAuth.
2. `memory` keeps the access token in a private field and the refresh token in an HttpOnly cookie, and refreshes silently on load. It needs a strict CSP.
3. `dpop` binds tokens to a non-extractable key. It stops token theft and leaves XSS open (ADR-0025).

A `getToken(): string` interface would hard-code bearer semantics at every call site and rule out `bff` for good.

A store also encodes a backend contract of endpoint paths, request bodies, response fields and headers. The library can't know any of that.

## Decision

The store interface has no way to read a raw token. A store authorizes a `Request`, and `AuthSession` exposes `login`, `logout`, `fetch`, `json` and three signals.

Stores are application code. The library defines `TokenStore`, `Session`, the two error classes and `sessionFrom()`, and names no endpoint, body, field or header. `strategy` is a free-form label. `example/src/auth/` has all three strategies as examples to copy.

A store performs an exchange and rebuilds the response field by field, refusing anything it can't admit. It decides nothing about session state, retries or scheduling.

## Consequences

- Switching strategy is one expression in `main.js`.
- An adopter whose server uses different field names edits their own store and nothing in `source/lib/`.
- The library ships no working store. You copy one and adapt it.
- A third-party SDK that demands a bearer string needs its own narrow path and its own record.
