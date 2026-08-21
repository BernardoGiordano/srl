# ADR-0043: Benchmarks are normalised by two fixed reference workloads

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/benchmark/browser/calibration.js`, `tools/benchmark/measure.mjs`

## Context

Every figure in a regression budget compares two runs, and on a developer machine those
two runs do not get the same computer. Measured here, three minutes apart with the
repository unchanged: every workload in every suite reported 35–60% slower than the
baseline recorded just before it, because the laptop had warmed up running the first one.
A gate that fails on that is a gate that gets switched off within a week.

One reference workload is not enough, and that was measured too. With only an arithmetic
loop, two back-to-back `--ci` runs on one machine disagreed by 45–75% on every render
workload — table render, sticky columns, route cycles — while the arithmetic loop reported
the machine unchanged at 1.01x. The cause was an interactive desktop: a compositor at 40%
of a core, a second browser, an editor. That load costs a page building and laying out DOM
enormously and costs a register-only loop nothing.

## Decision

Each run measures fixed work that no change to this repository can affect, and comparisons
are scaled by how much faster or slower that work got. A reference can only normalise work
of its own kind, so there are two:

- **`reference`** — integer and float arithmetic, no allocation, no DOM. The CPU clock and
  nothing else.
- **`layoutReference`** — build a few thousand styled elements and force one layout. The
  renderer's throughput: allocation, style, layout, and whatever else is competing for the
  machine.

Both are reported in every result file, both are re-measured at the end of a run, and the
comparison picks the one matching the suite's kind of work. The scale factor is per suite,
taken from the reading at that suite's start; a single scalar for the whole run is the
fallback, and it is only right when the machine held still throughout.

Neither loop may ever be tuned. Changing one invalidates every baseline ever recorded,
because a scale factor is only meaningful against identical work.

## Consequences

A uniformly slower machine reports no regression, and a workload that got slower *relative
to the machine* still does.

The known limits are stated rather than papered over. Neither reference is a proxy for
disk or network, so a run made slow by a busy disk is not normalised. Neither is a proxy
for a child process either — `tsc` and `eslint` start a process, read hundreds of files
and are subject to page-cache state no page-side loop can observe — which is why the
tooling suite carries a much wider threshold instead (ADR-0044).
