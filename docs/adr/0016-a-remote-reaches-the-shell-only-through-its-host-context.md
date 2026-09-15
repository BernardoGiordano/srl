# ADR-0016: A remote reaches the shell only through its host context

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/mfe.js`, `source/lib/host/remote-host.js`

## Context

A remote is a separately released static folder mounted under the shell's origin. It needs an authorized `fetch`, permission checks, navigation and translation.

The shortcut is to let the remote import `@auth/session.js`, since the import map already resolves it. That makes the shell's whole module graph a public API. It also only works for remotes built on the same stack, and it hands the remote the session with no way to limit or revoke it.

## Decision

A remote reaches the shell through `mount(host)` and nothing else. The host context is a capability object for one remote. It is bounded by that remote's declared `grants` and revoked when the remote's root unmounts. `host.auth.fetch` authorizes requests, so no token crosses the boundary.

The contract is `rootTag`, a `mount(host)` that returns one root element per mount, and the `contract` version the remote targets. The shell knows a remote's mount path and root tag and nothing about its internals. A remote shares the shell's stack and never its state.

## Consequences

- `core/remotes/mfe.js` imports no auth. The adapter that builds a context lives in `host/`, which keeps the dependency rule intact.
- Leaving a route revokes the context, so a stale reference gets a refusal instead of a live credential.
- Anything a remote needs must be in the contract. Changing the contract bumps its version, and `tools/test/frozen-interface.test.mjs` checks it.
