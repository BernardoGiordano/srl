# Writing tests

Component tests run in Chrome against the source files the browser loads, with
no transform. `@web/test-runner` runs them through a preset that `@srljs/cli`
publishes, and this repository runs its own suites through the same preset.

## Setup

`srl new` writes all of it. A project created before that adds four things.

```js
// web-test-runner.config.mjs
import { testRunnerConfig } from '@srljs/cli/testing/web-test-runner.mjs';

export default testRunnerConfig({ app: 'web' });
```

- A `test` script that runs `web-test-runner`.
- `@web/test-runner` and `@types/mocha` in `devDependencies`, at the versions
  `@srljs/cli` lists under `scaffold.devDependencies`.
- `"types": ["mocha", "node"]` in `tsconfig.json`, so `srl check` knows
  `describe` and `it`.

| Option | Meaning |
|---|---|
| `app` | The application directory. Its `test/**/*.test.js` files run. |
| `files` | More test globs, relative to the project root. |
| `policies` | Trusted Types policies the application creates. |
| `timeout` | Milliseconds one test may take. The default is 4000. |

The preset serves the project root and rewrites each URL to the place a
deployed page finds it. `/lib/` and `/components/` reach the installed library,
and each top-level file or directory of the application is served at `/`. The
test page carries the application's own import map from `index.html`, plus
`@srljs/core/testing/harness.js`. It enforces Trusted Types for the library's
policies and the harness's.

## A test

```js
import { assert, mount, present, settled, unmountAll } from '@srljs/core/testing/harness.js';

import '../src/pages/home-page.js';

describe('home-page', () => {
  afterEach(() => {
    unmountAll();
  });

  it('counts each click', async () => {
    const page = mount('<home-page></home-page>');
    await settled(page);

    const button = present(page.querySelector('button'));
    button.click();
    await settled(page);

    assert.equal(button.textContent?.trim(), '1');
  });
});
```

`npm test` runs every suite. `npx web-test-runner web/test/home-page.test.js`
runs one file, and `--watch` reruns on save.

## Rules

- Import the harness as `@srljs/core/testing/harness.js` and the module under
  test by relative path, as the application imports it.
- Await `settled` after rendering. It waits for the element and its rendered
  descendants. Await `navigate()` or `navigationSettled` for route changes.
- Use `createManualClock()` for debounced work. Install it in `beforeEach`,
  call `clock.flush()` to run scheduled work, and restore the real clock in
  `afterEach`. Tests should not sleep past a guessed delay.
- Test through public entry points. Router tests call `attachRouter()` because
  `AppRouter` is internal.
- Import the library through the import map. A second URL for the same module
  creates a second module instance, including a second injector.
- Give each test a `createMemoryStorage()` adapter so preference state cannot
  leak between cases.
- Install the collection text resolver before mounting elements. Restore it after
  they are removed, since mounted elements can still read it during teardown.

## In this repository

The library and collection suites run beside the example's, as more `files`
in the root `web-test-runner.config.mjs`. Keep framework fixtures under
`source/lib/test/fixtures/`, because the library suite must run with any
application mounted at `/`. `APP=<name> npm test` runs another application's
suite.

The separate [cross-browser journey](browser-support.md) runs a composed flow
against a built artifact on Blink, Gecko, and WebKit.
