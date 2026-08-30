# ADR-0082: Chain depth is the gated delivery fact

- Status: accepted
- Date: 2026-08-30
- Affects: `tools/benchmark/chain.mjs`, `tools/benchmark/browser.mjs`, `tools/benchmark/node/startup.mjs`, `tools/benchmark/budgets.json`, `cli/delivery/artifact-report.mjs`

## Context

The benchmark measured everything about delivery except the thing that was wrong with it.

A gated run reported cold start to first routed view as a duration, a request count and a
byte total, and every one of those numbers was green while a deployed application spent
around a second discovering ten kilobytes of JavaScript one round trip at a time. None of
the three can see that. A count is identical whether twenty transfers happen together or
in sequence. A byte total is identical too. And the duration cannot see it either, because
the harness resolves no host: with `--host-resolver-rules` pointing everything but the
loopback at nothing, a request is answered by a local server in well under a millisecond,
so twenty serial hops cost about what one costs. Zero network is what makes the harness
repeatable, and it is also what makes latency the one delivery fact the harness cannot
measure directly.

That leaves depth. How many requests had to wait for another request to arrive first is a
count, not a duration — it does not change with the machine, it does not need the speed
scaling of [ADR-0043](0043-benchmarks-are-normalised-by-reference-workloads.md), and
under zero network it is the only latency fact that survives the measurement. It is also
the number [ADR-0080](0080-the-entry-document-names-the-graph.md) moved and, in its own
words, left unwatched: "nothing yet gates chain depth, so a future change that adds a
serial hop moves no measured number".

Nothing new had to be measured to have it. `Network.requestWillBeSent` already carries an
initiator — the parser, script or preload that asked for the request — and `recordTraffic`
was keeping url, type, status, bytes and cache state and dropping the one field that says
what caused it. On the build side the same shape exists statically: `chunks[].imports` is
computed, validated and written to `artifact.json` on every build, and the depth of that
graph is derivable without starting a browser at all.

The absolute half needed an argument of its own, because `budgets.json` carried
`product: {}` deliberately: a product limit is compared raw, with no speed scaling and no
noise slack, and limits set near one machine's medians red-build on any slower machine —
the busy population here measured 1.46x to 2.63x. That reasoning is about durations. A
depth is machine-independent, so it sits outside the calibration and noise machinery
entirely, and it is the one absolute limit the envelope's own rules already permit.

## Decision

**`tools/benchmark/chain.mjs` derives depth from the causal graph the protocol already
reports.** `recordTraffic` keeps `initiator` — reduced to a kind and the origin-relative
URL that caused the request — and `startedAt`, the request's wall clock on
`performance.timeOrigin`'s scale. `requestChain(records)` walks the initiator edges and
returns the longest root-to-leaf chain, counting the root as 1. Pure, so the rule is
asserted from a literal rather than by loading a page and hoping it is slow in the right
way.

The chain ends at the first routed view: `until(records, settledAt)` drops requests a
mounted view starts for its own data. Without that boundary the depth would depend on how
long the harness happened to keep reading rather than on the application.

`chainDepth` joins the metrics of every load and every navigation workload, in a unit of
its own. `depth` rather than `count` because `minDelta.count` is 20 — the slack that stops
a request total from regressing on noise — and a chain that goes three deep to ten has to
fail. `minDelta.depth` is 1, and no unit but `ms` is scaled by the machine.

**`chain` joins the artifact report,** as `{ depth, path }` derived from `chunks[].imports`
by `entryChain`. Breadth-first, because the question is when a browser *discovers* a chunk
and a chunk reachable in one hop is discovered in one hop however many longer routes also
reach it — and because breadth-first is the only shape that terminates on a circular chunk
graph. Static imports only: a route chunk is a dynamic import and following those would
report the depth of the whole application rather than of its startup, which is the same
line `entryHints` draws.

`parseReport` admits it by re-deriving it. A report whose stated depth disagrees with its
own chunk graph is describing an artifact it does not carry, and every consumer of the
number would inherit the disagreement.

**The absolute limit is on the artifact, not on the browser.** `product` gains one entry:
`delivery/artifact-size.chainDepth`, at the depth the example artifact builds today. That
workload exists only on the dist origin, reads a verified report, starts no browser and is
already declared environment-independent. The source origin is deliberately not gated this
way: it ships no bundler and the browser walks the native module graph, so its depth
describes the source layout — a documented trade, per
[the delivery guide](../guide/delivery.md), not a defect.

The measured `chainDepth` of the browser workloads is gated relatively, against the
baseline, like every other metric.

## Consequences

A change that adds a serial hop now fails, once, at the gate. The build-side limit fails
without a browser at all, which means it fails in the same run that produced the artifact
rather than in the benchmark afterwards.

`facade` chunks become visible as cost rather than as a line in a report nobody reads: a
0.00 KiB chunk that adds a level to the entry's static graph moves `chain.depth`, and a
0.00 KiB chunk that does not is free — which is the distinction the byte totals could
never draw.

Depth is not latency. A three-deep graph on a fast connection and the same graph on a slow
one are the same number here, and the harness is honest about measuring a graph rather than
an experience. The number is a proxy chosen because it is the proxy that holds still: it
changes when the code changes and not when the machine does.

Two limits stay visible. `product` is no longer empty, so the objection it recorded is now
scoped rather than general — durations still have no absolute limits, and still need a
known target machine and a known target application scale. And a depth budget cannot see a
chain that gets *wider*: twelve template requests in one round trip is depth 2, the same as
one, which is exactly why
[ADR-0071](0071-a-built-template-is-fetched-by-the-component-that-needs-it.md)'s follow-up
is a separate decision from this one.

What reopens this: a harness that can afford simulated latency. The moment a round trip
costs something measurable and repeatable, depth stops being a proxy and the duration
becomes the fact to gate.
