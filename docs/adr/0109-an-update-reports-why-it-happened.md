# ADR-0109: An update reports why it happened

- Status: accepted
- Date: 2026-09-10
- Affects: `source/lib/core/diagnostics/updates.js`, `source/lib/core/diagnostics/report.js`, `source/lib/core/diagnostics/types.d.ts`, `source/lib/core/elements/signal-element.js`, `source/lib/core/template/template.js`, `source/lib/test/diagnostics/updates.test.js`, `docs/guide/performance.md`, `docs/known-gaps.md`, `docs/reference/source-layout.md`

## Context

Startup is the only part of this framework that explains itself. Each boot step
publishes a duration and a `srl:startup:<step>` User Timing measure, and a failure inside
one is rethrown naming the step
([ADR-0084](0084-a-startup-step-publishes-its-own-duration.md)). After the first
paint there is nothing. A component that renders forty times, or a binding that
re-evaluates on every keystroke, leaves no evidence at all, and the developer's only tool
is a `console.log` in `render()`.

That tool is worse here than it is in most frameworks, because a `render()` is not where
most of the work happens. There are two update paths and they are independent. An element
renders when a signal its `render()` read changed, or when a reactive property was
written. A compiled binding evaluates inside an effect of its own, and when a signal *that
expression* read changes it patches its own Lit Part with no render anywhere
([ADR-0014](0014-compiled-templates-and-scopes-keep-their-identity.md)). A timer around element renders would
therefore report silence for the update path a fine-grained framework produces the most
of, and report it confidently.

`docs/known-gaps.md` had no entry for this, which was itself the gap: the framework
measured what it could already name and had never decided what "why did this update"
should mean.

## Decision

**Both paths report, and one module reconstructs.** `@core/diagnostics/updates.js` takes
an event from the element render path and an event from the binding path and builds a
tree, because the relationship between them is the answer. A binding patch recorded while
an element render is open is a child of that render — the component re-rendered and its
bindings followed. A binding patch with no render open is a top-level record — one
expression updated on its own. That distinction is the whole diagnosis, and leaving it to
whoever reads a log is what makes logging hooks useless.

**A cause is reported by the path that knew it, never inferred.** `SignalElement` carries
`#updateCause`, and only the two places that can actually say write to it: the tracking
effect sets `signal` when it re-runs, and `connectedCallback` sets `reconnect` when the
element comes back. Everything else that reaches `requestUpdate()` is a property write,
which is the default. The binding directive reads its cause off the state its
short-circuit already compares — a different evaluator or scope object is a `rebind`, a
bumped version on the same pair is a `rerender`, and any later run of its own effect is
`signal`. Nothing is derived from timestamps or from guessing.

**It does not name the signal, and says so.** `cause: 'signal'` means the effect behind
that element or that binding re-ran. Which signal woke it is not recorded, because
`@preact/signals-core` reports no dependency by name, and `@core/foundation/reactive.js`
is the only file allowed to know that library exists, so reaching past it for a private
dependency set would trade the seam for a guess. Attribution stops where the evidence
does. A report that named a plausible signal would
be worth less than one that admits it cannot.

**Recording is explicit, and there is one.** `recordUpdates()` returns the call that stops
it and yields the report, which is how every other lifetime in this codebase is handed
back. A second concurrent recording throws rather than splitting a tree between two
readers, because there is no useful answer to what happens to the records already open in
the first.

**The limit bounds the tree, not the counts.** A recording left running across a long
session would otherwise retain one record per binding evaluation and change the thing it
was measuring. Past 5,000 retained records the tree stops growing and `dropped` says by
how much, while the two summaries stay exact — they cost one map entry per distinct tag or
binding however many updates arrive. A dropped record takes its children with it, so the
tree never holds a child whose context is missing.

**Text is the adapter.** `formatUpdateReport` renders the two summaries and the timeline
as a string, which a console takes, a test asserts on and a bug report pastes.

**Rejected: an always-on ring buffer.** Every update would pay for a record whether or not
anybody was going to read one, and the framework's own performance claims would then be
measurements of the instrumented build. Off means one module-level null check and one call
to a shared empty function per update.

**Rejected: a devtools panel or an inspection protocol.** One consumer is not a seam. A
panel is a second application, a protocol is a compatibility surface, and neither is
justified by a module whose first user is a developer with a console open. A second
adapter is a real module the day a second consumer exists.

**Rejected: logging hooks left for the caller to assemble.** `onElementUpdate` and
`onBindingUpdate` callbacks would be a shallow module in the exact sense this codebase
avoids: every consumer would rebuild the nesting, the causes and the summaries, and each
would rebuild them slightly differently.

**Rejected: a state or component-tree inspector.** Reading the live tree is a different
question from explaining a change, needs a different lifetime, and would have made this a
devtools project rather than a diagnostic. It stays in `docs/known-gaps.md` with its own
trigger.

## Consequences

`SignalElement.performUpdate` reads and resets `#updateCause`, then opens a record around
`super.performUpdate()` in a `try`/`finally`, so a render that throws still closes its
frame. `updated()` reports the changed property names, because that is the first moment
Lit has said which properties moved and it is inside the render that is already open.

`Chunks.hole` takes the label of the binding it is emitting, and labels the evaluator
there rather than at the eight call sites: `hole` is the one place that sees the *final*
evaluator, after a sink or an interpolation join has wrapped it, and that wrapper is the
identity the Part commits and a report must name. `expressionAt` and the compiler's text
path now share `interpolationWhere`, so an interpolation is named the same way in an error
and in a report.

Labelling happens whether or not a recording is running. A template compiles once per URL
and a recording almost always starts afterwards, so the alternative is a report full of
unnamed bindings. The cost is one `WeakMap` entry per binding per compiled template.

`ReactiveBindingDirective.#track` takes a cause and its effect body opens and closes a
record around the evaluation and the commit. A binding whose evaluator throws records
nothing for that run; bindings hold no stack, so there is nothing left inconsistent.

`source/lib/core/diagnostics/` is a new directory under a prefix that already exists.
`@core/` maps to `lib/core`, so the import map, the `tsconfig` paths and the `srl-core`
bundle all reach it with no interface edit; the `@internal` instrumentation entry points
stay out of the generated barrel and only `recordUpdates`, `isRecordingUpdates` and
`formatUpdateReport` are published.

**What would reopen it:** a second consumer for the records — a panel, an editor, a field
beacon — which is when the text adapter becomes one adapter of several rather than the
presentation layer. Or a reactive library that reports a dependency by name, at which
point `cause: 'signal'` can carry the signal it means.
