# ADR-0027: The default REMOTE_HOST wiring lives in `host/`, not in `core/`

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/host/runtime.js`, `source/lib/core/application/runtime.js`

## Context

`@core/remotes/mfe.js` obtains a remote's guard and its capability context from the
injector's `REMOTE_HOST` token, which is what keeps `core/` free of any import from
`auth/` (ADR-0016).

The cost landed on every application that mounts a remote: one line of ceremony declaring
a library-internal token, knowing which module implements it, and ordering it after the
manifest and before the route table — for a choice with one sensible answer. An
application that forgot it booted fine and failed on the first navigation into a remote.

Two other placements were considered. Installing the default in
`@core/application/runtime.js` would make `core/` import `auth/` transitively, through
`createRemoteHostProvider`'s read of the session, and collapse the seam the arrangement
exists to hold open. A field on `ApplicationSpec` would keep the direction correct and
still leave the application naming an adapter it has no reason to choose between — a
default that has to be passed is not a default.

## Decision

The default wiring lives in `@host/runtime.js`, and an application declares that it mounts
remotes by which startup function it calls: `startHostedApplication` rather than
`startApplication`.

The default is installed before the application's own `providers` hook, and `provide`
replaces, so an application with a different capability policy installs its own from that
hook. One that wants nothing from `host/` calls `startApplication` directly and imports
nothing from here.

## Consequences

The dependency direction stays application → components → host → {core, auth}, verified by
`npm run verify`, and the ceremony disappears from application code.

`host/` becomes a real layer with one job rather than a directory holding one adapter,
which is what makes the layer worth naming in the dependency rule.
