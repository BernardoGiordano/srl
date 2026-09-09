# ADR-0099: A performance claim carries its standing

- Status: accepted
- Date: 2026-09-09
- Affects: `tools/benchmark/evidence.mjs`, `tools/benchmark/run.mjs`, `tools/benchmark/report.mjs`, `tools/checks/performance-check.mjs`, `docs/guide/performance.md`

## Context

The harness could tell whether a run failed. Nothing could tell what its numbers proved.

Those are different questions, and only the second one leaves the repository. A median
reaches a reader through the performance guide, and the guide restated the baseline by
hand: a table of twenty rows typed from a run somebody did once. It said 88 ms, 51
requests and Chrome 150 while `tools/benchmark/baseline.json` said 84.6 ms, 57 requests
and Chrome 151. Neither number was wrong when it was written. The typing is what made one
of them survive the run it came from.

The same assembly happened three times over, and drifted three ways. `run.mjs` printed a
report. The guide restated a subset of it. A reader who wanted to know what was actually
held reconstructed it from a baseline file, `budgets.json`, the `PENDING` list and two
paragraphs of prose — and the reconstruction is the part nobody does, so "the benchmark is
green" became the whole claim.

Green is a weak claim here, and the harness already knew why without saying so in one
place:

- A run on a machine whose environment profile does not match the baseline reports every
  comparison as `incomparable` and fails nothing ([ADR-0044](0044-a-regression-must-be-relatively-and-absolutely-large.md)).
  Its medians are still printed, and a printed median is what gets quoted.
- `product` carries exactly two absolute limits and no timing, deliberately
  ([ADR-0082](0082-chain-depth-is-the-gated-delivery-fact.md)). Every other number is
  relative to a file one person recorded on one laptop.
- Six editor workloads are declared and absent from that baseline, because the suite is
  newer than the recording ([ADR-0096](0096-the-editor-latency-claim-is-a-workload-not-an-assertion.md)).
  Four more are declared as pending with reasons.
- The artifact baseline carries one workload on purpose: dist timings stay evidence rather
  than gates until their sample policy is settled. Read from the file alone, that is
  indistinguishable from fifty-seven missing measurements.
- No workflow in `.github/workflows` runs the gate. CI runs `npm run check`, which is the
  documented contract, and the benchmark is not in it. So every relative limit above is
  enforced by somebody remembering, on a machine that matches.

None of that is secret and none of it was assembled. A number that is quoted has to carry
the conditions that make it worth quoting, or the conditions stop travelling with it.

## Decision

**`tools/benchmark/evidence.mjs` turns a measured set into claims, and a claim carries a
standing.** `limited` when an absolute product budget holds it — compared raw, on any
machine. `gated` when a later run on the same environment profile fails if it regresses.
`reported` when nothing fails if it moves. The standing is a field rather than a footnote:
a caller that wants to print "gated" has to read a value that says so, and an incomparable
run demotes every claim it did not hold absolutely.

`measure.mjs` keeps deciding whether a comparison failed. This decides what a number may
be quoted as, which is the question that leaves the repository.

**Provenance and coverage travel with the claims.** One call returns the machine, the
browser, the dependency versions and how far the reference readings moved, together with
what the set does not cover: pending workloads, workloads declared and unmeasured, ones the
bounded profile never runs, ones a baseline was never meant to carry, and numbers no
declared workload produces any more. Each gap states its own reason. A green run of half
the workloads is not evidence about the other half, and the gaps are the half.

**The origins are adapters.** Source and dist are two `BaselineFile`s read from two paths.
The runner builds one from the run it just finished; the documentation check reads both
from disk. Neither knows anything the module does not, which is what makes the report and
the guide answer identically.

**The guide is generated.** `tools/checks/performance-check.mjs` owns five blocks in
`docs/guide/performance.md` between `<!-- generated:performance-* -->` markers, on the
marker grammar the project index already used
([ADR-0072](0072-a-check-returns-diagnostics.md) for the diagnostics, `tools/checks/generated.mjs`
for the mechanics). Prose stays hand-written. Every number, the machine that produced it,
every gap and every limit is derived, and `npm run docs:performance` fails when the page
disagrees with the baselines. It runs inside `npm run check`.

**Whether anything automated runs the gate is read from the workflows.** The guide states
it in the generated block, so the sentence changes when a workflow does rather than when
somebody remembers to edit a paragraph.

## Consequences

A number in the guide cannot outlive its run. Re-recording a baseline and forgetting the
page is a failing check, and the failure names the command that fixes it.

The published tables got longer and less flattering, which is the point. Every declared
workload appears with its median, its p95, its sample count and what holds it; six editor
workloads appear as unmeasured; and the guide now says in its own generated text that a
green `npm run check` proves nothing about performance.

Two limits remain, and neither is hidden any more. The relative gate still depends on one
machine's baseline, so "gated" means "a matching machine would fail", not "a machine will".
And the harness still resolves no host, so the delivery facts stay depth and bytes rather
than latency — the reopening trigger in
[ADR-0082](0082-chain-depth-is-the-gated-delivery-fact.md) is unchanged by this record.
What changed is that a reader is told, rather than expected to derive it.

What reopens this: a workflow that runs the gate on a known machine. The moment a relative
limit is enforced by something other than a person, `automated` flips, the sentence the
guide generates changes with it, and "gated" starts meaning what a reader assumes it means.
