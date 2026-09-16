# Performance envelope and the benchmark gate

```bash
npm run benchmark            # local, detailed
npm run benchmark:ci         # the bounded gate, against tools/benchmark/baseline.json
npm run benchmark -- --suite collection --only table-sort-10000
```

The harness drives Chrome directly against the application's mount layout. It
uses the application's import map, CSP hash, and Trusted Types policy. Direct
DevTools control lets it collect garbage and read heap use. Zero-network runs
block external connections without request interception, which would disable
Chrome's cache and distort warm-start results.

## The envelope

The tables below come from checked-in measurements. `npm run docs:performance`
checks them against the baseline; `npm run docs:performance:write` updates them.
They describe one machine and carry their own standing
([ADR-0099](../adr/0099-a-performance-claim-carries-its-standing.md)).

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

The route scan meets the measured budget at this scale. Rendering 10,000 rows
whole took 468.9 ms, so a screen can ask `<ui-table>` to render a window
([ADR-0107](../adr/0107-a-window-bounds-what-a-table-renders.md)). Sticky
columns remain the table's steepest measured cost.

The editor suite's own sample policy, and the first numbers it produced, are in
[ADR-0096](../adr/0096-the-editor-latency-claim-is-a-workload-not-an-assertion.md). A
workload the baseline does not carry is listed as unmeasured below rather than quoted from
there.

## What the numbers do not cover

The runner lists workloads it has not measured and explains each gap.

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

## Reading a benchmark result

The gate compares medians with a baseline and reports p95 values alongside
them. Each sample also checks an observable result, so fast but incorrect
behavior fails.

The harness measures an arithmetic reference and a layout reference around
each suite. It scales comparable baselines by the reference that matches the
work. If a reference moves too much during a run, the harness reports results
but does not gate or record a new baseline. Re-run after the machine settles.

A regression must clear both a relative threshold and a minimum change in
milliseconds, memory, or counts. The measured minimums keep clock resolution
and shared-machine noise from turning tiny differences into failures.

Most workloads block external network requests and measure local behavior.
`delivery/artifact-size.chainDepth` instead counts serial requests in the
built graph. `delivery/journey-40ms` adds 40 ms round-trip time and a 5 Mbit/s
link to the built artifact, then waits for a usable signed-in screen. This is
controlled emulation, without packet loss, congestion, or TLS.

Editor workloads run the language server against temporary installed
application fixtures. Memory workloads force collection before checking for
growth. The runner prints unmeasured and pending workloads beside the results,
so a passing gate can be read with its actual coverage.

## Budgets

`tools/benchmark/budgets.json` holds two kinds of limits.

| Limit | Purpose |
|---|---|
| Relative regression | A median may exceed a machine-scaled baseline by at most 10%, subject to a minimum meaningful change. |
| Absolute product limit | A requirement that applies without scaling or noise slack. |

The table window's 16 ms render limit represents one frame. A local run
rendered the window in 2.60 ms and scrolled it in 1.70 ms, with 38 of 10,000
rows in the DOM. Rendering all rows took 468.9 ms. The window workloads are
still absent from `baseline.json`, so those local figures are reported
evidence rather than an active gate
([ADR-0107](../adr/0107-a-window-bounds-what-a-table-renders.md)).

`delivery/artifact-size.chainDepth` limits the built entry graph to three
serial requests. `editor/edit-burst.validations` limits ten edits inside one
debounce window to one validation. Both are counts independent of machine
speed.

Change a baseline in the commit that changes the workload, and record why.
`--update-baseline` rewrites the whole file, so review every entry before
keeping the result.

## Explaining one update

A benchmark can show a slower workload. `recordUpdates()` shows which elements
rendered and which compiled bindings patched their DOM parts
([ADR-0014](../adr/0014-compiled-templates-and-scopes-keep-their-identity.md)).

`@core/diagnostics/updates.js` records both, around whatever you want explained:

```js
import { recordUpdates } from '@core/diagnostics/updates.js';
import { formatUpdateReport } from '@core/diagnostics/report.js';

const stop = recordUpdates();
await theInteractionThatFeelsWrong();
console.log(formatUpdateReport(stop()));
```

The report ranks tags and bindings by total time and shows their causes in a
timeline. An indented binding ran during its element's render. A top-level
binding patched on its own.

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

The report uses these causes.

| Cause | On | What it means |
|---|---|---|
| `mount` | both | first render, or a binding's first commit into its Part |
| `signal` | both | the effect behind it re-ran. **Which** signal is not recorded |
| `properties` | elements | a reactive property was written, or `requestUpdate()` was called. The names follow in brackets |
| `reconnect` | both | the element re-entered the DOM, or the directive reconnected |
| `template` | elements | an edit to the element's `.html` file replaced its compiled template ([ADR-0111](../adr/0111-development-edits-update-the-running-page.md)). Development only |
| `definition` | elements | an edit to the element's `.js` file replaced its class body ([ADR-0113](../adr/0113-a-tag-keeps-its-class-and-adopts-an-edited-body.md)). Development only |
| `rerender` | bindings | the scope it reads bumped its version: the host rendered, or its `*for` row got a new item |
| `rebind` | bindings | the Part now holds a different expression or scope — an `*if` branch that flipped, or a keyed row that moved |

`cause: 'signal'` means the effect ran again. The reactive library does not
report which signal changed
([ADR-0109](../adr/0109-an-update-reports-why-it-happened.md)).

Only one recording can run at a time. A recording retains 5,000 timeline
records by default, then counts further events in `report.dropped`. Its
summaries continue to count all updates.
