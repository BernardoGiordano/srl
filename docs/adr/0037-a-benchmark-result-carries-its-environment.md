# ADR-0037: A benchmark result carries the environment that produced it

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/benchmark/`

## Context

The measurements that started this work were one headless-Chrome run on one laptop. The
figures were real — around 398,000 DOM nodes for a full 10,000-row render, 170 MB of heap
while it was mounted and 4 MB once it was released — and none of them can be used as an
acceptance budget, because nothing recorded what produced them.

A number without its environment is an anecdote. Two of them compared against each other
are worse than an anecdote, because the comparison looks like evidence.

## Decision

Every result file carries a full description of the machine, plus a one-line `profile`
that comparisons key on. `profile` deliberately includes the runtime dependency versions
and not only the hardware: a faster median after a Lit upgrade is a different fact from a
faster median after an optimisation, and a comparison that cannot tell them apart will
eventually be used to justify the wrong conclusion.

Benchmarks address the collection's public interface rather than its internals, so a
change behind a projection or a visible-row window does not require rewriting the
benchmark alongside it — which is how a before/after comparison stops being a comparison.

## Consequences

Results are comparable only within a profile, and the gate is relative rather than
absolute. Absolute limits belong to a known target machine and a known target application
scale, and neither is fixed yet.

One consequence stays deliberately visible: with no product budget, nothing absolute can
fail, so the row-windowing question stays unasked rather than answered. Windowing
justified by a budget invented to justify it is the wrong way round. The trigger for
setting one is a known target machine and a known target application scale.
