# ADR-0016: A remote reaches the shell only through its mount-scoped host context

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/mfe.js`, `source/lib/host/remote-host.js`

## Context

A remote is a separately released static folder mounted behind the shell's origin. It
needs the shell's services: an authorized `fetch`, a permission query, navigation,
translation.

The direct way to give it those is to let the remote import `@auth/session.js` — the
modules are on one origin and the import map already resolves the specifier. Doing that
makes the shell's entire module graph a public API: every internal refactor becomes a
breaking change for a separately deployed artifact nobody rebuilt. It also only works for
a remote built on the shell's stack, which defeats the point of the boundary. And it
hands the remote the session object, so there is no way to bound what it may do or to
stop it doing so after the user navigates away.

## Decision

A remote reaches the shell through `mount(host)` and nowhere else. The host context is a
capability object handed to one remote, bounded by that remote's declared `grants`, and
revoked when that exact root is unmounted. There is no token to pass, because
`host.auth.fetch` authorizes the request.

The interface is the whole contract: `rootTag`, `mount(host)` returning one root element
per route mount, and the `contract` version the remote was written against. The shell
knows a remote's mount path and root tag and nothing about its internal routes, state or
components.

## Consequences

`core/remotes/mfe.js` imports no auth, which is why it lives in `core/` while the adapter
that builds a context lives in `host/` — the seam that keeps the dependency rule true.

Capability lifetime becomes a security boundary rather than a mounting detail: leaving the
route revokes the context, so a remote holding a stale reference gets a refusal rather
than a live credential.

The cost is that anything a remote needs has to be named in the contract, and adding to
the contract means a version bump every deployed remote is checked against
(`tools/test/frozen-interface.test.mjs`).
