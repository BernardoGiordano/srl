# ADR-0014: A compiled template is cached per URL and its strings array is never rebuilt

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/template/template.js`

## Context

A component is a `.js` and a sibling `.html`, and the markup is compiled at runtime
rather than by a build step. The obvious worry about that arrangement is that it must be
slow, and the obvious implementation makes it slow.

lit-html caches a parsed template against the *identity* of the `TemplateStringsArray` it
was tagged with. An array carrying a `raw` property behaves exactly like one from a
literal, so a synthesised array works — but a *different* array with byte-identical
contents is a different template as far as lit is concerned, and lit builds fresh elements
instead of patching the existing ones. A compiler that re-derives the array per render is
therefore correct and rebuilds the whole subtree every time.

## Decision

Each `.html` file is fetched once, walked once, and emitted as exactly one strings array
plus one compiled evaluator per binding. The compiled result is cached per URL and must
never be rebuilt. Every later render hands lit the same array, and lit patches the DOM it
already made.

## Consequences

Runtime compilation costs one request and one walk per template for the life of the page,
and nothing per render — which is what makes the buildless position defensible rather
than merely stated. `seedTemplates` removes the request too, when a bundle is configured.

The invariant is fragile in one specific way: any future change that recreates the strings
array — a cache keyed by something other than the URL, a copy made for immutability, a
per-instance compile — silently converts every render into a rebuild, with no error and no
visible defect beyond a performance regression. That is why the benchmark suite measures
re-render rather than only first render.
