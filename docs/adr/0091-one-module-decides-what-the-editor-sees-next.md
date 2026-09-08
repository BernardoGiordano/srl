# ADR-0091: One module decides what the editor sees next

- Status: accepted
- Date: 2026-09-08
- Affects: `cli/language-server/analysis.mjs`, `cli/language-server/server.mjs`, `cli/language-server/service.mjs`, `cli/checks/template-check.mjs`

## Context

The protocol adapter scheduled its own work. One validation timer held the most recently
touched URI, so two files opened inside the 120 ms debounce produced diagnostics for the
second one only, and the first stayed blank for as long as it stayed open. A change to a
JavaScript host scheduled that host alone, although every template checked against it is
checked through a shim that imports it. A close published an empty list and left each
template that had been reading that buffer describing text the editor no longer held.

The cost was worse than the staleness. On this repository one template check took about
1.4 seconds warm and 2.6 cold, on the only thread there is, so a request that arrived
behind one waited for all of it. Two causes, both of them work nobody asked for:
`getPreEmitDiagnostics(program)` typechecked every file in the repository and then
discarded all but the one shim's findings, and any open JavaScript buffer disabled
`oldProgram` reuse, rebuilding the whole program on each keystroke in an unrelated
template.

The compiler ADR-0039 caches also holds the parsed `tsconfig.json`. A CLI process ends
before that can go stale. The server does not: an edit to the configuration left
diagnostics on the options parsed at startup until the editor was restarted.

## Decision

`analysis.mjs` owns document lifetime, the set of documents whose answers are stale,
which documents a change makes stale, when the project model is re-read, and when the
cached compiler stops describing this project. Protocol dispatch calls it and decides
nothing about ordering.

Staleness is a set rather than a timer's argument, so opening a second file cannot cancel
the first one's answer. A change makes stale every open document whose shim reads the
changed file: the component's own module, the module of each custom element the markup
names, and the module of each global it may use. A close is such a change, because the
overlay it removes was an input to those checks.

The queue hands the thread back before each document, so a request that arrived while the
previous document was checked is answered before the next check starts. A document edited
while its own check ran is queued again instead of published: that answer describes text
the editor has already replaced.

Diagnostics are asked per shim — `getPreEmitDiagnostics(program, file)` — not per
program. `oldProgram` is reused when the overlay is the same text for the same files,
rather than when there is no overlay. That is both wider than the rule ADR-0090 stated,
because an unchanged buffer no longer forces a rebuild, and narrower, because an emptied
overlay no longer reuses a program built from one.

`invalidateCompiler()` discards the cached compiler. Analysis calls it for a change to
`tsconfig.json` or `package.json`, and never for a source edit, whose reload keeps the
parsed program ADR-0039 exists to keep.

`checkTemplateSource()` accepts a `ts.CancellationToken`. The check is one synchronous
call, so a time budget is the only thing that can bound it. A check the budget cancels is
retried without one, so a slow project is slow rather than silently undiagnosed.

## Consequences

Measured against the same code path before the change, on one quiet machine, as the
median of three runs each: a warm check fell from 1359 ms to 44 ms, a cold one from
2571 ms to 838 ms, and a warm check with an open but unchanged JavaScript buffer from
1079 ms to 32 ms. `cli/test/language-server.test.mjs` and `cli/test/template-check.test.mjs`
together fell from 51.1 s to 2.6 s, and `npm run templates:check` from 3.8 s to 2.6 s.
Over the protocol, a completion asked while the queue was draining answered in a median
87 ms across twelve samples. These are one developer machine's numbers, taken to compare
two commits rather than to become a release gate; a gate needs the repeatable workload
that does not exist yet.

Diagnostics are scoped to the shim, so a type error in the application's own JavaScript
is not reported through a template. It never was — the whole-program result was filtered
to the shim before any caller saw it — but the cost of computing it is now not paid.
`npm run typecheck` remains where that error is reported.

Nothing preempts a running typecheck. One pathological template still holds the thread
for its budget, and the honest fix is a worker thread, which means a second compiler and
a second warmup to pay for it.

Revalidation covers open documents, as it did before. A template nobody has open keeps
whatever the last `templates:check` run said about it.
