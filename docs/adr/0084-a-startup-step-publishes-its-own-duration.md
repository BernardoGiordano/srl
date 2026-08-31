# ADR-0084: A startup step publishes its own duration

- Status: accepted
- Date: 2026-08-31
- Affects: `source/lib/core/application/runtime.js`, `source/lib/core/application/types.d.ts`, `tools/benchmark/node/startup.mjs`, `tools/benchmark/origin.mjs`, `example/benchmark.json`

## Context

`startApplication` names its seven steps and reported none of their durations.

The runtime already owns the one thing that makes a startup measurable: the order. It runs
`configure`, `manifest`, `templates`, `locale`, `providers`, `ready`, `root`, awaits each
before the next, and returns the list of the ones that ran. What it returned was a list of
names — the shape that answers "does this application restore a session?" and no question
about cost.

Everything downstream therefore measured the total. The benchmark harness records three
aggregates for a load — `rootDefined`, `firstView` and `load` — and its `minDelta.ms` is
1.0 ms over a threshold of 10%. A change that moved a single step by 30 ms is inside 10% of
an 88 ms boot, so the gate could not see it, and neither could anyone reading the report:
the number that moved was the total, and the total names no owner. Every candidate
improvement to a startup step was in that position — unverifiable not because it was hard
to measure, but because the seam that would report it did not exist.

The harness cannot derive the steps from outside, either. It installs its stopwatch at
document start, before the import map exists, and observes the first element to appear in
the shell's outlet through a `MutationObserver`; it never imports the router and never sees
what `startApplication` returned. A step boundary is invisible from there — it is a moment
inside one module's control flow, not a DOM event.

Two other facts about the same paths were open at the same time, and both were downstream
of the same missing measurement. `delivery/artifact-size` — the only workload carrying an
absolute product limit, `chainDepth: 3` from
[ADR-0082](0082-chain-depth-is-the-gated-delivery-fact.md) — is built from an application's
`benchmark.json`, and no application in the repository shipped one, so the limit was
unreachable. And the measured source origin answered no `/auth/session`, so the `ready`
step failed on a 404 and every startup and delivery sample it took was discarded as a
failure rather than recorded.

## Decision

**A step records what it cost, and the record is the same list.** `StartedApplication.steps`
becomes `readonly StartupStepRun[]` — `{ name, duration }` — rather than gaining a second
array beside it. One list with two producers is the shape that goes stale: a `timings` array
parallel to `steps` has an ordering relationship nothing enforces, and the first skipped
step makes the two disagree by index.

The duration is recorded in a `finally`, so a step that threw still reports how long it took
before it did. A boot that fails on a timeout is the case where the number matters most.

**Each step also emits a `srl:startup:<step>` User Timing measure.** This is the publication
channel for everything that cannot hold the return value: the browser's performance panel, a
field beacon, and the benchmark harness, which reads the page long after
`startApplication` resolved and has no access to the value the application's `main.js`
received. It is a platform API rather than an interface of this library's — nothing has to
be registered, and an application that wants none of it pays one `performance.measure` per
step.

**The harness declares one metric per step.** `tools/benchmark/node/startup.mjs` reads the
measures off the page's timeline and reports `stepManifest`, `stepTemplates`, `stepLocale`
and the rest in milliseconds on `startup/cold` and `startup/warm`. A step the application
does not use is absent rather than zero — a zero would enter the median as a measurement of
work that never happened. The step list is repeated there rather than imported, because the
harness reads a performance timeline, not this library's module graph; a step the runtime
adds without a line there is reported by the browser and gated by nothing.

**The two blocked gates are opened with it.** `example/benchmark.json` declares the
application's artifact benchmarks, so `delivery/artifact-size` has a producer and the
`chainDepth` limit is reachable; the declared `backend` is the module the browser suite
already installs, which is what keeps a delivery number from drifting from what the suite
asserts. And the benchmark origin answers `GET /auth/session` with the signed-out 401 on
both adapters, not only on the artifact one: a 404 is not a refusal any session store may
interpret, so it correctly became an `ApplicationStartupError` and correctly threw away the
sample.

## Consequences

`StartedApplication.steps` is a breaking change for a caller that compared it to an array of
names. The fix is `steps.map((run) => run.name)`, and the type makes every such site a
compile error rather than a silent `false`.

A startup regression now names its step. That is the property every later change to a
startup path depends on: `templates` costing 30 ms more is a metric moving 30 ms rather than
a total moving 2%, and `minDelta.ms` of 1.0 applies to a number where 1 ms is a real
fraction of the work.

The durations are recorded twice on purpose, and they can disagree by a fraction of a
millisecond — the returned value is the elapsed time the runtime measured, and the measure
is the same interval as the browser recorded it. Neither is authoritative over the other;
they are the same fact published to two audiences, and the test asserts they agree to within
a millisecond rather than exactly.

Publishing a measure per step is not free of consequence in the timeline: seven entries land
in the page's performance buffer on every boot. Seven is not a number that matters against
the hundreds a page already produces, and they are the only entries that name what a boot was
doing.

The rejected alternative is a hook: `onStep(name, duration)` on the spec, or an
`EventTarget` the runtime writes to. It moves the same fact through an interface this library
would then own, for a benefit the platform already provides, and it leaves an application
that installs no hook unmeasurable — which is the state this record exists to end.

What reopens this: a startup that stops being a fixed sequence. Steps that run concurrently,
or a step that resumes after another has started, make a flat list of durations the wrong
shape, and the answer would then be the spans the platform already has a nesting model for.
