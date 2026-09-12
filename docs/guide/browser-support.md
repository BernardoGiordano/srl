# Supported browsers and the accessible journey

```bash
npm run test:journey         # the journey, on every declared engine
npm run journey:record       # the same run, written to tools/browser/journeys.json
npm run docs:browsers        # fail if this page disagrees with that file
```

Three engines run one journey through the built example artifact, served under the
Content-Security-Policy the build emitted. `cli/test/support/journey/` holds the whole
arrangement: the observer that reads a page, the engine adapters, and the journey itself.
The suite runs inside `npm run check`, so an engine that breaks fails a pull request.

## What a support claim means here

An engine named in a configuration file is not evidence. What this page publishes is the
result of running one composed interaction on each engine, with real keys, against the
bytes that ship — and, just as important, what that run does not cover.

The journey is one path. The library's own suites and the component collection's suites
are broader and run on Chrome alone; they prove that a dialog traps focus and that a table
windows its rows, each in isolation. What no isolated suite can prove is that those
behaviours still hold when they happen to the same user in the same minute, on an engine
nobody has opened, which is what the journey is for.

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

A pass is recorded by the person who ran it, in `tools/browser/assistive.json`, with the
reader, the browser, the platform, the date, the journey steps it covered and what it
sounded like. Nothing generates that file and nothing can: a driver reads attributes, and
what a screen reader says about them is a different question.

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

Add it to `ENGINES` in `cli/test/support/journey/engines.mjs` with the key it reaches the
next control by, then record a run. The suite iterates the same list, so a declared engine
that cannot run fails immediately rather than appearing in the matrix as a name.

## Adding a step

Steps live in `cli/test/support/journey/journey.mjs` and are written once for every
engine. A step may press keys and take readings; it may not call a component's method or
read a class field, because what an application can do to itself is the same on every
engine and is not what the journey is asking.

A new reading goes in `observer.mjs`, typed in `types.d.ts`. That pair is the observable
interaction interface, and everything a journey may know about a page comes through it.
