# ADR-0089: A tab learns its release changed at a commit boundary

- Status: accepted
- Date: 2026-09-02
- Affects: `source/lib/core/application/release.js`, `source/lib/core/application/types.d.ts`

## Context

Internal tools stay open all day. After a deploy, a tab keeps running its old chunks until a navigation asks for a hash-named chunk that no longer exists, and the user sees a route that won't load. Every artifact emits `build.json` with the application name, commit and build date, and nothing read it.

Polling on a timer asks while the user is reading and can't act on the answer. Reloading automatically destroys unsaved work.

## Decision

The tab checks at the end of each navigation, when `isNavigating` falls back to `false`. That is the moment the DOM changes (ADR-0002), and the moment the application could act.

- Checks are throttled on the library clock (ADR-0079), by default to one a minute.
- `runningRelease` is what the tab loaded, `releaseChanged` says whether the origin has moved on, and `watchRelease()` starts and stops the watch.
- A `build.json` with no identity, or in an unknown shape, gives no answer. The application name is part of the identity.
- Once `releaseChanged` is `true` it stays `true`, and the watch stops.

The application decides what to show and whether to reload.

## Consequences

- `core/application` imports `core/navigation`, which the dependency rule allows.
- A navigation costs at most one conditional GET, which usually returns 304.
- `watchRelease()` is opt-in. The example doesn't call it, because it would add requests the benchmark gates on.
- A dashboard left on one screen never reaches a commit boundary and would need a second trigger.
