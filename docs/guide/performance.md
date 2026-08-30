# Performance envelope and the benchmark gate

```bash
npm run benchmark            # local, detailed
npm run benchmark:ci         # the bounded gate, against tools/benchmark/baseline.json
npm run benchmark -- --suite collection --only table-sort-10000
```

The harness drives Chrome over the DevTools protocol from `tools/benchmark/`, serving
the same source over the same mount table the application uses. It is not a test-runner
plugin because `@web/test-runner` owns its own sample loop and page lifecycle and cannot
collect garbage or read a heap. The measured origin generates a harness page carrying the
application's own import map, with the sha256 of that inline map added to `script-src` —
exactly what the production nginx header does — and the production Trusted Types list.
Zero network comes from `--host-resolver-rules` plus a dead `--proxy-server`, not request
interception: interception turns Chrome's cache off, and a warm start measured with no
cache is not a warm start.

## The envelope

Medians from the checked-in baseline: `--ci`, example, macOS 25.6.0 arm64, Apple M3, 8
cores, 16 GiB, Node v22.14.0, Chrome 150. These are diagnostic evidence about one machine,
not acceptance limits.

| Workload | Median |
|---|---:|
| Cold start to first routed view | 88 ms, 51 requests, 40 of them modules |
| Entry chunk graph, as built | 3 round trips deep |
| Warm start | 63 ms |
| Entry-route delivery | 644 KiB encoded, 6 template requests |
| Registering 5,000 custom elements | 24 ms; instantiation does not slow as the registry grows |
| Compile a large template | 2.0 ms |
| Keyed reverse of 10,000 rows (template `*for`) | 11.7 ms |
| Attach 1,000 routes / navigate to the last of them | 0.5 ms / 0.3 ms |
| Table mount, 10,000 rows with 50 visible | 3.0 ms |
| Client filter / sort over 10,000 rows | 3.3 ms / 17.4 ms |
| Full render of 10,000 rows and 40,000 cells | 467 ms |
| Keyed reorder of 10,000 table rows | 341 ms |
| Sticky columns, realistic / worst case | 6.1 ms / 19.0 ms |
| Heap while a 10,000-row table is mounted / after release | 138 MB / 1.3 MB |
| Fifty route cycles, fifty losing outlet races | 0 leaked listeners, 9–13 retained nodes |
| Typecheck / template check / verify / lint | 0.22 s / 3.1 s / 0.43 s / 3.6 s |

Two facts these numbers settle: **no route index is needed** at this scale, and **no row
windowing is justified** — because no timing budget exists to fail (below). Sticky
columns are the table's sharpest cost curve and the first place to look if a wide table
feels slow.

## How to read a benchmark number here

The rules that make comparison meaningful. Ignoring them produces confident nonsense:

- **The gate reads the median, not the p95.** Both are reported; a p95 over a handful of
  samples moves tens of percent between identical runs.
- **Correctness is checked before timing, twice.** Every workload has a cheap observable
  answer verified per sample in the page, and aggregation refuses any workload with a
  failed sample. A workload that returns the wrong DOM fails even when it is fast.
- **Every run measures the machine, twice per suite.** Two fixed reference workloads —
  an arithmetic loop and a layout loop, in `browser/calibration.js` — are read before each
  suite and once at the end, and each suite's baseline is scaled by the reading that
  bracketed it and the reference its work resembles. One reference was not enough: with
  only the arithmetic loop, two back-to-back runs reported 16 and 17 regressions of 45–75%
  across every render and tooling workload while the arithmetic loop called the machine
  unchanged at 1.01x, because the load was in the renderer and the page cache. **Neither
  loop may ever be tuned**: changing one invalidates every baseline.
- **Nothing is measured until the machine settles.** Reference readings are taken and
  discarded until two agree within 10%, up to six attempts.
- **A run whose machine moved reports and does not gate.** If two readings of one
  reference disagree by more than `maxRunSpread`, the run prints every difference, fails
  nothing, and refuses to become a baseline — a spike baked into a baseline reads as an
  improvement in every run after it. On an interactive desktop a meaningful fraction of
  runs will decline to gate; the answer is to re-run, not to widen the limit.
- **Two noise controls, both measured into existence.** A per-unit minimum delta
  (1 ms, 2 MiB, 20 counts), because Chrome quantises `performance.now()` to 100 µs; and a
  per-suite threshold, because tooling processes on a shared machine do not repeat to 20%.
- **Depth is the delivery fact, not the duration.** Zero network means no request pays a
  real round trip, so a serial chain and a flat one of the same size report the same
  milliseconds, the same count and the same bytes. `chainDepth` — how many requests had to
  wait for another request to arrive first — is derived from the initiator each request
  already carries, and it is the number that moves when a transfer stops being discovered
  and starts being announced ([ADR-0082](../adr/0082-chain-depth-is-the-gated-delivery-fact.md)).
  Its minimum delta is 1: unlike a request total, it does not move on noise.
- **Forced collection happens only in the memory workloads**, and the leak check is
  batch-by-batch monotonic growth rather than one before/after pair.
- **Every run prints what it does not cover**, so a green gate cannot be mistaken for full
  coverage. Four workloads are pending with their reasons in `tools/benchmark/workloads.mjs`:
  the template bundle (no application configures one, and a built artifact ships none by
  default), remote mount/revoke cycles,
  the typeahead path, and edit-to-reload.

## Budgets

Two kinds, in `tools/benchmark/budgets.json`:

| Setting | Value | Meaning |
|---|---|---|
| `regressionThreshold` | 0.10 | A median may not exceed the machine-scaled baseline by more than 10% |
| `suiteThresholds.tooling` | 1.0 | Child-process workloads on a shared machine only catch order-of-magnitude change |
| `product` | one entry | `delivery/artifact-size.chainDepth` at 3. A product limit is compared raw: no speed scaling, no noise slack |
| `maxSpeedDrift` | where scaling stops being credible | A machine twice as slow is a different machine, and its numbers are incomparable |
| `maxRunSpread` | how far a reference may move inside one run | Above it, the run reports and cannot gate |
| ci ceiling | 420 s | `--ci` takes about 105 s here; the ceiling failing means reconsidering sample counts, not raising it |

`product` carries no timing on purpose, and that is a decision rather than a deferral.
Absolute limits set near this machine's medians would fail on any slower machine and on
every busy moment here — the busy population measured 1.46x to 2.63x — and a gate that
reds for the environment teaches people to ignore it. An absolute *duration* needs a known
target machine and a known target application scale. Neither is fixed, so the relative gate
carries that work, and the consequence stays visible: with no required timing budget, the
row-windowing question is unasked rather than answered.

The one absolute limit is not a timing. `delivery/artifact-size.chainDepth` is how many
round trips deep the entry's static chunk graph is, derived by the build from
`chunks[].imports`, admitted by `parseReport` against the graph it came from, and read from
a verified report without starting a browser. A count of hops does not change with the
machine, so it needs neither the speed scaling nor the noise slack that make an absolute
duration unfair here. It applies to the dist origin alone — the source origin ships no
bundler, and its depth describes the source layout rather than a delivery defect. Raising
it is a decision to ship a deeper startup graph, taken deliberately.

**Baseline discipline.** A baseline moves only in the commit that moved the number, with
the reason recorded beside it. Do not re-record one as a side effect of an unrelated
change: a baseline that moved without a reason is how a gate stops meaning anything. Note
that `--update-baseline` rewrites the whole file, so a deliberate decision to leave other
metrics untouched has to be applied by hand.
