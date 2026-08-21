# ADR-0020: Projection takes every authored node, anchors and whitespace included

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/elements/projection.js`

## Context

Content projection is done in light DOM, because shadow DOM would put Tailwind's utility
classes out of reach. So the projected nodes have to be physically moved from the host
into the `<x-content>` marker that renders them, and the question is which nodes travel.

Taking only the elements looks right and is wrong. A `${…}` in the caller's template —
which is what every `*if`, `*for` and `{{ }}` in projected content compiles to — is a
lit `ChildPart`, and a ChildPart is a *range*: a comment node marks where it starts, the
following node marks where it ends, and every update inserts and removes strictly between
the two. Leave those two behind and the range still points at the host while its output
has moved into the marker. The first render is correct and every render after it writes
to the wrong parent — the stale branch survives inside the component and the new one
appears outside it.

Whitespace has the same problem for the same reason: a text node is frequently a part's
end anchor, and a range whose two ends sit in different parents throws on the next insert.

## Decision

Capture removes *every* authored child node in document order — elements, comments and
whitespace — so anchors travel with the content they anchor. Nodes are moved, never
cloned, so identity and event listeners survive.

Non-elements go to the default bucket, because a comment carries no `slot` attribute to
consult. That is also the only answer that can be right: a structural directive *is* the
thing that decides whether a slotted element exists, so it cannot itself be attributed to
that element's slot.

Removal happens up front rather than relying on lit clearing the container on first
render, which would make the whole mechanism order-dependent on lit internals.

## Consequences

Projecting into a *named* slot requires a whole element — a bare `*if` cannot be given a
slot name. That constraint is visible at the call site rather than silent, and
`ui-sidebar-group.js` carries the note explaining it.

Because the host is emptied before the first render, the authored children are in no
document until that render completes, which is the window ADR-0019 exists to close.
