# ADR-0018: A binding scope keeps its identity for the life of its host or row

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/template/template.js`

## Context

Every compiled binding owns a signal dependency set and a Lit update path, so a signal
changing in one interpolation updates that one Part rather than re-rendering the whole
template. Three things must make a binding re-evaluate: a signal it reads changed, the
host rendered and an ordinary Lit property may have changed with it, or its `*for` row was
given a different item or index.

Everything else must cost nothing, and the first implementation did not manage that. It
rebuilt the scope object on each host render, which made every binding's directive see a
new scope, tear down its effect and build another. For a thousand-row table with eight
bindings a row that is around eight thousand effect teardown/rebuild pairs on every
property write.

## Decision

The scope object keeps its identity for the life of its host, or of its `*for` row, and
carries a `version` counter instead. The binding directive short-circuits on scope
identity and re-evaluates on a version change, so a host render costs one comparison per
binding rather than one effect rebuild.

Case 2 above still rebuilds the effect deliberately: Lit properties are not signals, so
the binding is evaluated again inside a fresh effect. A template that branches reads
different signals in each branch, and a dependency set captured once would go stale when
the branch flipped.

## Consequences

The per-binding reactivity is affordable at table scale, which is what makes fine-grained
updates the default rather than an optimisation a screen opts into.

The invariant to preserve is scope identity. Any change that reconstructs the scope per
render restores the old cost silently — nothing breaks, the table just gets slow — which
is why the benchmark suite measures a property write on a large table rather than only
first render.
