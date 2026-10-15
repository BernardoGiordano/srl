# ADR-0141: Every component bounds its own markers

- Status: accepted
- Date: 2026-10-15
- Affects: `source/lib/core/elements/projection.js`

## Context

`projectContent` fills a host's `<x-content>` markers and skips a marker whose nearest
`[data-projects-content]` ancestor is another element. `captureContent` set that
attribute only on a host that had an element or comment child. A component with no
children of its own drew its markers unmarked, and the nearest projecting ancestor
took them for its own.

That ancestor filled the empty marker on its next render. When its content held the
component, `append` threw `HierarchyRequestError`. The nodes had already left the
ancestor's marker for a detached fragment, so the ancestor's content vanished. A
badge that draws an unconditional `<x-content>` did this inside a card as soon as the
card re-rendered.

Three alternatives lost.

- **Stop at the nearest custom element.** A host's template may put its marker inside
  a plain custom element, such as a third-party element that slots its light DOM. That
  marker belongs to the host.
- **Keep ownership off the DOM, in a set `captureContent` fills.** Two copies of the
  library on one page would each keep their own set. An application's test also reads
  the attribute with the same `closest` rule to find a host's own markers.
- **Mark only a host whose template draws a marker.** The runtime compiler does not
  record it and a JavaScript `render()` cannot declare it. A marker behind `*if` can
  appear on any render, so the check would query the subtree on every update of every
  component.

## Decision

`captureContent` marks every host it runs on, with or without children. Every
`SignalElement` runs it on first connect, so every component bounds the markers its
own template draws. A marker belongs to its nearest marked ancestor, as before.

A childless host's buckets are empty. It fills nothing, renders asynchronously and
holds no nodes.

## Consequences

- Every component carries `data-projects-content`, including one that draws no marker.
  The name is older than this rule, and applications read it.
- A component that never receives content keeps its markers empty, which is what its
  template says.
- Each component pays one attribute write on first connect.
- A marker that a host passes to a nested component as authored content belongs to
  that component, so the host's content does not pass through. That was already true.
  Reopen if a component needs to re-project its content, which needs ownership by
  template rather than by nearest host.
