# ADR-0079: One `settled`, one clock

- Status: accepted
- Date: 2026-08-27
- Affects: `source/lib/core/elements/settled.js`, `source/lib/core/foundation/clock.js`, `source/lib/test/harness.js`, `source/lib/core/navigation/router.js`, `source/components/data/ui-table.js`, `source/components/data/ui-dynamic-filter.js`, `source/components/shell/ui-sidebar.js`

## Context

Two rules were written once each in this repository's documentation and a dozen times in
its source.

The first is when a render is finished. [`docs/guide/testing.md`](../guide/testing.md)
states it as one line — await `settled`, never a frame, no suite sleeps — and the code held
twelve spellings of it. `router.js` had a private `whenRendered()`; `harness.js` had a
`settled()` whose body was the same three awaits; `router.test.js` declared a
`settleChain()` that walked a mounted chain level by level, because a routed layout's child
does not exist until that layout has rendered its outlet; and nine component suites each
declared a local `ready()`. No two of the nine agreed. Four awaited every descendant's
`updateComplete`, one named `ui-combobox, ui-date-range` specifically, three settled the
root twice and stopped, and one settled the root, then a combobox, then the root, then the
combobox again. Every one of them is a guess at the same rule, and the guess that is wrong
is the one whose assertion goes flaky on a slower machine — which is precisely the failure
mode a suite cannot afford, because it reads as an unrelated regression.

The second is when scheduled work happens. Three components debounce: `ui-table` persists
its column configuration, `ui-sidebar` its collapsed state, `ui-dynamic-filter` holds a
typeahead search until the keystrokes stop. All three called `setTimeout` directly. A
component that owns its own timer leaves a suite one move: sleep past it. So `table.test.js`
slept 400 real milliseconds to assert that a flushed timer does not fire twice, and
`ui-dynamic-filter.js` exported `TYPEAHEAD_DEBOUNCE_MS` — 300 — for exactly one caller, the
async suite, which added twenty to it and slept. A production module publishing a number so
that a test can do arithmetic on it is not a constant with two consumers; it is the shape
of a seam that is missing.

Sleeping is not merely slow. `await wait(400)` asserts "nothing bad happened within 400ms",
which is a weaker claim than the one the test means and an unfalsifiable one on a loaded CI
machine: the sleep either outlasts the timer or it does not, and the test cannot tell you
which.

Two alternatives were rejected.

Making the suites' `ready()` a second export of the harness — leaving `whenRendered` in the
router — was rejected because the router is the one caller that proves the rule. The rule
exists because a projecting component puts its children back at the end of its own render;
the router discovered that, and a copy in `lib/test/` that the framework does not use is a
copy that can drift from the behaviour it describes without any suite noticing.

Injecting a clock per component — a `clock` property on `ui-table`, set by whoever mounts
it — was rejected for the reason [ADR-0015](0015-one-synchronous-preference-boundary.md)
gives about preference storage. Three components would mean three places to configure, an
application would configure the two it happened to know about, and a suite for a fourth
component would find no seam at all. The boundary belongs to one module, the same way
`localStorage` does.

## Decision

**`@core/elements/settled.js` owns when a render is finished.** It exports two names.
`whenRendered(element)` is one element's own render, including the render its first one
scheduled: `updateComplete`, one turn, `updateComplete` again. `settled(element)` is that
element and everything it rendered.

`settled` walks repeatedly rather than sweeping once, because a single pass over
`querySelectorAll('*')` returns before a routed chain has revealed its deepest view. Each
pass waits for the updatable descendants it has not waited for yet; a pass that finds none
means the subtree has stopped growing, and the root's own render is awaited once more. That
subsumes `settleChain` and all nine `ready()` bodies, so all ten are deleted and their 220
call sites now name `settled`. `router.js` imports `whenRendered` from the same module, so
the framework and the suites cannot hold two opinions about the word.

Waiting for a subtree costs more awaits than the narrowest of the nine local helpers did.
That is the correct direction for a test helper to err in — every one of the nine was an
optimisation nobody measured — and no production path calls `settled`; the router calls
`whenRendered`.

`whenRendered` no longer returns early for an element with no `updateComplete`. Awaiting
`undefined` still yields its three microtask turns, which is what the harness has always
done and what a caller holding a plain element expects. The router gains those turns before
a `querySelector` it was already awaiting.

**`@core/foundation/clock.js` owns when scheduled work happens.** `schedule(callback,
delayMs)` returns the one call that cancels it. `configureClock({ clock })` replaces the
implementation and, called with no argument, restores real timers — the same shape
`configurePreferences({ storage })` has, for the same reason.

Cancelling is the returned closure rather than a handle passed back in. A handle would have
to be interpreted by whichever clock is installed at the moment of cancellation, which is
not necessarily the one that issued it; a closure cannot reach the wrong clock.

`createManualClock()` is the second implementation, and what makes the seam real rather
than notional on the day it lands — the same test [ADR-0072](0072-a-check-returns-diagnostics.md)
applied to its JSON adapter. It exposes `flush()`, which runs everything waiting in the
order it came due, and `pending`, which is how many callbacks are waiting.

It deliberately has no `advance(ms)`. Reaching a point "just before" a debounce means
knowing the debounce's length, and a suite knowing that number is the export this record
deletes. `flush()` says what a suite actually means: let the scheduled work happen now.

`ui-table`, `ui-sidebar` and `ui-dynamic-filter` schedule through that module and hold the
returned canceller instead of a timer id. `TYPEAHEAD_DEBOUNCE_MS` is no longer exported.

`source/lib/auth/session.js` keeps its own `setTimeout`. Its timer is a refresh schedule
rather than a debounce, it is computed against `Date.now()`, and a clock seam there is a
decision about injecting the current time as well — a different question, with the
`@auth/` boundary's own reasons for answering it separately. It is named here so the next
reader knows it was considered rather than missed.

## Consequences

No suite sleeps to reach the far side of a debounce, which is what
[`docs/guide/testing.md`](../guide/testing.md) already claimed. The two assertions that
used to depend on outlasting a timer now depend on the clock's contents, and both got
stronger for it: unmounting a table asserts `clock.pending === 0` — the flush cancelled the
timer rather than leaving one behind — and then drains the clock to prove nothing fires. A
burst of five keypresses asserts `clock.pending === 1`, which is what "coalesces" means and
what the old test could only infer from a single write arriving later.

One assertion got weaker, and this is the cost. `table.test.js` also used its 400ms sleep to
give a released `IntersectionObserver` a chance to deliver an entry it should not have.
Nothing schedules that delivery through the clock, so `requests.length` is now checked
without waiting for a task. The claim that survives is that the observer was disconnected in
`onDestroy` and that the sentinel left the document, both still asserted. Outwaiting the
observer was never a strong claim either — a 400ms sleep that passes tells you nothing about
a 500ms delivery — but it was not nothing, and it is gone.

An adopter gets both seams. `settled` is on the door of `@srljs/core`, so an application's
own suites stop inventing a tenth `ready()`, and `configureClock` is how an adopter's suite
reaches past a debounce in a component this collection does not own.

Two things are not enforced. Nothing stops a fourth component calling `setTimeout` directly,
the way `tools/checks/verify-deps.mjs` rule 14 stops a second module reaching for
`localStorage`; and nothing stops a tenth local `ready()` being written in a new suite. Both
are the same gap and the same fix — a rule over the project model, which already records
`localStorage` references as expressions and would record `setTimeout` the same way. That is
the follow-up this record does not do.

What reopens this: a component that needs to know the current time rather than only to
schedule against it. `Clock` has one method because a debounce needs one; a component that
wants `now()` — a countdown, a stale-after-N-seconds badge, the auth refresh above — makes
this interface two methods and makes `createManualClock()` responsible for a clock reading,
not just a queue. Better to add that when a caller exists than to guess at it now.
