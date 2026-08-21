# ADR-0029: The modal is a native `<dialog>`

- Status: accepted
- Date: 2026-08-12
- Affects: `source/components/overlays/ui-dialog.js`

## Context

The usual custom overlay is a `role="dialog"` div with a backdrop node, a focus trap, a
scroll lock and a stacking-context fight. Everything it gets wrong is already specified
and already implemented by `<dialog>`:

- `showModal()` promotes the element to the top layer, so no ancestor's `overflow`,
  transform or stacking context can clip it.
- It makes the rest of the document inert, so a Tab out of the panel is impossible and a
  screen reader cannot walk into the page behind.
- It renders a `::backdrop` pseudo-element, which is the only way to blur what is
  underneath without painting a second full-screen node.
- It returns focus to whatever had it when the dialog closes.

A hand-built overlay re-implements four of those badly and the fifth not at all.

## Decision

`ui-dialog` is a native `<dialog>` shown with `showModal()`.

`aria-modal` is deliberately absent: a dialog shown that way matches `:modal` and is
announced as modal already, and the attribute is the version of that claim which can be
wrong.

The element claims one piece of layout — the full-viewport, centred, transparent layer —
in the collection's stylesheet. That is the only place this collection claims layout, and
it is claimed because the alternative is every consumer restating six utilities for a box
they never see.

## Consequences

Top-layer behaviour, inertness and focus return are the browser's, so they are correct in
cases nobody tested, including print, `inert` subtrees and forced-colors mode.

The panel's own box stays the consumer's through `panel-class`, as does every word inside
it.
