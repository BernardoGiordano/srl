# ADR-0079: One `settled`, one clock

- Status: accepted
- Date: 2026-08-27
- Affects: `source/lib/core/elements/settled.js`, `source/lib/core/foundation/clock.js`, `source/lib/test/harness.js`, `source/lib/core/navigation/router.js`

## Context

The rule for when a render is finished had a dozen spellings. The router had a private `whenRendered()`, the harness had `settled()`, and nine component suites each wrote their own `ready()`, no two alike. A wrong guess shows up as a flaky test on a slow machine.

Three components also debounced with `setTimeout` directly. Their tests could only sleep past the timer, and one module exported its debounce length so a test could add 20 ms to it and sleep. A sleep only asserts that nothing happened within N ms, which proves little on a loaded CI machine.

## Decision

`@core/elements/settled.js` owns render completion.

- `whenRendered(element)` waits for one element's render, including the render its first one schedules.
- `settled(element)` waits for the element and everything it rendered. It walks the subtree repeatedly until a pass finds no new updatable descendants, because a routed chain reveals its levels one at a time.

The router imports `whenRendered` from this module, and the test harness re-exports `settled`, so the framework and the tests share one definition.

`@core/foundation/clock.js` owns scheduled work. `schedule(callback, delayMs)` returns a cancel function. `configureClock({ clock })` swaps the implementation, and calling it with no argument restores real timers. `createManualClock()` offers `flush()` and `pending`. It has no `advance(ms)`, because a test that knows a debounce length is coupled to it.

## Consequences

- No suite sleeps past a debounce. Tests assert on `clock.pending` instead.
- `settled` and `configureClock` are public, so an adopter's suites use the same seams.
- `auth/session.js` keeps its own `setTimeout`, because its refresh schedule depends on the current time.
- Nothing yet stops new code from calling `setTimeout` directly.
- A component that needs to read the current time would add `now()` to the clock.
