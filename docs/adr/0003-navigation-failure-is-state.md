# ADR-0003: Navigation failure is state

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/navigation/router.js`

## Context

A navigation fails when a guard refuses, a redirect loops or a lazy module doesn't load. Rejecting the promise that `navigate()` returns looks like the natural channel, but most navigations have no caller to reject to. Link clicks and the back button start navigations, and neither has a `catch`. A router that only reports failures started from code turns a broken route into a blank page with an empty console.

## Decision

`navigationError` is a signal. Every navigation writes its failure there, whatever started it, and a successful navigation clears it. The signal always describes the URL on screen.

The entry navigation also rejects `attachRouter`, because startup is a real caller and must not continue.

## Consequences

- A shell renders one error region and covers every failure path.
- `navigate()` resolves when the navigation settles, so a caller can wait without handling a rejection.
- A caller that wants to branch on failure reads a signal instead of using `try`/`catch`.
- A caller that must stop on failure and can't read state would reopen this.
