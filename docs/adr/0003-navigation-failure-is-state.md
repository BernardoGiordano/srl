# ADR-0003: Navigation failure is state, not a rejected promise

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/navigation/router.js`

## Context

A navigation can fail: a guard refuses, a redirect loops, a lazy module does not load.
The obvious channel is the promise `navigate()` already returns, rejected.

Most navigations have no caller to reject at. A link click and the back button both start
one, and neither has a `catch`. A router that only reports code-initiated failures is how
a broken route becomes a blank page with nothing in the console, on exactly the paths
users take most.

## Decision

`navigationError` is a signal, cleared when a navigation succeeds, so it always describes
the URL currently on screen. Every navigation publishes its failure there whatever
started it.

The entry navigation is the exception. It is part of attaching the router, so its failure
also rejects `attachRouter` — an application that cannot resolve its first URL has a
caller, and that caller is the startup sequence.

## Consequences

A shell can render one error region and cover every failure path, including the ones no
code initiated. `navigate()` still resolves when the navigation settles, so callers that
want to wait can, and callers that only wanted to move on do not have to handle a
rejection they cannot act on.

The cost is that a failure is not thrown, so a caller that wants to branch on it reads a
signal rather than writing `try`/`catch`. This is reopened if navigation grows a caller
that must not proceed on failure and cannot read state — none exists today.
