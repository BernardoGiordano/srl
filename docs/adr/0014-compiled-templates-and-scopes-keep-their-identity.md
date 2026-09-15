# ADR-0014: Compiled templates and binding scopes keep their identity

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/template/template.js`

## Context

Templates compile in the browser. That is only fast if lit can patch the DOM it already built.

lit caches a parsed template by the identity of its `TemplateStringsArray`. A new array with the same contents counts as a new template, and lit rebuilds the subtree instead of patching it.

Each binding also owns an effect. If the scope object a binding reads is rebuilt on every host render, every binding tears down its effect and builds a new one. A 1,000-row table with eight bindings per row pays about 8,000 rebuilds per property write.

## Decision

Each `.html` file is fetched once, walked once and compiled to one strings array plus one evaluator per binding. The result is cached per URL and never rebuilt. Fetching and compiling use separate caches, so `prefetchTemplates` can start transfers early while compiling waits for a component that mounts.

A binding scope keeps its identity for the life of its host or `*for` row and carries a `version` counter. A binding skips work when both the scope and the version are unchanged. A host render still re-evaluates bindings inside a fresh effect, because lit properties aren't signals and a branch can change which signals a binding reads.

## Consequences

- Runtime compilation costs one request and one walk per template for the life of the page, and nothing per render.
- Fine-grained updates are affordable at table scale.
- Both rules break silently. A copied array or a per-render scope causes no error, only a slowdown, which is why the benchmark measures re-renders and property writes on a large table.
- A development template edit is the one sanctioned rebuild (ADR-0111).
