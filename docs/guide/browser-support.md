# Supported browsers and the accessible journey

```bash
npm run test:journey         # the journey, on every declared engine
npm run journey:record       # the same run, written to tools/browser/journeys.json
npm run docs:browsers        # fail if this page disagrees with that file
```

The browser journey runs against a built example artifact on Blink, Gecko, and
WebKit. The artifact uses its production Content Security Policy. The suite is
part of `npm run check`.

## What a support claim means here

The table below records the browser builds that ran one composed interaction.
The library and component suites cover more isolated behavior, but run in Chrome.
The journey checks that these parts work together on all three engines.

<!-- generated:browsers-matrix -->

| Engine | Browser | Build | Journey | Next control |
|---|---|---|---|---|
| Blink | Chromium | `153.0.8010.12` | passed | `Tab` |
| Gecko | Firefox | `155.0` | passed | `Tab` |
| WebKit | WebKit | `26.6` | passed | `Alt+Tab` |

Recorded 2026-09-12 on Apple M3, Darwin 25.6.0 (arm64), Node v22.14.0, driven by `playwright@1.63.0`.

The journey drove the built `example` artifact served under the policy the build emitted:

```
default-src 'self'; script-src 'self' 'sha256-unYyEYlx3H+wQ5W5h4v5zC0VfOaa/xfdRl3ygWzVIMI='; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; trusted-types lit-html ui-test ui-test-template srl-worker; require-trusted-types-for 'script'
```

<!-- /generated:browsers-matrix -->

## The journey

<!-- generated:browsers-journey -->

Every engine above ran these steps in this order. The readings are Chromium 153.0.8010.12's; the other engines observed the same facts, which is what made them pass.

| Step | What it proves | Observed |
|---|---|---|
| `windowed-rows` | A table window renders a fraction of the rows it announces | rowCount: 121; rendered: 19; scrollHeight: 5445; viewport: 480 |
| `keyboard-selection` | A row is chosen with Space and the count is announced | checked: 1; announced: 1 movement selected Net +5 Clear selection |
| `window-keeps-focus` | Moving focus moves the window and the selection survives | nextControlKey: Tab; firstIndexWhenMoved: 10; scrollTop: 547; focusedRow: 20; renderedWhenChosen: 19; checkedWhenChosen: 1; announcedSelection: 2 |
| `async-validation` | An asynchronous refusal reaches the control that earned it | settledWhileTyping: false; invalid: true; describedBy: cf-email-error; error: Another customer already uses this. |
| `combobox-keyboard` | A combobox option is reached and chosen with keys alone | options: 4; activeOption: Mid-market; chosen: none; value: Mid-market |
| `dialog-focus-return` | A modal is answered with a key and returns focus | role: alertdialog; label: Unsaved changes; answeredControl: Keep editing; route: /sales/customers/CU-0001; focusAfter: input#ui-combobox-12-input |

<!-- /generated:browsers-journey -->

## Screen readers

<!-- generated:browsers-assistive -->

No screen-reader pass is recorded in `tools/browser/assistive.json`. The journey asserts on the accessibility surface — roles, names, `aria-activedescendant`, `aria-rowindex`, `aria-describedby`, where focus is — and a driver reading those attributes is not a screen reader announcing them. **This project therefore makes no assistive-technology claim at all.**

<!-- /generated:browsers-assistive -->

A person records a screen-reader pass in `tools/browser/assistive.json`, including
the reader, browser, platform, date, steps, and announcements heard. Automated
attribute checks do not supply those observations.

## What this does not cover

<!-- generated:browsers-limits -->

| Not covered | What that means |
|---|---|
| Assistive technology | No screen reader has been driven over this journey. ARIA attributes are asserted; announcements are not. |
| Runs on its own | A workflow runs `npm run check`, which includes the journey suite, so a regression fails a pull request. |
| One journey, not the application | The steps above are the only composed path proved on more than one engine. Every other screen is covered by the Chrome-only suites. |
| Backwards through a window | A window renders a slice, so keyboard focus can only reach the rows in it. Moving focus backwards stops at the first rendered row instead of pulling earlier rows in, and the journey does not claim otherwise. |
| One build each | A passing engine is the build named in the matrix, not every version of it. Nothing here says anything about an older or newer one. |

<!-- /generated:browsers-limits -->

## Adding an engine

Add the engine and its next-control key to `ENGINES` in
`cli/test/support/journey/engines.mjs`, then record a run. A declared engine that
cannot run fails the suite.

## Adding a step

Write a step once in `cli/test/support/journey/journey.mjs` for every engine.
Steps press keys and read observable page state. They do not call component
methods or inspect private fields. Add new readings to `observer.mjs` and type
them in `types.d.ts`.
