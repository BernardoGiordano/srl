# ADR-0002: A navigation is staged and committed as one transaction

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/navigation/router.js`

## Context

One navigation mutates several things that have to describe one screen: the URL,
`routeParams`, `queryParams`, `currentPath`, and the mounted chain of elements. They
cannot be mutated at one instant, because the params have to be published before the
component that reads them is created.

The straightforward implementation tears the old screen down, then builds the new one.
It fails badly in the two cases that matter. A guard that refuses late, or a lazy module
that 404s, leaves the user on a blank page with the URL of a route that never arrived. A
navigation abandoned because the user clicked something else leaves the signals
describing a screen that was never mounted, so a component that reads `routeParams` gets
parameters belonging to a URL nobody is looking at.

## Decision

A navigation stages what it is about to publish and commits it once. Every entering level
is built before anything is torn down. A navigation that fails before the first DOM
change puts the URL and the route signals back to the chain that is still on screen, and
reports the failure through `navigationError` (ADR-0003) rather than by leaving the
application in a state nothing describes.

`StagedNavigation.mutated` records the first DOM change. From that point the outgoing
view no longer exists, there is nothing coherent to return to, and a failure is reported
against the destination instead.

## Consequences

What is published is always what is mounted. A component may read `routeParams` on
creation and trust it, and a failed navigation is a message rather than a broken screen.

The cost is memory and time: both chains exist at once during the overlap, so a
navigation between two heavy screens peaks at the sum of the two rather than the larger.
No measured budget fails on it today.

This is reopened by a screen whose construction is too expensive to overlap with the one
it replaces — at which point the answer is a route-level opt-out, not abandoning the
transaction for every navigation.
