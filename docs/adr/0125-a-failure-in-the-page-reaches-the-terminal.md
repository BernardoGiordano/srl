# ADR-0125: A failure in the page reaches the terminal

- Status: accepted
- Date: 2026-10-06
- Affects: `cli/dev/update-client.js`, `cli/dev/updates.mjs`, `cli/diagnostics/index.mjs`, `cli/diagnostics/catalog.mjs`, `source/lib/core/application/runtime.js`, `source/lib/core/template/expression.js`, `docs/guide/startup.md`

## Context

`srl serve` sent the page an event stream and heard nothing back. A failed startup left
a blank page and a line in the browser console. A lazy route whose module was missing
did the same. A template that read a name the component lacked rendered `undefined`
without a word, because the evaluator had no development mode to warn in. A developer
had to open the console to learn any of it, and an agent working from the terminal could
not learn it at all.

Two alternatives lost.

- A headless browser started by `srl serve` would see failures without a page open, but
  it would load every route of every application on every save and put a browser in the
  CLI's dependencies.
- Printing the browser console through a debugging protocol ties the server to one
  engine and still carries no codes.

## Decision

**The page posts each failure to `srl serve`.** The development server injects two
scripts, as it already injects the update client. A classic script first in the head
queues every `error` and `unhandledrejection` event, so a failure while the entry
module evaluates is kept. The update client drains the queue in `watchFailures()`,
turns each event into a diagnostic and posts it to `/__updates/diagnostics`. A page
reports each problem once.

**A diagnostic carries the innermost code.** An error whose `cause` chain holds a
catalogued code is reported under the deepest one, because that error names the problem
and the outer ones name where it surfaced. `ApplicationStartupError` carries
`runtime/startup`. A failed dynamic import is `runtime/module-load`. An error with no
code anywhere is `runtime/uncaught`. The catalogue holds the `runtime/` codes beside the
codes of `srl check`.

**The server prints one line per diagnostic.** It refuses a body that is not a
diagnostic, maps the URL to the file it is served from, and prints the line through
`formatLine` in `cli/diagnostics/`.

**An unknown template name is a development warning.** The evaluator calls a reporter
when no local, member or template global answers a name. None is installed by default,
so a production page pays one map lookup on that path and nothing else. The update
client installs one through `reportUnknownNames` that reports `runtime/unknown-binding`.
The hook is public, so a suite can install its own.

**Errors show in the page too.** A panel in a shadow root lists each error with its code
and place. It is built with DOM calls and a constructed stylesheet, so a page that
enforces Trusted Types or a strict `style-src` still shows it.

## Consequences

- A blank page in development has a reason in the terminal that served it.
- Only `srl serve` and servers built on `cli/dev/updates.mjs` relay failures. A page
  served any other way keeps its errors in the console.
- Runtime errors other than startup still throw plain `Error`s, so most arrive as
  `runtime/uncaught` with their message and place. A code per problem would need codes
  at each throw, which this does not attempt.
- The startup error's place is the line in the library that threw it. The message names
  the step and the cause, which is what points at the application's file.
- Reopen this if a second engine reports module failures in a way the client cannot
  tell apart, or if development needs failures from a page nobody has open.
