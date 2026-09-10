# ADR-0102: A container rule has an element of its own

- Status: accepted
- Date: 2026-09-09
- Affects: `source/lib/core/forms/group.js`, `source/lib/core/forms/array.js`, `source/lib/core/forms/validators.js`, `source/lib/core/forms/types.d.ts`, `source/components/inputs/ui-form-error.js`, `source/components/inputs/ui-field.js`, `example/src/pages/sales/customer-detail-page.js`, `example/src/pages/sales/customer-detail-page.html`, `example/server/api.mjs`, `example/test/customer-form.test.js`

## Context

`@core/forms` had validators on fields and nowhere else. The reason recorded in
[position-and-non-goals.md](../position-and-non-goals.md) was never that the computation was
hard — a rule over a group's value is a function from an object to a code, and the group
already builds that object for `values`. It was that the answer had nowhere to go. Every
error the library could produce was shown by `ui-field`, `ui-field` is a label and a
projected control, and "the end day may not precede the start day" is under neither of the
two controls it is about.

The example server states the same problem from the other side. `validateContacts` reports
its over-the-limit rule as `contacts`, and the comment beside it says a code against the
array itself is "true and useless — there is no control on the screen for 'the contacts'".
`FormGroup.applyErrors` agrees and hands such a path back as unmatched.

So the missing piece was a place, not a computation.

## Decision

**A container takes validators over its own value.** `group(fields, validators)` and
`fieldArray(create, initial, validators)`, both taking the same `Validator<T>` a field
takes, over `{ [K in keyof F]: ValueOf<F[K]> }` for a group and `ValueOf<C>[]` for an
array. `ordered`, `sameAs`, `minRows`, `maxRows` and `uniqueBy` join the standard set; their
codes join the `ui.field.*` vocabulary, because a code is a code whether the rule was about
one value or several.

**`ui-form-error` shows it.** A new collection element bound to a node, rendering
`visibleError` as a `role="alert"` paragraph and resolving the code through `messages` then
standard text, exactly as `ui-field` does. It has no control, no label, no projection and no
`aria-describedby`.

**`invalidPath` answers `''` for the container itself.** The contract already documented
that answer and no node had ever given it. `focusInvalidField` therefore reads
`invalidPath` rather than `firstInvalid`: the two disagree on exactly one value, since
`firstInvalid` says `''` both for a valid form and for a form whose own rule failed.

**A member that is invalid on its own wins.** Both `invalidPath` and the focus go to the
control, not to the sentence about the form. A cross-field rule evaluated over a
half-filled form is noise, and the specific answer is the better place to send someone.

**The timing rule is submitted, or every member touched.** A field shows its error once it
has been left; a combination has no single control to leave, so every member standing in for
one blur is the nearest true statement. Disabled members are skipped, or one switched-off
control would keep the message off the screen for good. An empty container counts as
untouched, which is what keeps `minRows(1)` off a form nobody has filled in yet.

**`FormNode` grows by three: `touched`, `pending` and `visibleError`.** A container computes
the first two from its members and cannot do it through a narrower contract.
[ADR-0006](0006-formnode-is-an-interface.md) predicted the cost of the interface shape and
this is it: three small implementations, and a typecheck error rather than a silent gap if
one drifts.

**Rejected: teaching `ui-field` to take a container.** Almost all of `ui-field` is control
wiring — the projection query, the blur listener, the value write-back, the disabled
property, `aria-describedby`. Every line of it would be dead for a group, and the element
that already carries [ADR-0028](0028-ui-field-projects-the-callers-control.md)'s
responsibilities would carry a second shape as well.

**Rejected: a validator that names the member to display it.** It keeps everything in the
existing display path and works for `ordered('start', 'end')`. It has no answer for
`minRows(1)`, where the rule is about the list and no row exists to hold the message.

**Rejected: a path-qualified return type.** Letting a validator answer
`{ path: 'contacts.1.email', code: 'duplicated' }` would put a client-side duplicate under
the row that repeats — the same address a 422 carries. It also needs a third error source on
`FormField`, a path each leaf knows about itself, and a re-push on every array reshuffle,
because a row's path changes when the row above it is removed. `applyErrors` already places
a code by path, already clears it on edit, and is already the call a 422 goes through. A
screen with a client-side row rule calls it.

**Rejected: a server error on a container.** `setServerError` still answers `false` from
both containers, so the example server's `contacts: tooMany` is still reported as unmatched.
Accepting one would mean deciding which edit below a container clears it, which is a rule
this change does not need.

## Consequences

`docs/known-gaps.md` loses its "no validator that runs over a group or an array" entry and
`position-and-non-goals.md` loses that clause from the reactive-forms row. Neither loses the
sentence about `contacts.1.email`, because per-row placement is still `applyErrors`.

`COLLECTION_TAGS` in `tools/test/frozen-interface.test.mjs` gains `ui-form-error`, which is
the frozen-name decision this change makes.

`focusInvalidField` walks `ui-field, ui-form-error` and compares `name` rather than running
one `querySelector`, because the path may be the empty string and `[name=""]` matches every
unnamed element of both tags. The container element is duck-typed there for the reason
[ADR-0011](0011-formcontrol-is-a-duck-typed-contract.md) gives.

A container with no validators keeps a constant where the computed would be. A computed over
`values` subscribes every reader of `valid` to every keystroke in every member, which is
what `FormGroup.values` is a getter to avoid, and an unruled container gains nothing for it.

The example screen is the first caller. `uniqueBy('email')` on its contacts array and a
`<ui-form-error name="contacts">` beside the rows are the whole of it, and the suite asserts
that a refused submit sends nothing, blames no row and puts focus on the message.

The same suite asserts the seam under it. `uniqueBy` compares the values as typed and the
example server folds case before comparing, so two addresses differing only in case pass the
client and clash at the server, which places its answer under `contacts.1.email` by path. A
client-side rule is a courtesy that saves a round trip when it fires; the server stays the
authority, and a screen whose two rules must agree exactly has to write the folding itself.

**What would reopen it:** a screen whose client-side rule is about one row of a set —
"this contact repeats the one above" answered without a round trip. `applyErrors` places it
under the right control and the edit that answers it clears it, but nothing re-runs the rule
while the user types, so a duplicate created against a *different* row goes unreported until
the next submit.
