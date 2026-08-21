# ADR-0009: A form array's dirty baseline is its row keys

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/forms/array.js`

## Context

Nested groups and field arrays were a non-goal with a stated trigger: a screen that needs
a repeating row. One did — a customer's contacts, three fields per row, up to five rows,
with a uniqueness rule across the rows that only the server can answer.

Unlike the flat form that came before it, the alternative was not built first. The frictions were
already known from the nine-field version, and rebuilding them at one more level of depth
would have measured the same seven things again. So this is a cost, not a comparison, and
it is recorded as one. Counted as non-blank, non-comment lines — a shade stricter than the
counting used for the flat form, so compare within this table and not across it:

| | Before | After |
|---|---|---|
| `@core/forms` | 218 | 396 |
| `customer-detail-page.js` | 294 | 341 |
| `customer-detail-page.html` | 215 | 286 |

The 178 lines in the library are `array.js` (129) and the recursion the containers needed
(49, split between `field.js` and `group.js`). The 118 in the screen are one `fieldArray`
declaration, four getters and two methods for the add and remove controls, the value
mapping in both directions, and 71 lines of markup for a three-field row with its own
label, error and remove control. Per row of a repeating group that is about the same 14
lines a field cost in the flat version, which answers whether the abstraction survives one
more level: it does, at the same price.

The array's own hard question is what "changed" means for a list. The rows answer for
their own values. What only the array can answer is whether the *shape* changed, and
comparing lengths is not enough: remove one contact, add another, and the length is back
where it started while the data is not. That is exactly the case an unsaved-changes guard
exists for.

## Decision

The dirty baseline is the list of row keys, not the row count. Keys are never reused, so
an add-then-remove of the same row is genuinely clean and a remove-then-add is genuinely
not.

A row created after `markSubmitted` does not inherit visible errors. Three red messages
under a row the user just asked for is the greeting the timing rule in `FormField` exists
to prevent; the next submit marks it like everything else.

## Consequences

`FormNode` came out of this unchanged (ADR-0006) — the third node kind cost nothing but
answering the same questions, which was the check on whether the interface was the right
shape.

A stable key per row is now required of anything that builds rows, which is also what a
keyed `*for` needs to avoid re-rendering the whole list, so the requirement was already
there and is now named.

Reopen the missing group-level validator when a rule about a set of rows can be decided by
the client. The question then is where it is displayed, not how it is computed.
