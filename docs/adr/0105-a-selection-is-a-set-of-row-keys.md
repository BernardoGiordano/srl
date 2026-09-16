# ADR-0105: A selection is a set of row keys

- Status: accepted
- Date: 2026-09-10
- Affects: `source/components/data/ui-table.js`, `source/components/data/ui-table.html`, `source/components/internal/text.js`, `source/components/test/data/table.test.js`, `source/components/test/standard-text.js`, `example/src/pages/settings/settings-users.js`, `example/src/pages/settings/settings-users.html`, `example/i18n/en.json`, `example/i18n/it.json`, `docs/known-gaps.md`

## Context

`ui-table` already owned row identity, the query, and every transition between one query
and the next. It had no selection, so a screen wanting to suspend six accounts at once had
to keep its own set of chosen rows and then reconcile that set against every transition the
table performs without asking: a sort that reorders the page, a page change that swaps the
rows out, a filter that removes some of them, a reload that replaces the array. Each of
those is a rule the caller has to get right, and each of them is decided inside the table.

The reason no selection existed was not oversight. `docs/known-gaps.md` recorded it as
deliberately unbuilt, because the word "selection" hides a question the table cannot
answer on its own. Does choosing rows mean the current page, the rows loaded so far,
or every record matching the query, including the ones on the server that this browser has
never seen. Building the checkbox before answering that question produces an interface that
means something different in each of the four pagination modes.

The Settings screen supplies the missing case. Suspending accounts one at a time is the
write the screen already had; doing it to several at once is the workflow that fixes what
the selection has to mean.

## Decision

**A selection is a set of row keys.** Not positions, not row objects. Keys survive the
transitions the table performs, where sorting reorders, paging slices and filtering
removes, so none of them needs code to preserve the selection and none of them can silently
move it
onto a different record.

**The scope is the rows the table has been given, and it says so.** `selection-change`
carries `{ keys, rows, scope: 'loaded' }`. `rows` is the loaded rows behind those keys and
may be shorter than `keys` on a server table, which holds one page of a collection it never
sees all of. A screen that means "every matching record" owns that itself and has the query
to do it with; the table never claims it.

**A row the table cannot name cannot be chosen.** Selection reads identity through
`rowKey` and refuses a row that resolves to `null` or `undefined`, rendering a disabled
checkbox. This is deliberately not `keyFor`, whose positional fallback of `page:index`
exists to keep a `*for` keyed when rows carry no id. A position is a fine render key and a
worthless identity: after a sort it names a different record, so a selection built on it
would follow the slot.

**The header acts on the page.** The select-all checkbox chooses every selectable row the
user can currently see, clears them when all are chosen, and reads indeterminate when the
page is mixed. A wider action, such as every loaded row or every matching record, is a
screen's button, because only the screen knows what it costs.

**Keys are pruned only where the table holds the whole collection.** In `client`, `none`
and `infinite` modes, `rows` is everything, so a key with no row is a row that is gone and
is dropped with a `selection-change`. In `server` mode `rows` is one page, so an absent key
means "on another page" and pruning it would empty the selection on every page change,
which is the one thing keying it exists to prevent.

**Selection is not persisted.** The stored table state holds page, sort and column layout,
which is configuration the user chose for the screen. A selection is a step inside one workflow, and
restoring six checked rows from last week onto a list that has since changed is worse than
restoring nothing.

**Rejected: a `selection="single | multiple"` mode.** A single chosen row is
`interactive` plus `row-activate`, which exists and is what every detail-navigation screen
in the example already uses. Adding a mode would mean a second control shape, radio
grouping, and two meanings for one property, in exchange for a case no screen has.

**Rejected: the table owning the selected rows rather than their keys.** It would have to
hold references to records the consumer may have replaced, which is a second copy of the
list, and comparing them would need an equality rule the table has no basis to pick.
`rowKey` is that rule, declared once, already used for rendering.

**Rejected: a `select-all-matching` affordance.** It reads as one checkbox and is a
server-side authorization question about how many records, under whose scopes, retrieved
how.
The same reasoning defers export in `docs/position-and-non-goals.md`.

## Consequences

`ui-table` gains `selectable`, `selectedKeys`, `rowSelectable`, the `selection-change`
event, and `selectedRows` / `selectionCount` / `clearSelection()` for the screen driving it.
Two standard-text keys, `ui.table.selectAll` and `ui.table.selectRow`, name the two
controls, so the collection still ships no prose.

Shift-click extends from the last row clicked to this one, applying the state that row is
moving to, and steps over rows `rowSelectable` refuses. The anchor is a key, so it survives
a sort and is simply not on the page after a page change, where the range collapses to the
one row clicked.

`activateFromKeyboard` now returns before `preventDefault` when the keypress came from a
control inside the row. The row carries the handler and a keypress in a cell reaches it by
bubbling, so an interactive table was already taking Space away from any button a screen
rendered in a cell; a selection checkbox made it visible.

The page-selection counts are cached on the same inputs `visibleRows` derives from, because
the header asks three questions per render and `pagination="none"` puts every supplied row
on the page.

Settings gains a bulk bar over the accounts table: one PATCH per chosen account, in order,
then one re-read, with the selection left standing after a failure so retrying is a click.
Its `rowSelectable` is a getter rather than a field, because whether a row may be chosen
depends on the session's scopes and on a write being in flight, and the table only re-reads
a property whose identity moved.

**What would reopen it:** a screen that must act on every record matching a query rather
than on the ones it holds. That is a server operation with its own authorization and its
own progress rather than a wider checkbox, and the table would be reporting a selection
it
cannot enumerate.
