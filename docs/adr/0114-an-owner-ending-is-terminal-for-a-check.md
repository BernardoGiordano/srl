# ADR-0114: An owner's end is terminal for a field's check

- Status: accepted
- Date: 2026-09-12
- Affects: `source/lib/core/forms/field.js`, `source/lib/test/forms/async-validation.test.js`

## Context

[ADR-0103](0103-a-field-owns-its-asynchronous-check.md) gave the field four things to own:
the debounce, the supersession, the memory of the value already answered for, and the
lifetime. Three of them were terminal — the next keystroke really did end the check before
it — and the fourth was only half of one.

An owner that ended aborted the request and stopped there. `AbortSignal` is a request, not
an enforcement: a validator that passes the signal to `fetch` stops, and a validator that
ignores it keeps going, which is a shape an application is free to write and a third-party
client is free to have. The field kept that check as the current one, so the abandoned
request still owned `asyncError`, and `pending` stayed true.

Two failures follow, both observable in a probe rather than argued from the code. A
validator that ignored the abort and resolved late wrote its code into a field whose screen
was gone. A validator that never settled at all left `pending` true forever, and
`whenSettled()` is a promise over `pending` — so the submit in the documented two-line shape
never reached its second line.

The debounce window had the same hole from the other side. The owner listener was registered
when the request started, so an owner that ended during the quiet window was not noticed
until the timer fired, and the field was pending for the rest of the window for a check
nobody wanted.

## Decision

**An owner's end ends the check, not just the request.** The field aborts the request with
the owner's reason, then makes the transition itself: the request stops being the current
one, the timer is dropped, the listener is removed and `pending` goes false.

**A check is bound to its owner from the keystroke, not from the request.** The listener is
registered when the check is scheduled, so an owner that ends during the debounce window
ends the check in it. Both removals ADR-0076 asks for are kept — the request's own signal
for a check that is aborted, an explicit release for one that settles.

**An abandoned check leaves the value unchecked.** No answer is recorded for it, because
none was received. The alternative — writing the empty code, which is what the
already-aborted path did before this — has the field remember an answer it never got, and a
field whose owner comes back would then skip the check that value still owes.

**A waiting caller is released rather than held.** `whenSettled()` resolves once the
abandoned check stops being pending. A promise that never settles is not a safer answer than
one that does: it is a submit handler suspended for the life of the page, holding its form,
its values and everything its closure reached.

**Rejected: keep the field pending until the validator settles.** It is the honest reading
of "an answer is owed" and it cannot be made to terminate, because the thing owing the
answer has already been asked to stop and declined. Every caller that awaits `whenSettled()`
pays for one uncooperative validator.

**Rejected: report an abandoned field invalid.** It would make the resumed submit refuse
itself, which is the outcome a leaving screen wants. It also gives the field a fourth state
that only an edit can clear, and nothing edits a field whose owner is gone — a form on a
`lifetime` its application aborted for its own reasons would be permanently unsubmittable
with no control to correct. The field reports what it knows: no code, nothing pending, and
no answer owned.

## Consequences

`#abandonCheck()` is the terminal transition, and it is `#cancelCheck()` plus forgetting the
checked value — the same two steps `reset()` already took, under a name that says which end
of the lifetime called it. `#runCheck` no longer reads the lifetime or registers anything;
it is the loop over the validators and the three ways it can end.

The lifetime is still read per check rather than held, because an element's is a new signal
after every re-attach. A field handed `() => this.lifetime` that kept the first one would
refuse to check anything after a move.

A screen is still responsible for what it does after an `await`. The field guarantees that
waiting on it ends and that nothing it abandoned writes anything; it does not decide whether
a submit that was in an `await` when its screen left should still send. The example's
customer form re-reads its own state after `whenSettled()` for exactly that reason, and that
line is a screen's, not the framework's.

A row removed from a `fieldArray` while its check is out is not cancelled and does not need
to be. The array drops the entry, so `pending`, `valid` and `invalidPath` stop counting it,
and the answer arrives to a node nothing holds. The suite asserts that from the form's side.

`source/lib/test/forms/async-validation.test.js` covers the four cases from outside the
class: an abort during a request with a validator that ignores it, an abort during the
debounce window, the value left unchecked and asked about again under a new lifetime, and
the listener the lifetime is left with. Three of them fail against the previous
implementation.

**What would reopen it:** an owner that ends and comes back while the *same* check is in
flight — a suspended screen rather than a destroyed one. Nothing in the library has that
lifetime shape today, and the field would have to distinguish "the owner is gone" from "the
owner is away" to answer it.
