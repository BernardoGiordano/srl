# ADR-0096: The editor latency claim is a workload, not an assertion

- Status: accepted
- Date: 2026-09-08
- Affects: `tools/benchmark/node/editor.mjs`, `tools/benchmark/budgets.json`, `cli/test/support/language-server-client.mjs`, `cli/test/live-analysis.test.mjs`

## Context

ADR-0090 ended with a measurement it could not make. The
responsiveness it exists for was one assertion inside a correctness test: a single
completion, sent behind two queued validations, asserted to answer in under 1000 ms. That
is a hundred times the latency an editor needs and one sample wide, so it could not tell a
1 ms answer from a 900 ms one, and it was the only place the claim was written down.

Two test files also implemented `Content-Length` framing, id correlation and the
diagnostics stream separately, and a third copy was about to be written for the harness
that measures them.

ADR-0044's gate reads the median of a stated sample count, and its own prose said "median
and p95" while the code compared medians only. The editor target is a p95 — 100 ms is the
figure a keystroke is judged against, not a typical case — so the two had to be reconciled
before an editor number could be gated at all.

Rejected: an absolute p95 duration limit for interactive requests. budgets.json refuses
absolute durations without a known target machine and a known target application scale,
because a limit set near this machine's numbers reds on any slower one, and a gate that
fails for the environment gets ignored. Nothing about the editor changes that.

## Decision

Editor latency is a benchmark suite, driven over the real protocol.
`tools/benchmark/node/editor.mjs` owns the fixture repositories, the cold and warm session
states, the sample loops and the correctness each sample has to satisfy. The suites keep
the ordering facts — a completion is answered before the validation it queued, a withdrawn
request gets `-32800` — and the timings are the harness's.

The fixtures are copies of the selected application in a temporary root: `1x` is one
application, `10x` is ten. Measuring the srl checkout would measure a project no consumer
has, and generating one inside an application directory is a measurement writing into what
it measures.

An interactive sample carries its answer and whether validation was still queued when that
answer arrived. Both are checked before the timing counts: a completion that returned
nothing, or one answered by an idle server, is a failed workload rather than a fast number.
The interactive workloads take a hundred samples in the ci profile, which is what makes
their p95 readable.

Timings are reported and gated relatively, under ADR-0044's rules unchanged: the median
against a scaled baseline, the p95 beside it. No editor duration carries an absolute limit.

The absolute editor budget is a count. `editor/edit-burst.validations` is limited to 1:
ten edits written into one debounce window are one check, on any machine, and the relative
gate cannot see the regression because a count's minimum meaningful delta is 20.

One stdio client, `cli/test/support/language-server-client.mjs`, is shared by the suites
and the harness. It exposes framed writes rather than hiding them, because atomicity is
part of what a caller tests.

## Consequences

The editor suite costs about 45 s of the ci profile, most of it the two cold-start
workloads starting a compiler per sample. That is inside the ceiling and it is the cost of
gating a cold start at all.

The numbers it first reported, on an Apple M3: a cold session reaches its first diagnostics
in 2.3 s over one application and 4.0 s over ten, of which 0.7 s and 1.3 s are
`initialize`. A cold host-expression completion is 9 ms, which answers the question
ADR-0090 left open — the surviving main-thread program build is not what a completion waits
for. Warm interactive requests are 0.7–1.2 ms median and 4.3–5.3 ms p95 against a 100 ms
target, and project scale moves them by nothing measurable.

`validations` being gated means a change to the debounce, to supersession, or to how a
burst of edits is coalesced now fails the benchmark rather than only the suites. That is
intended: it is the one editor fact that is a property of the code and not of the machine.

This reopens if an interactive p95 approaches its target, at which point an absolute limit
becomes worth arguing about on a named machine; or if the fixture's tsconfig drifts from
what an application actually ships, which would make the cold numbers describe a project
nobody has.
