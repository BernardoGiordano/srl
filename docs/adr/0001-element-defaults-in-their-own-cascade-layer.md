# ADR-0001: Framework element defaults ship in their own cascade layer

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/elements/element-defaults.js`, `source/lib/core/navigation/router.js`

## Context

The framework defines two marker elements that must vanish from layout: `<x-content>`,
which stands where an element's projected children go, and `<x-route-outlet>`, which
stands where a layout route renders its child. Both need `display: contents`, and both
must lose that the moment an application puts a display or spacing utility on them — a
route outlet almost always sits inside the flex or grid container that positions the
page, so an inline-by-default wrapper between the two silently breaks every layout
utility applied to it.

The obvious implementation is a bare `x-route-outlet { display: contents }` in a
`<style>` element, on the theory that a type selector is (0,0,1) and `.block` is (0,1,0),
so the class wins. The reasoning is sound and the conclusion is wrong: specificity is not
the first tie-breaker, cascade layers are. Tailwind v4 emits every utility inside
`@layer utilities`, and an *unlayered* declaration beats every layered one whatever its
specificity. The bare rule therefore defeats `class="block p-4"` — the element stays
`display: contents`, the padding has no box to apply to, and the page renders flush
against its container with nothing reported anywhere.

## Decision

Framework defaults are declared inside a cascade layer of their own, and that layer is
registered before Tailwind's. Layer order is the order in which layer names are first
seen in document order, so the style element is *prepended* to `<head>` rather than
appended: whatever Tailwind has already injected, or injects later as the browser JIT
build does, is downstream of this layer name and wins.

## Consequences

An application overrides any framework default with an ordinary utility class, which is
the behaviour a Tailwind user expects and would otherwise have to discover the hard way.
The cost is that the defaults cannot be a static stylesheet: they have to be injected at
a controlled position in `<head>`, so the module runs at import time.

This is reopened by a CSS delivery model where the framework no longer controls document
order in `<head>` — a server-rendered shell that inlines Tailwind above everything, for
instance. At that point the layer has to be registered by the page rather than by the
library.
