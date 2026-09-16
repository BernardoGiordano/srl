# Writing tests

Use the same browser imports and lifetimes that an application uses.

- Await `settled` from `source/lib/test/harness.js` after rendering. It waits for
  the element and its rendered descendants. Await `navigate()` or
  `navigationSettled` for route changes.
- Use `createManualClock()` for debounced work. Install it in `beforeEach`,
  call `clock.flush()` to run scheduled work, and restore the real clock in
  `afterEach`. Tests should not sleep past a guessed delay.
- Test through public entry points. Router tests call `attachRouter()` because
  `AppRouter` is internal.
- Import through the browser import map. A second URL for the same module creates
  a second module instance, including a second injector.
- Give each test a `createMemoryStorage()` adapter so preference state cannot
  leak between cases.
- Install the collection text resolver before mounting elements. Restore it after
  they are removed, since mounted elements can still read it during teardown.
- Keep framework fixtures under `source/lib/test/fixtures/`. The library suite
  must run with any application mounted at `/`.

The browser suites run in Chrome. The separate
[cross-browser journey](browser-support.md) runs a composed flow against a built
artifact on Blink, Gecko, and WebKit.
