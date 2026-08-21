# ADR-0044: A regression must be both relatively and absolutely large, and the gate reads the median

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/benchmark/measure.mjs`, `tools/benchmark/budgets.json`

## Context

A relative threshold alone produces noise instead of signal, and both corrections below
were added after watching two runs of identical code disagree.

Chrome quantises `performance.now()` to 100 µs. A 0.1 ms workload therefore reports 0.1 or
0.2, and a percentage between those is arithmetic on noise; a 1.4 ms compile that measures
1.6 ms is the same story one tick up.

Suites also differ in how repeatable they are. A workload inside one warm page repeats to
within a few percent; a workload that starts a fresh compiler process on a shared machine
does not. One threshold for both either ignores real runtime regressions or fails every
second run on tooling variance.

## Decision

Two kinds of budget. A *regression* budget is relative: median and p95 may not exceed the
baseline by more than the threshold. A *product* budget is absolute, comes from the target
application rather than from a previous run, and applies only to metrics that declare one.

A regression must be over the threshold **and** over a minimum meaningful delta for its
unit. Thresholds are per suite. Everything is still reported — the slack only decides what
can fail a build. The baseline is additionally scaled by the machine's current speed
(ADR-0043).

The gate reads the median, not the p95. Both are reported, because a growing tail is worth
seeing, but a p95 over a handful of samples moves by tens of percent between two runs of
identical code. The median over a stated sample count is the figure a comparison can carry.

## Consequences

Nothing fails on a missing baseline entry. A new workload has no history, and reporting it
as new is more useful than passing it silently or failing a build for having added a
measurement.

A comparison against a baseline from another machine is reported and not failed, for the
same reason the relative gate exists at all.

No product budget is set today, so nothing absolute can fail and the row-windowing
question stays open. The trigger is a known target machine and a known target application
scale.
