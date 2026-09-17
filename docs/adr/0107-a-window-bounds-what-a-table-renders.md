# ADR-0107: A window bounds what a table renders

- Status: accepted
- Date: 2026-09-10
- Affects: `source/components/data/ui-table.js`, `source/components/data/ui-table.html`, `source/components/test/data/table.test.js`, `tools/benchmark/workloads.mjs`, `tools/benchmark/budgets.json`, `docs/guide/collection.md`

## Context

`ui-table` rendered one `<tr>` per row it was given, in every mode. `pagination="client"`
and `"server"` bounded that with a page size, but `"none"` and `"infinite"` did not:
`visibleRows` returned everything supplied and the template rendered all of it. Infinite
loading is the one that reads like virtualisation and is not, because it accumulates rows
into a
list that only grows, so the DOM grows with the dataset and the scroll gets heavier the
longer the user reads.

The cost was already on the record. `collection/table-full-render-10000` renders 10,000
rows and 40,000 cells in 468.9 ms with 131.7 MB of heap resident, and
`collection/table-reorder-10000` moves the same rendered list in 318.9 ms
([the performance envelope](../guide/performance.md)).

Row virtualisation was nonetheless recorded as a non-goal, and the reason given was not
that 468.9 ms is acceptable. It was that no budget existed for
it to fail: a duration with nothing to compare it against is a number, not a verdict, and
`budgets.json` gated no timing at all
([ADR-0044](0044-a-regression-must-be-relatively-and-absolutely-large.md),
[ADR-0096](0096-the-editor-latency-claim-is-a-workload-not-an-assertion.md)). The stated
condition for reopening was "a timing budget is set and the table misses it".

## Decision

**A frame is the budget.** A table that a user is scrolling has 16 ms to produce its next
paint, so 16 ms is what `collection/table-window-10000.render` is gated on as a product
limit, absolute and uncorrected for machine speed. The unwindowed 10,000-row render misses
it by a factor of twenty-nine. That is the trigger the non-goal named, and it is now
written down rather than assumed, which is the part that was missing.

The two windowed workloads measured 2.60 ms and 1.70 ms on a local run of the same machine
the baseline came from, with 38 of the 10,000 rows in the DOM. That run is reported rather
than gated, because Chrome had moved from 151 to 152 so its environment profile is not the
baseline's. That is exactly the standing
[ADR-0099](0099-a-performance-claim-carries-its-standing.md) asks a claim to carry. What it
shows is a limit with room in it: 2.60 ms against 16 ms leaves a machine six times slower
still passing, and the 468.9 ms it replaces failing either way.

**The window decides what is rendered and nothing else.** `visibleRows` still means the
rows on this page, and it is what the selection, the status line, `aria-rowcount` and the
query are all measured against. `renderedRows` is the slice of it the DOM holds. Every
question the row template asks, whether the key, the selected state or the record to
activate, is asked with `rowIndexAt(offset)` rather than with the loop index, because a
window renders row 8,412 in slot 3. Nothing about a windowed table's public behaviour
differs from an unwindowed one except how much DOM exists.

**It is opt-in, because it makes three promises the table cannot check.** `virtualized`
asserts that the rows are uniform in height, that the table is its own scroller, and that
fixed column layout is acceptable. A table that guessed at these would be wrong on the
screens that wrap a cell to two lines, and wrong invisibly, because the scrollbar would
simply stop agreeing with the content.

**Two rows hold the scroll extent.** A spacer `<tr>` above and below carries the height the
unrendered rows would have occupied, so the scrollbar describes the whole page rather than
the window. They are `aria-hidden`, and the rows that are rendered carry `aria-rowindex`
against an `aria-rowcount` covering the whole page, which is the ARIA answer to a table
whose DOM is a window: assistive technology reads "row 8,413 of 10,000" from a tbody
holding sixty rows.

**The height comes from a rendered row, not from the attribute.** `row-height` is the
estimate the first paint uses. After that the table measures a real row and recomputes,
because a spacer sized from a declaration the screen's padding disagrees with is a
scrollbar that lies. The measurement converges: it moves the window, the render that
follows measures the same number, and it stops.

**Focus keeps its kind and moves to the nearest surviving row.** A scroll that unmounts
the focused row would otherwise drop focus to `document.body`, which puts the user outside
the table. A focused row becomes the edge row of the new window; a focused selection
checkbox becomes that row's checkbox. The recovery focuses with `preventScroll`, or
focusing the row would scroll it into view, move the window, and recover again.

**In `infinite` mode the window asks for the next page.** A bounded scroller puts the
load-more sentinel permanently below the fold, where an intersection observer either never
fires or fires forever, so the observer stands down while `virtualized` is set and the
window requests more when it comes within the overscan of the last loaded row.

**A new page opens at its first row.** A page, sort or filter change is a different list,
and leaving the scroller where it was would open it two thousand rows down. Rows arriving
in `infinite` mode are deliberately not on that list: that is the same list getting
longer.

**Rejected: turning the window on automatically past some row count.** The three promises
above are the screen's to make. A table that switched to fixed layout and a bounded
scroller at 500 rows would change how a screen looks because its data grew, which is a
worse surprise than an attribute nobody set.

**Rejected: a scroll helper beside the table.** Windowing is not separable from row
identity, selection scope, focus, the header and the column widths, and every one of those
had to change. A helper that owned the viewport arithmetic and left the table to
coordinate the rest would be the shallow module this decision exists to avoid.

**Rejected: a virtualisation adapter seam.** One table and one option panel are not two
consumers. A specialist grid still belongs behind an adapter, for an application that wants
a whole advanced grid suite.

## Consequences

`ui-table` gains `virtualized`, `row-height` and `viewport-height`, plus `renderedRows`,
`rowIndexAt()` and the aria and spacer accessors the template reads. The scroller carries
a `scroll` listener and a `ResizeObserver`, both released in `onDestroy` beside the
intersection observer that was already there.

`visibleRows` is now cached on the same inputs `#pageSelection` uses. A render asks for it
once per selection question and once per piece of window arithmetic, and in `client` mode
each of those was a fresh `slice`.

A windowed table lays out `table-layout: fixed` and sticks its header to the top of its own
scroller. Declared column widths therefore matter more on a windowed table than on an
unwindowed one, where the browser sizes columns from content it can all see.

`collection/table-window-10000` and `collection/table-window-scroll-10000` are declared and
absent from `baseline.json`, so the guide lists them among its coverage gaps. Recording
them means a `--ci` run with `--update-baseline` on a settled machine, which rewrites every
entry and is a deliberate act rather than a side effect of this change.

No example screen adopts `virtualized`. This capability arrived under the budget trigger
rather than under a screen that needed it, and that is the one place it departs from how
everything else in the collection was built.

**What would reopen it:** a screen whose rows are not uniform in height. The window
arithmetic is one multiplication, and a variable-height list needs a measured offset per
row and a different data structure to hold it. That is a second implementation, not a
parameter on this one.
