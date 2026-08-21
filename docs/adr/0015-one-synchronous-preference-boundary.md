# ADR-0015: One synchronous persistence boundary for non-auth preferences

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/preferences/persistence.js`, `tools/checks/verify-deps.mjs`

## Context

UI state — table columns, filter values, sidebar collapse, the theme, the locale — is tiny
and has to be available before first render. That rules out IndexedDB, whose interface is
asynchronous, and points at `localStorage`.

The harder question is how many places may touch it. If each owner calls `localStorage`
directly, then an application that swaps the store — for a memory store in tests, an
encrypted wrapper, a synchronously hydrated backend cache — swaps it for the table and not
for the theme, and finds out which is which by testing every screen.

## Decision

Every non-auth preference crosses `@core/preferences/persistence.js`. Nothing else in the
library or the shared collection calls `localStorage`, and `npm run verify` fails the
build when something does. The store is injectable, and each owner/id pair gets its own
versioned key so two owners cannot race over one serialized map.

Auth state is deliberately outside this boundary. Tokens live behind `@auth/` stores whose
interface never hands out a credential, and a store an application may replace with
anything synchronous is the wrong place for one. That exemption is a path rule in the
verifier rather than a judgement made inside this module.

## Consequences

One failure policy covers every caller, so none of them writes its own fallback: a read
that cannot produce current state returns `undefined`, a write that cannot store returns
`false`, and nothing throws for a storage reason. Rendering never depends on storage
having worked.

The cost is that a preference owner cannot reach for storage directly even when it would
be shorter, and adding one means adding a versioned key and a migration.

Reopen if a preference appears that is too large for `localStorage` or must survive across
origins — at which point the asynchronous store is a second boundary, not a relaxation of
this one.
