# ADR-0078: An open panel is one module, not four habits

- Status: accepted
- Date: 2026-08-27
- Affects: `source/components/internal/open-panel.js`, `source/components/inputs/ui-combobox.js`, `source/components/data/ui-table.js`, `source/components/shell/ui-menu.js`

## Context

`internal/anchored-panel.js` owned one thing: where a floating panel goes. It is the
deepest module in the collection — promote to the top layer, place under the anchor, flip
above when the room is there, clamp into the viewport, re-measure whenever anything moves —
behind a two-argument call. It also had no test file, so flip-above, the clamp, the
right-to-left flush and the scroll re-measure were a comment and a hope.

Positioning is also the part an open panel shares least. `ui-menu` places its own with two
utility classes and wants none of it, for the reason [ADR-0029](0029-the-modal-is-a-native-dialog.md)
gives about not reimplementing what the platform owns: a component that took a `placement`
property would owe you a collision detector.

Everything an open panel *does* share was restated per element instead. Outside-pointerdown
dismissal in three components, Escape in three, and eighteen near-identical lines of
release bookkeeping in two — two fields each, one holding the teardown and one holding the
panel it belonged to, so a re-render that changed neither did not tear the panel down and
put it back. The `aria-expanded` and `aria-controls` pair was spelled three ways in three
templates.

Four habits for one concept is how they disagree, and these had:

- `ui-table`'s chooser trigger claimed `aria-expanded` and named nothing. Its panel had no
  id, so nothing could name it.
- `ui-combobox` bound `aria-controls` to an id whose element only exists while the panel is
  open, so a closed combobox pointed at nothing.
- `ui-table` closed on Escape from anywhere in the document whether or not the chooser was
  open — which also closes it out from under a `ui-dialog` that should have taken the key —
  and left focus wherever it was. `ui-menu` returned focus to the trigger; nothing else did.
- `ui-menu` and `ui-combobox` asked `this.contains(target)`, `ui-table` asked
  `composedPath()`, and only the third is right about a shadow root in the panel.

A `<ui-panel>` element was rejected. The panel is rendered by the component that owns it,
with that component's classes and that component's content, and wrapping it in an element
would put a second custom element between a combobox and its own listbox — which is a
change to the accessibility tree to solve a code-sharing problem. A mixin on
`SignalElement` was rejected for the same reason it is usually rejected here: it would make
every element in the collection pay for a base class three of them use, and the state it
carries is exactly the two fields this record deletes.

## Decision

The module is `internal/open-panel.js`, and its subject is an open panel rather than a
placed one.

`openPanel(host, trigger, panel, options)` opens one and returns the single call that
undoes all of it. It places the panel, mints the panel's id, writes `aria-expanded` and
`aria-controls` on the trigger, dismisses on a pointer down outside `host`, and dismisses
on Escape after returning focus to the trigger. The release closes the popover, sets
`aria-expanded` back to `false` and removes `aria-controls`; it is idempotent, because two
callers ask for it.

Three parameters rather than one, because the three roles are three elements often enough
to matter. `host` is what counts as inside — the table's chooser lives in a toolbar strip
inside a table that fills the screen, and a pointer on a row has to close it. `trigger` owns
the panel in the accessibility tree and takes focus back. `anchor` defaults to the trigger,
takes an element when they differ — a combobox announces its panel from the `role="combobox"`
input but must be as wide as the whole control around it — and takes `null` when the
consumer positions its own. Positioning is the part you can decline; the rest is not
optional, because the elements that declined it are the ones that got it wrong.

`panelBinding(options)` is the component-side call, driven from `updated()` by the flag
that renders the panel. It takes selectors rather than elements, because the panel does not
exist until the render that opens it and is a different element the next time, and that is
the whole reason for the two fields it replaces. Given `lifetime: () => this.lifetime`, it
closes with the element and `onDestroy` has nothing to write — the same shape
[ADR-0076](0076-an-asynchronous-read-is-a-resource.md) settled for `resource()`, and read
at each open rather than captured once because a `SignalElement` mints a new lifetime every
time it re-enters the DOM.

The closed state of `aria-expanded` moves from a template binding to a literal
`aria-expanded="false"` in the markup. It is the state a trigger is in before anything runs,
and the module writes both transitions from there.

`ui-dialog` stays out. A native `<dialog>` shown with `showModal()` already owns the top
layer, the inert page, the focus trap and the focus return, and reaching into any of that
from here is the fight ADR-0029 exists to avoid. `ui-app-shell`'s drawer stays out too: it
is a full-width overlay with a backdrop, positioned by the consumer and dismissed by a click
on the backdrop element rather than by a pointer landing outside a region.
`ui-sidebar-group` stays out because it is an accordion — it expands in the flow, on
purpose, and has nothing to dismiss.

## Consequences

`ui-table` announces its column chooser and returns focus on Escape, and stops answering an
Escape it has no panel open for. `ui-combobox` stops pointing `aria-controls` at an id with
no element behind it. Both are behaviour changes, both are what the other two elements were
already doing, and neither was a decision anybody made.

The module has a suite: fifteen tests over the geometry that had none — the flip, the
clamp, `end` as a logical edge in both directions, the re-measure — plus dismissal, the ARIA
pair, release, and the binding's open-once and close-with-the-element behaviour. Writing it
found one defect. `max-height` caps the content box, while every other number in the
placement is a border-box number, so a padded panel flipped above its anchor overhung it by
its own padding and border. It never showed here because Tailwind's reset sets
`box-sizing: border-box` on everything this collection renders; the module now sets it
itself, so its arithmetic does not depend on the consumer having a reset.

An adopter's own panel gets the same call. `openPanel` is the interface, and a component
outside this collection that renders a dropdown no longer has to rediscover which four
things an open panel owes.

What reopens this: a panel that needs to nest. Escape currently reaches every open panel's
handler at once, and the two that can nest today — a `ui-date-range` inside a combobox
panel — get by because the inner editor stops the event, which is a rule written in the
inner element rather than in this module. A third level, or two panels open side by side
with a genuine order between them, is the case where this module needs a stack rather than
a set of independent listeners.
