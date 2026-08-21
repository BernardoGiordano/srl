# ADR-0019: A projecting component renders synchronously on connect

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/elements/signal-element.js`, `source/lib/core/elements/projection.js`

## Context

Projection captures an element's authored children by *removing* them from the DOM, and
they only come back at the end of the first render (ADR-0020). Lit schedules that render
asynchronously, so until the next microtask the children sit in no document at all.

That window is visible to ordinary application code. A parent's `firstUpdated` runs before
any child it just created has rendered, so a shell that does `this.querySelector('main')`
finds nothing when its `<main>` sits inside a projecting layout. The symptom is a router
that never attaches — not an error anybody can read.

## Decision

A component with captured content calls Lit's `performUpdate()` at the end of
`connectedCallback`, which is Lit's documented way to close that window. Elements with no
projected content keep the asynchronous default.

## Consequences

`querySelector` over a projecting subtree behaves the way its author expects, and the
failure mode above cannot occur.

The cost is one synchronous render per projecting element on connect, paid on a code path
where the element's children have just been moved anyway. It also means a projecting
component's first render is not batched with its siblings'.

Reopen if Lit gains a supported hook for "render before I return from connect" that does
not require calling `performUpdate` directly.
