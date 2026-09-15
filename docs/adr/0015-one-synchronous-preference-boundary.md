# ADR-0015: One synchronous preference boundary

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/preferences/persistence.js`, `tools/checks/verify-deps.mjs`

## Context

UI preferences (table columns, filter values, sidebar state, theme, locale) are small and must be available before the first render. IndexedDB is asynchronous, so `localStorage` is the store.

If every owner calls `localStorage` directly, an application that swaps the store for tests, encryption or a hydrated cache swaps it for some owners and not others.

## Decision

Every non-auth preference goes through `@core/preferences/persistence.js`. Nothing else in the library or the collection calls `localStorage`, and `npm run verify` fails if something does. The store is injectable. Each owner and id pair gets its own versioned key, so two owners never race over one serialized map.

Auth state stays outside this boundary. Tokens live behind `@auth/` stores, which never hand out a credential.

## Consequences

- One failure policy covers every caller. A failed read returns `undefined`, a failed write returns `false`, and nothing throws. Rendering never depends on storage working.
- A new preference needs a versioned key and a migration.
- A preference too large for `localStorage`, or one that must cross origins, would need a second, asynchronous boundary.
