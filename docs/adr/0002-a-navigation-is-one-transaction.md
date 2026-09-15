# ADR-0002: A navigation is one transaction

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/navigation/router.js`

## Context

A navigation changes several things that must describe one screen: the URL, `routeParams`, `queryParams`, `currentPath` and the mounted chain of elements. They can't all change at the same instant, because a component reads its params when it is created.

Tearing down the old screen before building the new one fails in two common cases. A guard that refuses late, or a lazy module that 404s, leaves a blank page under the new URL. A navigation abandoned halfway leaves the route signals describing a screen that never mounted.

## Decision

The router stages what it will publish and commits it once. It builds every entering level before it tears anything down.

If a navigation fails before the first DOM change, the router restores the URL and the route signals to the chain still on screen, and reports the failure through `navigationError` (ADR-0003). `StagedNavigation.mutated` marks the first DOM change. After that point the old view is gone, so a failure is reported against the destination.

## Consequences

- What is published always matches what is mounted, so a component can trust `routeParams` when it is created.
- A failed navigation shows a message instead of a broken screen.
- Both chains exist during the overlap, so peak memory is the sum of the two screens.
- A screen too expensive to overlap with the one it replaces would reopen this. The fix would be a per-route opt-out.
