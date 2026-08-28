# ADR-0080: The entry document names the graph

- Status: accepted
- Date: 2026-08-28
- Affects: `cli/delivery/entry-hints.mjs`, `cli/delivery/build.mjs`, `cli/test/entry-hints.test.mjs`

## Context

A cold start of a built application discovered its own dependency graph one round trip
at a time.

The measured chain on a deployed artifact: the document arrives, the browser fetches
`assets/entry-*.js`, evaluates it, and only then does startup step 2 learn that it wants
`app.manifest.json`. That lands, step 4 asks for a locale bundle, step 6 restores a
session, and step 7 finally issues the dynamic import of the root module — whose own
static imports are themselves discovered on arrival. Six to eight of the round trips
before the first routed view exist for no reason other than that nobody had told the
browser what was coming. In one case the hop bought nothing at all: `assets/entry-*.js`
was a facade chunk of 0.00 KiB, a whole round trip for no bytes.

Every fact needed to remove those hops was already computed, validated and written to
disk. `chunkRelationships` reduces the engine's output graph to `chunks[].imports`,
`chunks[].dynamicImports`, `facade` and `modules`, and `writeReport` puts them in
`artifact.json`, which is the value [ADR-0074](0074-the-artifact-report-is-a-named-shape.md)
exists to make readable. Nothing read them back. The graph was produced, proved and
ignored.

The reason is an ordering one. The production document is made by `productionHtml`, a
`transformIndexHtml` registered with `order: 'pre'`. That phase runs before Rolldown has
emitted a chunk, so the transform structurally cannot name one: it is subtractive — it
removes the Tailwind browser JIT, the source-delivery stylesheets and the development
import map, per [ADR-0041](0041-production-html-is-a-transform-not-an-edit.md) — and the
only tag it adds is a favicon. By the time the graph exists, the document is finished.

Meanwhile `modulePreload: false` was set at two places in the Vite configuration with no
record behind it, and no ADR mentioned preloading at all. The engine's preload helper was
still emitted into the bundle and still ran: every one of its call sites passed an empty
dependency list, `__vitePreload(() => import('./shell-layout-*.js'), [])`. The mechanism
shipped; the list it wanted was the list the report held.

Two alternatives were rejected.

Turning `modulePreload` on was rejected because it answers a smaller question than the one
asked. The engine injects hints for the static closure of the HTML entry and populates the
helper's dependency arrays; it knows nothing about `app.manifest.json`, and it cannot know
that the entry's one dynamic import is always taken, because that fact lives in
`startApplication`'s step 7 rather than in the module graph. It would also make the
document's contents a function of engine version, which is the coupling this repository
keeps out of the artifact.

Making `productionHtml` a `post` transform was rejected because it would put the whole
document — the subtractive half included — behind the build, and the subtractive half is
what proves an application's `index.html` has the shape the artifact expects. Those checks
are worth failing early, before a bundle is produced. Two phases with two jobs is the
honest shape: one prunes a source file, the other projects a graph.

## Decision

**`cli/delivery/entry-hints.mjs` projects the report onto the document.** It exports two
pure functions. `entryHints(facts)` takes the `entry`, `chunks` and `security` fields of a
report and returns an ordered hint list; `withEntryHints(html, facts)` writes that list
into the document, immediately before the module script that starts the application.

Pure, so the contract is asserted without running Vite over an application — the same
property `parseReport` has and for the same reason. The parameter is a `Pick` of
`ShellArtifactReport` rather than the whole report, so a test satisfies it with a literal.

The list is, in the order the browser should begin the transfers:

- `preload as=fetch` for `/app.manifest.json`. Startup step 2, always fetched, always at a
  fixed path, and until now not requested until the entry chunk had been fetched and
  evaluated.
- `modulepreload` for the entry chunk's transitive static closure. The browser needs all
  of it before it may evaluate the entry at all, so naming it costs nothing and is only
  ever a reordering.
- `modulepreload` for the entry chunk's dynamic imports and their static closures. That is
  the root module: `startApplication` ends by importing it, on every start, without
  exception.

Each `modulepreload` repeats the `sha384` digest the page's own import map already pins for
that URL. Without it the hint and the later module request carry different integrity
metadata, which is a second fetch rather than a reused one. The digest comes from
`security.modules`, so the two can only agree.

Both kinds of hint carry `crossorigin`. A module script is always fetched in CORS mode, and
a `fetch()` of a same-origin JSON document defaults to CORS mode with same-origin
credentials; a hint without the attribute is a no-CORS request, which the browser hands to
neither caller and reports as an unused preload.

**Nothing about evaluation order changes.** `@core/application/runtime.js` imports the root
module dynamically "because a static import is evaluated before any of the above runs".
That constraint is about evaluation, and a `modulepreload` moves only the transfer. Steps 1
through 7 keep their order and their guarantees. The consequence is that step 6's
`/auth/session` round trip stops being additive: the root module is already arriving while
it runs.

**Route chunks are deliberately absent.** Which route a visitor lands on is not a build
fact, and a document that preloaded all of them would trade a round trip for the whole
application's bytes. The entry's own dynamic imports are the boundary, because they are the
ones taken unconditionally.

**Locale bundles are absent, for a different reason.** `configureI18n` loads the locale
`preferredLocale()` negotiates, from a stored preference and `navigator.languages`. A
document that named one would be right for some visitors and would cost the others a bundle
they never read — 17 KB in the example application, which ships three. That hop closes when
locale bundles become addressable as a build fact, which is a separate decision.

`modulePreload: false` stays, now with a comment at each of the two sites saying why and
citing this record.

## Consequences

An entry document is no longer a pruned copy of a source file; it is that, plus a
projection of the artifact report. The seam moved from the `'pre'` phase — which cannot see
a chunk — to after the graph exists, and the two halves are separately assertable.

The hops removed are the ones between the document and the root module: the entry chunk's
static closure and the root module now transfer in parallel with each other and with the
manifest, instead of in sequence. A facade entry chunk still costs a request, but no longer
a round trip's worth of latency, because everything behind it is already in flight.

Every application built by this toolchain gets it, and so does every Remote's shell. There
is no application-level opt-in and nothing for an adopter to configure, which is the point:
the fact was always in the report, and an application should not have to restate it.

The cost is that the document grows by one `<link>` per chunk in the entry's static
closure, each carrying a 64-character digest. On the example application that is a few
kilobytes of markup on a `no-cache` document, against six to eight round trips. It is the
right trade at any realistic latency and the wrong one at zero, which is the shape
`tools/benchmark` measures under `--host-resolver-rules`; the benchmark's byte budgets are
where that shows up.

Two things this record does not do. Templates are still fetched one per component, so a
chunk holding nine components still costs nine serial requests once it arrives — the hint
list stops at the module graph because the template graph is owned by
[ADR-0071](0071-a-built-template-is-fetched-by-the-component-that-needs-it.md) and reopening
it is a decision of its own. And nothing yet gates chain depth, so a future change that adds
a serial hop moves no measured number. Both are the follow-ups this record leaves open.

What reopens this: a locale bundle that is hash-named and mapped from the emitted manifest.
The moment the document can name the locale a visitor will actually read, step 4 joins the
list above and this becomes a two-line change rather than a decision.
