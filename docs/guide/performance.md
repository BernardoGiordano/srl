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

Every number below is derived from the checked-in baselines by
`npm run docs:performance`, which fails when a table here disagrees with the file the gate
compares against ([ADR-0099](../adr/0099-a-performance-claim-carries-its-standing.md)). Nothing in this section is typed by hand, including the machine that
produced it and the standing each number has. `npm run benchmark` regenerates the
measurements; `npm run docs:performance:write` regenerates the tables.

These are diagnostic evidence about one machine, not acceptance limits.

### Where the numbers came from

<!-- generated:performance-provenance -->

**Source origin — the application served as it is written.** `tools/benchmark/baseline.json`

| Fact | Value |
|---|---|
| Recorded | 2026-08-31T09:42:58.466Z, `--ci`, app `example` |
| Machine | Apple M3, 8 cores, 16 GiB, Darwin 25.6.0 arm64 |
| Runtime | Node v22.14.0, Chrome/151.0.7922.175 |
| Environment profile | `033631fd807f991b` |
| Runtime dependencies | `lit@3.3.3`, `@preact/signals-core@1.14.4`, `@tailwindcss/browser@4.3.3` |
| Reference readings | 8 readings, arithmetic 23.7 ms and layout 21.0 ms, moved 1.05x / 1.02x during the run |

**Artifact origin — the verified production build.** `benchmark/artifact-baseline.json`

| Fact | Value |
|---|---|
| Recorded | 2026-08-31T09:28:51.523Z, `--ci`, app `example:dist` |
| Machine | Apple M3, 8 cores, 16 GiB, Darwin 25.6.0 arm64 |
| Runtime | Node v22.14.0, Chrome/151.0.7922.175 |
| Environment profile | `0219cbfa4fa0fe40` |
| Runtime dependencies | `lit@3.3.3`, `@preact/signals-core@1.14.4` |
| Reference readings | 8 readings, arithmetic 23.7 ms and layout 20.7 ms, moved 1.00x / 1.02x during the run |

<!-- /generated:performance-provenance -->

### What each workload costs

<!-- generated:performance-envelope -->

**Source origin — the application served as it is written.**

| Workload | Id | Median | p95 | n | Standing |
|---|---|---|---|---|---|
| Cold application start, empty cache, to first routed view | `startup/cold` | 84.6 ms | 85.6 ms | 3 | gated |
| Warm application start, primed cache, to first routed view | `startup/warm` | 67.2 ms | 72.0 ms | 3 | gated |
| Native module requests and encoded bytes for the entry route | `delivery/entry-route` | 84.8 ms | 84.8 ms | 3 | gated |
| Register 100 components, then build 100 instances | `startup/definitions-100` | 2.20 ms | 2.30 ms | 8 | gated |
| Register 1,000 components, then build 100 instances | `startup/definitions-1000` | 7.00 ms | 7.10 ms | 8 | gated |
| Register 5,000 components, then build 100 instances | `startup/definitions-5000` | 23.6 ms | 24.0 ms | 4 | gated |
| Compile a small template (10 bindings) | `template/compile-small` | 0.60 ms | 0.80 ms | 40 | gated |
| Render a small template for the first time | `template/first-render-small` | 0.30 ms | 0.60 ms | 40 | gated |
| Compile a medium template (50 bindings) | `template/compile-medium` | 0.60 ms | 1.80 ms | 40 | gated |
| Render a medium template for the first time | `template/first-render-medium` | 0.90 ms | 1.50 ms | 40 | gated |
| Compile a large template (200 bindings) | `template/compile-large` | 1.70 ms | 2.90 ms | 40 | gated |
| Render a large template for the first time | `template/first-render-large` | 1.30 ms | 2.00 ms | 40 | gated |
| Update one binding among 50 unrelated ones | `template/update-one-of-50` | 0.00 ms | 0.10 ms | 40 | gated |
| Update one binding among 200 unrelated ones | `template/update-one-of-200` | 0.00 ms | 0.00 ms | 40 | gated |
| Keyed *for list: create at 1,000 rows | `template/keyed-create-1000` | 3.50 ms | 4.00 ms | 20 | gated |
| Keyed *for list: update at 1,000 rows | `template/keyed-update-1000` | 0.70 ms | 1.40 ms | 20 | gated |
| Keyed *for list: reverse at 1,000 rows | `template/keyed-reverse-1000` | 1.10 ms | 2.00 ms | 20 | gated |
| Keyed *for list: shrink at 1,000 rows | `template/keyed-shrink-1000` | 0.50 ms | 0.60 ms | 20 | gated |
| Keyed *for list: regrow at 1,000 rows | `template/keyed-regrow-1000` | 2.30 ms | 2.80 ms | 20 | gated |
| Keyed *for list: reverse 10,000 rows | `template/keyed-reverse-10000` | 11.6 ms | 12.9 ms | 4 | gated |
| Configure 10 routes and settle the entry URL | `router/attach-10` | 0.10 ms | 0.20 ms | 20 | gated |
| Configure 100 routes and settle the entry URL | `router/attach-100` | 0.10 ms | 0.20 ms | 20 | gated |
| Configure 1,000 routes and settle the entry URL | `router/attach-1000` | 0.60 ms | 1.10 ms | 8 | gated |
| Navigate to the first route of 100 | `router/navigate-first-100` | 0.00 ms | 0.10 ms | 20 | gated |
| Navigate to the middle route of 100 | `router/navigate-middle-100` | 0.10 ms | 0.20 ms | 20 | gated |
| Navigate to the last route of 100 | `router/navigate-last-100` | 0.10 ms | 0.20 ms | 20 | gated |
| Navigate to the param route of 100 | `router/navigate-param-100` | 0.10 ms | 0.20 ms | 20 | gated |
| Navigate to the wildcard route of 100 | `router/navigate-wildcard-100` | 0.10 ms | 0.20 ms | 20 | gated |
| Navigate to the catch-all route of 100 | `router/navigate-catch-all-100` | 0.10 ms | 0.20 ms | 20 | gated |
| Navigate to the last route of 1,000 | `router/navigate-last-1000` | 0.30 ms | 0.40 ms | 20 | gated |
| Ten navigations between sibling child routes under one layout | `router/sibling-cycle-10` | 1.30 ms | 1.70 ms | 20 | gated |
| Mount a client table of 10,000 rows with 50 visible | `collection/table-mount-10000-50` | 2.80 ms | 3.40 ms | 20 | gated |
| Filter 100 client rows | `collection/table-filter-100` | 0.70 ms | 0.90 ms | 40 | gated |
| Sort 100 client rows | `collection/table-sort-100` | 2.80 ms | 3.90 ms | 40 | gated |
| Filter 1,000 client rows | `collection/table-filter-1000` | 2.40 ms | 3.10 ms | 40 | gated |
| Sort 1,000 client rows | `collection/table-sort-1000` | 4.00 ms | 5.50 ms | 40 | gated |
| Filter 10,000 client rows | `collection/table-filter-10000` | 3.30 ms | 4.90 ms | 20 | gated |
| Sort 10,000 client rows | `collection/table-sort-10000` | 17.5 ms | 21.7 ms | 20 | gated |
| Render 10,000 rows and 40,000 cells at once | `collection/table-full-render-10000` | 468.9 ms | 506.3 ms | 4 | gated |
| Keyed reverse of a fully rendered 10,000-row table | `collection/table-reorder-10000` | 318.9 ms | 344.1 ms | 4 | gated |
| Eight columns, four sticky, 1,000 rows | `collection/table-sticky-realistic` | 6.00 ms | 7.60 ms | 20 | gated |
| Twenty-four columns, twelve sticky, 1,000 rows | `collection/table-sticky-worst-case` | 17.6 ms | 21.6 ms | 20 | gated |
| Type into a combobox holding 100 local options | `collection/combobox-filter-100` | 0.90 ms | 2.60 ms | 20 | gated |
| Type into a combobox holding 1,000 local options | `collection/combobox-filter-1000` | 2.60 ms | 3.40 ms | 20 | gated |
| Fifty route mount and release cycles | `memory/route-cycles` | 2.36 s | 2.37 s | 2 | gated |
| Fifty outlet swaps whose first target loses the race | `memory/outlet-swaps` | 910.0 ms | 934.0 ms | 2 | gated |
| Heap while 10,000 rows are mounted, and after release | `memory/table-10000` | 1.10 s | 1.13 s | 2 | gated |
| Whole-project typecheck | `tooling/typecheck` | 292.8 ms | 305.3 ms | 3 | gated |
| Static template checking for every application | `tooling/template-check` | 2.74 s | 2.75 s | 3 | gated |
| Architecture, integrity and dependency verification | `tooling/verify` | 415.4 ms | 416.7 ms | 3 | gated |
| Type-aware lint | `tooling/lint` | 5.37 s | 5.57 s | 2 | gated |

**Artifact origin — the verified production build.**

| Workload | Id | Median | p95 | n | Standing |
|---|---|---|---|---|---|
| Verified production artifact size | `delivery/artifact-size` | 129 | 129 | 1 | gated |

<!-- /generated:performance-envelope -->

### What else those workloads measured

Requests, bytes, chain depth, startup steps and heap, from the same loads.

<!-- generated:performance-facts -->

| Id | Metric | Median | Standing |
|---|---|---|---|
| `startup/cold` | `firstView` | 84.6 ms | gated |
| `startup/cold` | `rootDefined` | 82.5 ms | gated |
| `startup/cold` | `load` | 68.0 ms | gated |
| `startup/cold` | `requests` | 57 | gated |
| `startup/cold` | `chainDepth` | 7 deep | gated |
| `startup/cold` | `fromCache` | 0 | gated |
| `startup/cold` | `stepConfigure` | 0.60 ms | gated |
| `startup/cold` | `stepManifest` | 3.80 ms | gated |
| `startup/cold` | `stepLocale` | 2.20 ms | gated |
| `startup/cold` | `stepProviders` | 0.10 ms | gated |
| `startup/cold` | `stepReady` | 0.90 ms | gated |
| `startup/cold` | `stepRoot` | 10.1 ms | gated |
| `startup/warm` | `firstView` | 67.2 ms | gated |
| `startup/warm` | `rootDefined` | 66.2 ms | gated |
| `startup/warm` | `load` | 55.9 ms | gated |
| `startup/warm` | `requests` | 57 | gated |
| `startup/warm` | `chainDepth` | 7 deep | gated |
| `startup/warm` | `fromCache` | 3 | gated |
| `startup/warm` | `stepConfigure` | 0.20 ms | gated |
| `startup/warm` | `stepManifest` | 1.00 ms | gated |
| `startup/warm` | `stepLocale` | 3.30 ms | gated |
| `startup/warm` | `stepProviders` | 0.00 ms | gated |
| `startup/warm` | `stepReady` | 0.60 ms | gated |
| `startup/warm` | `stepRoot` | 6.70 ms | gated |
| `delivery/entry-route` | `requests` | 57 | gated |
| `delivery/entry-route` | `chainDepth` | 7 deep | gated |
| `delivery/entry-route` | `moduleRequests` | 46 | gated |
| `delivery/entry-route` | `templateRequests` | 3 | gated |
| `delivery/entry-route` | `encodedBytes` | 771.7 KB | gated |
| `delivery/entry-route` | `moduleBytes` | 697.3 KB | gated |
| `delivery/entry-route` | `templateBytes` | 5.4 KB | gated |
| `delivery/entry-route` | `tailwindBytes` | 275.9 KB | gated |
| `delivery/entry-route` | `appCssBytes` | 16.6 KB | gated |
| `startup/definitions-100` | `define` | 0.70 ms | gated |
| `startup/definitions-100` | `instantiate` | 1.50 ms | gated |
| `startup/definitions-1000` | `define` | 5.20 ms | gated |
| `startup/definitions-1000` | `instantiate` | 1.70 ms | gated |
| `startup/definitions-5000` | `define` | 21.7 ms | gated |
| `startup/definitions-5000` | `instantiate` | 1.70 ms | gated |
| `collection/table-full-render-10000` | `render` | 466.1 ms | gated |
| `collection/table-full-render-10000` | `cells` | 40000 | gated |
| `memory/route-cycles` | `heapGrowthBytes` | 530.4 KB | gated |
| `memory/route-cycles` | `nodeGrowth` | 11 | gated |
| `memory/route-cycles` | `listenerGrowth` | 0 | gated |
| `memory/route-cycles` | `cycles` | 50 | gated |
| `memory/outlet-swaps` | `heapGrowthBytes` | 447.1 KB | gated |
| `memory/outlet-swaps` | `nodeGrowth` | 7 | gated |
| `memory/outlet-swaps` | `listenerGrowth` | 0 | gated |
| `memory/outlet-swaps` | `cycles` | 50 | gated |
| `memory/table-10000` | `mountedHeapBytes` | 131.7 MB | gated |
| `memory/table-10000` | `recoveredHeapBytes` | 1.2 MB | gated |
| `memory/table-10000` | `cells` | 40000 | gated |
| `delivery/artifact-size` | `chainDepth` | 3 deep | limited to 3 deep |
| `delivery/artifact-size` | `rawBytes` | 416.9 KB | gated |
| `delivery/artifact-size` | `gzipBytes` | 150.7 KB | gated |
| `delivery/artifact-size` | `brotliBytes` | 131.2 KB | gated |
| `delivery/artifact-size` | `javascriptRawBytes` | 224.9 KB | gated |
| `delivery/artifact-size` | `javascriptGzipBytes` | 90.5 KB | gated |
| `delivery/artifact-size` | `cssRawBytes` | 46.7 KB | gated |
| `delivery/artifact-size` | `cssGzipBytes` | 9.2 KB | gated |
| `delivery/artifact-size` | `templateRawBytes` | 74.8 KB | gated |
| `delivery/artifact-size` | `templateGzipBytes` | 26.7 KB | gated |

<!-- /generated:performance-facts -->

Two facts these numbers settle. **No route index is needed** at this scale. And **rendering
10,000 rows whole costs 468.9 ms**, which is what the frame budget below now fails, so
`<ui-table>` renders a window of them when a screen asks for one
([ADR-0107](../adr/0107-a-window-bounds-what-a-table-renders.md)). Sticky columns are the
table's sharpest cost curve and the first place to look if a wide table feels slow.

The editor suite's own sample policy, and the first numbers it produced, are in
[ADR-0096](../adr/0096-the-editor-latency-claim-is-a-workload-not-an-assertion.md). A
workload the baseline does not carry is listed as unmeasured below rather than quoted from
there.

## What the numbers do not cover

A gate that passes says nothing about a workload it did not run. Every gap is listed with
its reason, and the runner prints the same list at the end of every run.

<!-- generated:performance-coverage -->

**Source origin — the application served as it is written.**

| Gap | Workloads | Why |
|---|---|---|
| pending | `startup/templates-bundle` | No application configures `manifest.templateBundle` and no templates.json is committed, so there is nothing to compare individual template fetches against. Generating one would write into an application directory, which a measurement must not do. |
| pending | `memory/remote-cycles` | Fifty remote mount/revoke/unmount cycles need a manifest, a remote host provider and an auth session in the harness page. Worth doing against the real example page rather than a synthetic one, which is a page-driven workload this harness can host but does not yet. |
| pending | `collection/typeahead` | The typeahead path is defined by not loading options locally, so its workload is a request-timing measurement against a stubbed source rather than a render measurement. Needs a decision on what the stub is before a number means anything. |
| pending | `delivery/edit-to-reload` | One-file edit to what the developer sees needs cli/dev/serve.mjs running with its update session and a page listening on /__updates. That is a second origin shape, and mixing it into the measured origin would change the cache policy every other workload depends on. There are now two numbers behind the one name: a template edit is a revision rendered into the hosts already showing it, and every other edit is still a reload. |
| unmeasured | `collection/table-window-10000`, `collection/table-window-scroll-10000`, `editor/cold-start-1x`, `editor/cold-start-10x`, `editor/interactive-1x`, `editor/interactive-10x`, `editor/edit-burst`, `editor/cancellation` | declared and absent from tools/benchmark/baseline.json: nothing here proves it |

**Artifact origin — the verified production build.**

| Gap | Workloads | Why |
|---|---|---|
| pending | `memory/remote-cycles` | Fifty remote mount/revoke/unmount cycles need a manifest, a remote host provider and an auth session in the harness page. Worth doing against the real example page rather than a synthetic one, which is a page-driven workload this harness can host but does not yet. |
| pending | `collection/typeahead` | The typeahead path is defined by not loading options locally, so its workload is a request-timing measurement against a stubbed source rather than a render measurement. Needs a decision on what the stub is before a number means anything. |
| pending | `delivery/edit-to-reload` | One-file edit to what the developer sees needs cli/dev/serve.mjs running with its update session and a page listening on /__updates. That is a second origin shape, and mixing it into the measured origin would change the cache policy every other workload depends on. There are now two numbers behind the one name: a template edit is a revision rendered into the hosts already showing it, and every other edit is still a reload. |
| unrecorded | 60 workloads across startup, delivery, template, router, collection, memory, tooling | measured on the artifact origin and deliberately not recorded: dist timings stay evidence rather than gates until their sample policy is settled |

<!-- /generated:performance-coverage -->

## What actually fails

<!-- generated:performance-gating -->

No workflow in `.github/workflows` runs the benchmark gate: every limit below fails only when somebody runs `npm run benchmark:ci` by hand, on a machine whose profile matches the baseline. A green `npm run check` proves nothing about performance.

| Origin | Gated | Absolutely limited | Reported only | Comparable |
|---|---|---|---|---|
| `source` | 103 | 0 | 0 | yes |
| `dist` | 10 | 1 | 0 | yes |

| Absolute limit | Value | Recorded |
|---|---|---|
| `delivery/artifact-size.chainDepth` | 3 deep | 3 deep |
| `editor/edit-burst.validations` | 1 | nothing has measured it |
| `collection/table-window-10000.render` | 16 | nothing has measured it |
| `collection/table-window-scroll-10000.duration` | 16 | nothing has measured it |

<!-- /generated:performance-gating -->

## How to read a benchmark number here

The rules that make comparison meaningful. Ignoring them produces confident nonsense:

- **The gate reads the median, not the p95.** Both are reported; a p95 over a handful of
  samples moves tens of percent between identical runs. The editor target is a p95 —
  100 ms is what a keystroke is judged against — and it is reported over a hundred samples
  rather than gated
  ([ADR-0096](../adr/0096-the-editor-latency-claim-is-a-workload-not-an-assertion.md)).
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
- **One workload pays for a round trip.** Everything else is measured with zero network,
  so no duration here can see a serial chain. `delivery/journey-40ms` opens the built
  artifact under 40 ms of added round-trip time on 5 Mbit/s, waits for the real session
  restore and route guard, and reports one number for reaching a working authenticated
  screen ([ADR-0100](../adr/0100-a-journey-is-measured-under-stated-network-conditions.md)).
  It is emulation, not a network: no loss, no congestion, no TLS, same host — a floor
  rather than an experience.
- **The editor suite measures a fixture, not this checkout.** `editor/*` drives the real
  language server over stdio against temporary copies of the selected application — one
  copy, then ten — because the srl repository is a project no consumer has. Each
  interactive sample carries its answer *and* whether validation was still queued when
  that answer arrived, so an idle server cannot produce a latency figure.
- **Forced collection happens only in the memory workloads**, and the leak check is
  batch-by-batch monotonic growth rather than one before/after pair.
- **Every run prints what it does not cover**, so a green gate cannot be mistaken for full
  coverage. Pending workloads carry their reasons in `tools/benchmark/workloads.mjs`, and
  the generated coverage table above lists them beside the workloads that are declared and
  unmeasured.

## Budgets

Two kinds, in `tools/benchmark/budgets.json`:

| Setting | Value | Meaning |
|---|---|---|
| `regressionThreshold` | 0.10 | A median may not exceed the machine-scaled baseline by more than 10% |
| `suiteThresholds.tooling` | 1.0 | Child-process workloads on a shared machine only catch order-of-magnitude change |
| `product` | absolute limits | Compared raw: no speed scaling, no noise slack. The generated table above lists every entry and what it currently measures |
| `maxSpeedDrift` | where scaling stops being credible | A machine twice as slow is a different machine, and its numbers are incomparable |
| `maxRunSpread` | how far a reference may move inside one run | Above it, the run reports and cannot gate |
| ci ceiling | 420 s | `--ci` takes about 150 s here, 45 s of it the editor suite; the ceiling failing means reconsidering sample counts, not raising it |

A duration limit here has to be a requirement with room in it rather than a fence around a
median. Limits set near this machine's medians would fail on any slower machine and on
every busy moment here — the busy population measured 1.46x to 2.63x — and a gate that
reds for the environment teaches people to ignore it.

`collection/table-window-10000.render` is the first duration limit and is set that way.
16 ms is one frame, which is what a table a user is scrolling has to produce a paint in. A
local run measured 2.60 ms for the windowed render and 1.70 ms per scroll, with 38 of the
10,000 rows in the DOM, so the limit clears the 2.63x spread several times over; what fails
it is the thing it was written for, the same 10,000 rows rendered whole at 468.9 ms.
`collection/table-window-scroll-10000` carries the same frame for the cost paid on every
scroll rather than once at mount. Neither is in `baseline.json` yet, so both are listed
above as declared and unmeasured, and the two figures here are reported rather than gated:
the run that produced them was on Chrome 152 against a baseline recorded on 151
([ADR-0107](../adr/0107-a-window-bounds-what-a-table-renders.md)).

The other two absolute limits are not timings. `delivery/artifact-size.chainDepth` is how many
round trips deep the entry's static chunk graph is, derived by the build from
`chunks[].imports`, admitted by `parseReport` against the graph it came from, and read from
a verified report without starting a browser. A count of hops does not change with the
machine, so it needs neither the speed scaling nor the noise slack that make an absolute
duration unfair here. It applies to the dist origin alone — the source origin ships no
bundler, and its depth describes the source layout rather than a delivery defect. Raising
it is a decision to ship a deeper startup graph, taken deliberately.

`editor/edit-burst.validations` is the same kind of fact one subsystem over: ten edits
written into one debounce window are one check, on any machine. It is limited to 1, and the
relative gate could not hold it — a count's minimum delta is 20, so one check becoming two
is invisible to it.

**Baseline discipline.** A baseline moves only in the commit that moved the number, with
the reason recorded beside it. Do not re-record one as a side effect of an unrelated
change: a baseline that moved without a reason is how a gate stops meaning anything. Note
that `--update-baseline` rewrites the whole file, so a deliberate decision to leave other
metrics untouched has to be applied by hand.

## Explaining one update

A benchmark says a workload got slower. It does not say which component re-rendered or
which binding ran four hundred times, and in this framework those are separate questions
from each other: an element renders when a signal its `render()` read changed or when a
reactive property was written, and a compiled binding patches its own Lit Part when a
signal *its* expression read changed, with no render anywhere
([ADR-0018](../adr/0018-binding-scopes-keep-their-identity.md)). A timer around renders
sees only half of it.

`@core/diagnostics/updates.js` records both, around whatever you want explained:

```js
import { recordUpdates } from '@core/diagnostics/updates.js';
import { formatUpdateReport } from '@core/diagnostics/report.js';

const stop = recordUpdates();
await theInteractionThatFeelsWrong();
console.log(formatUpdateReport(stop()));
```

The report has two summaries and a timeline. The summaries rank every tag and every
binding by the time they spent, breaking ties on how often they ran, which is how a
binding that costs nothing each time and runs four hundred times still reaches the top.
The timeline is where the causes are, and it nests: a binding under an element render is
one the render re-evaluated, and a binding at the top level patched on its own.

```
srl updates — 42.10 ms, 1 tag, 3 bindings

Elements
  updates  total ms  tag
        1      1.84  employees-page

Bindings
  updates  changed  total ms  binding
        1        1      1.02  employees-page.html *for="employee of employees; key: employee.id"
       40        6      0.31  employees-page.html {{ employee.name }}
        2        1      0.02  employees-page.html {{ pendingCount }}

Timeline (ms from start)
      0.00  <employees-page> properties [employees], 1.84 ms
      0.31    employees-page.html *for="employee of employees; key: employee.id" rerender, 1.02 ms, changed
      1.40    employees-page.html {{ employee.name }} rerender, 0.01 ms
     31.40  employees-page.html {{ pendingCount }} signal, 0.02 ms, changed
```

Read the causes literally:

| Cause | On | What it means |
|---|---|---|
| `mount` | both | first render, or a binding's first commit into its Part |
| `signal` | both | the effect behind it re-ran. **Which** signal is not recorded |
| `properties` | elements | a reactive property was written, or `requestUpdate()` was called. The names follow in brackets |
| `reconnect` | both | the element re-entered the DOM, or the directive reconnected |
| `template` | elements | an edit to the element's `.html` file replaced its compiled template ([ADR-0111](../adr/0111-an-edited-template-revises-the-page-rendering-it.md)). Development only |
| `rerender` | bindings | the scope it reads bumped its version: the host rendered, or its `*for` row got a new item |
| `rebind` | bindings | the Part now holds a different expression or scope — an `*if` branch that flipped, or a keyed row that moved |

`cause: 'signal'` deliberately stops at "the effect re-ran". Nothing in the reactive
library reports a dependency by name, and a report that guessed at one would be worth less
than one that admits it cannot
([ADR-0109](../adr/0109-an-update-reports-why-it-happened.md)).

Two limits worth knowing. Only one recording runs at a time, and a second one throws
rather than splitting the tree. And a recording retains 5,000 records by default, after
which the timeline stops growing and `report.dropped` says by how much — the summaries
stay exact either way, so a long recording still counts correctly even where it cannot
show the order.
