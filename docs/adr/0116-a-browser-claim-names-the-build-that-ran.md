# ADR-0116: A browser claim names the build that ran

- Status: accepted
- Date: 2026-09-12
- Affects: `cli/test/support/journey/engines.mjs`, `cli/test/support/journey/observer.mjs`, `cli/test/support/journey/journey.mjs`, `cli/test/support/journey/stage.mjs`, `cli/test/browser-journey.test.mjs`, `tools/browser/record.mjs`, `tools/checks/browser-check.mjs`, `docs/guide/browser-support.md`, `example/src/pages/inventory/movements-page.js`, `.github/workflows/ci.yml`

## Context

The suites were good and the claim was empty.

`source/components/test/` covers a great deal of real DOM and keyboard behaviour. A dialog
is asserted to trap focus, a combobox to move `aria-activedescendant`, a table to render a
window over rows it does not put in the DOM. Every one of those cases runs in Chrome,
because `@web/test-runner` launches the Chrome the machine has and `cli/test/support/artifact-origin.mjs`
launches another one through `puppeteer-core`. Nothing in the repository had ever opened
Firefox or WebKit.

That left two different gaps, and only one of them was about browsers.

The first is composition. Each of those suites proves its own component in isolation, and
the behaviour a user meets is all of them at once — a window that moves while a row is
selected and focus sits on it, an error that arrives after the user has already tabbed
away from the field that earned it, a modal raised by a route guard that has to give focus
back to whatever the user was in. No isolated case can fail when those interact, because
none of them is present when the others run.

The second is the support claim itself. A repository that says nothing about browsers is
at least not wrong; this one said nothing and shipped a component collection, which reads
as "the usual ones". "The usual ones" is a claim with no owner, and the way it is usually
repaired — naming engines in a configuration file — repairs the sentence rather than the
evidence. An engine in a config is a name. A recorded run is a fact about a build.

Accessibility sat across both gaps. The components carry real ARIA and the suites assert
on it, but nothing had asserted on it *through a composed journey*, and nothing had ever
been announced by an actual screen reader. Those two are not the same claim and must not
be published as though they were.

## Decision

**One journey, written once, run by every declared engine.** `journey.mjs` holds the
steps; `engines.mjs` holds the engines. The journey opens a windowed table, chooses a row
with Space, carries focus through the window, moves to a form, types an address another
customer owns, leaves the field and reads the error the control is pointed at, opens a
combobox and chooses an option with arrows and Enter, then tries to leave with unsaved
work, answers the modal with a key and checks where focus went. It runs against the built
`example` artifact under the Content-Security-Policy the build emitted, because the point
of a support claim is the bytes that ship.

**The engine adapter may navigate, press a key and evaluate.** Nothing else. Every
judgement about what a page looks like is in `observer.mjs`, evaluated inside the page and
typed in `types.d.ts`; every judgement about what the application should do is in
`journey.mjs`. A driver with a `selectRow()` on it would be the browser-compatibility
module this arrangement exists to avoid — the same expectation written three times, free
to mean three things.

**Readings are taken through the accessibility surface.** Focus is `document.activeElement`
and the name it carries. A field's error is the `role="alert"` paragraph its control points
`aria-describedby` at. A combobox's highlight is `aria-activedescendant`. A window's
position is `aria-rowindex` against `aria-rowcount`, and its selection is the count the
page announces rather than the checked boxes it rendered — a window renders a slice, so
counting boxes answers a different question. An assertion on a private field would pass on
an engine where a screen reader is told nothing, which is the failure this is for.

**One per-engine fact is declared rather than hidden.** WebKit ships with full keyboard
access off, so Tab reaches links and text fields and skips a checkbox; Option+Tab is what
a Safari user with default settings presses. `nextControl` names it, the journey asks for
"the next control" rather than for Tab, and the published matrix prints which key each
engine needed.

**The matrix is generated from a recorded run.** `npm run journey:record` runs the same
journey and writes `tools/browser/journeys.json` — the engine builds, the machine, the
date, the policy, and every step's own readings. `tools/checks/browser-check.mjs` turns
that into `docs/guide/browser-support.md` on the marker grammar the project index and the
performance guide already use ([ADR-0099](0099-a-performance-claim-carries-its-standing.md)
for the same argument about numbers), and `npm run docs:browsers` fails when the page
disagrees with the file. It runs inside `npm run check`.

**Screen readers are a separate, manual, hand-written record.** `tools/browser/assistive.json`
is written by the person who ran the pass, with the reader, the browser, the platform, the
date and the steps it covered. It is empty, and the guide therefore publishes that this
project makes no assistive-technology claim. A driver reading ARIA attributes is not a
screen reader announcing them, and merging the two files would let the automated run look
like coverage it is not.

**The movements screen became the windowed one.** The journey needs a table with more rows
than the DOM holds, and a stock log that grows from the top is the screen where a window is
right anyway: a page number over a list that gains rows every few seconds names a different
row each time it is read. It is `pagination="none"` with `virtualized`, and `selectable`
with a net quantity over the chosen rows, which is the arithmetic a reconciliation is done
for and the one a window can get wrong.

## Consequences

Three engines run in CI, so the claim decays the day one of them breaks rather than the
day somebody checks. That costs a browser download step in `.github/workflows/ci.yml` and
`playwright` in devDependencies — by a distance the largest thing in there, pinned exactly
because the matrix quotes the build numbers its browsers report.

The published page is longer and less flattering than a list of names. It prints the build
of each engine, the machine, the policy, and what every step actually observed; it prints
that no screen reader has been run; and it prints that one journey is one path and every
other screen in the application is proved on Chrome alone.

Two limits are now written down rather than discovered. Keyboard focus in a windowed table
can only reach rows the window rendered, so moving backwards stops at the first rendered
row instead of pulling earlier rows in — inherent to
[ADR-0107](0107-a-window-bounds-what-a-table-renders.md), and the journey moves forward and
claims nothing else. And a passing engine is the build named in the matrix, not every
version of it.

One defect was found by writing this. `MovementsPage.rows` was a getter that built a new
array on every read, which a window reads as a different list and answers by putting the
scroll position back at the top — so ticking a checkbox sent the reader to row one and took
focus with it. It is a `computed` now. Under pagination the same getter cost only a
recompute, which is why nothing had noticed.

What reopens this: a screen-reader pass. The moment one is recorded in `assistive.json` the
guide stops saying this project makes no assistive-technology claim, and starts saying
exactly which steps were heard, by what, on which day.
