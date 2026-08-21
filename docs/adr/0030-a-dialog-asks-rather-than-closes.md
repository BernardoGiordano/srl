# ADR-0030: Escape and a backdrop click ask to close, they do not close

- Status: accepted
- Date: 2026-08-12
- Affects: `source/components/overlays/ui-dialog.js`

## Context

A native `<dialog>` closes itself on Escape. For a dialog whose `open` state is bound to
an application signal, that means the element and the screen disagree about whether the
dialog is open, and the screen — which is the one that knows whether closing is allowed —
finds out afterwards.

The case that forces the issue is a question the application must have an answer to.
Leaving a half-filled form is the example here: there is no safe default, so picking one
on Escape is picking wrong half the time.

## Decision

Escape and a backdrop click ask rather than close. `cancel` is always prevented; the
element lowers its own `open` and emits `close`, and the consumer decides what that means.

A screen that binds `[.open]` to state of its own therefore stays the single source of
truth, and nothing closes behind its back. A screen that binds nothing gets the ordinary
behaviour for free, because `open` was already lowered before the event fired.

`mandatory` goes further and refuses even to ask: Escape and the backdrop do nothing, and
the only ways out are the buttons the consumer projected. It is off by default, because a
dialog that cannot be dismissed is the exception and WAI-ARIA asks for Escape everywhere
else.

## Consequences

The discard prompt on a dirty form is expressible without the element and the screen
racing over one boolean.

The cost is that a consumer who binds `[.open]` and ignores `close` gets a dialog that
reopens on the next render. That is the intended failure: it is visible immediately, and
the alternative failure — a form abandoned because Escape was pressed — is not.
