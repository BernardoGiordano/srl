# ADR-0103: A field owns its asynchronous check

- Status: accepted
- Date: 2026-09-09
- Affects: `source/lib/core/forms/field.js`, `source/lib/core/forms/settled.js`, `source/lib/core/forms/group.js`, `source/lib/core/forms/array.js`, `source/lib/core/forms/types.d.ts`, `source/components/inputs/ui-field.js`, `example/src/pages/sales/customer-detail-page.js`, `example/src/services/sales-service.js`, `example/server/api.mjs`, `example/test/customer-form.test.js`

## Context

Some rules cannot be answered on the client. Whether an address is already registered is a
question for the server, and the example server answers it with `email: taken` in a 422.
`applyErrors` puts that under the control, `setValue` clears it on the next edit, and the
round trip happens at submit time.

That works and it is late. The user fills in nine fields, submits, and is sent back to the
second one. Asking while they type is the same question earlier, and what stopped it was
never the request. It was the four things around the request that a screen would have to
write for every such field: a debounce, so a keystroke is not a fetch; a supersession, so
the slowest answer does not win; a memory of the value already answered for, so a re-render
does not ask twice; and a lifetime, so a check outlives neither its screen nor its use.

Those are the same four `resource()` owns for a read ([ADR-0076](0076-an-asynchronous-read-is-a-resource.md)),
and they are not a form's four. A resource re-runs on demand and holds a value; a check runs
because a value changed and holds a code.

## Decision

**`field(initial, validators, { async, debounce, lifetime })`.** An `AsyncValidator<T>` is
`(value, signal) => Promise<string>` — a `Validator` that takes the abort signal and answers
later. Nothing else about writing one differs, and the library ships none of them, because
every such rule needs a service, an endpoint and a payload that belong to an application.

**The field owns the debounce, the supersession, the memory and the lifetime.** 300 ms of
quiet by default. The next keystroke aborts the check in flight and a superseded answer is
dropped rather than written. The value a settled answer describes is remembered, so a
control re-emitting an unchanged value costs nothing. `lifetime: () => this.lifetime` binds
the request to its owner, and the abort listener is dropped on every terminal path — the
listener rule ADR-0076 exists for, with a second holder here.

**A check runs only once every synchronous rule has passed.** A malformed address is not
worth a round trip, and "already taken" under a value the user has not finished typing is
the wrong sentence for the wrong reason. It also means the two error sources never collide:
precedence is the server's code, then the synchronous rules, then the asynchronous one.

**A check never runs for the value the field was built with, or for one a `reset` installed.**
Both came from the server. A form opened on a saved customer would otherwise report that
customer's own address as taken.

**A rejection is not an invalid value.** A check that could not run has found nothing wrong;
the field reports no code and the write decides. Same refusal as `resource()`'s, which does
not turn a rejection into a value either.

**`pending` is a third state and it is not valid.** A pending node is not known to be
acceptable, and the alternative — reporting it valid — is precisely how an unchecked value
reaches the server. It is true through the debounce window as well as the request, so a
submit that waits on it does not slip through the quiet gap between a keystroke and the call
it causes. It is false while the field is disabled, whichever switch turned it off, because a
form that disables itself to save must not be held up by an answer it would ignore.

**`markSubmitted()` stays synchronous, and `whenSettled()` is what waits.** The documented
submit becomes two lines:

    await this.form.whenSettled();
    if (!this.form.markSubmitted()) return void focusInvalidField(this, this.form);

**Rejected: an asynchronous `markSubmitted()`.** One call, impossible to get wrong, and it
changes `FormNode` for all three classes and rewrites every call site in the repository and
the docs. The synchronous answer is also still the right one for a form with no asynchronous
rule, which is most of them.

**Rejected: pending counts as valid, and the screen disables its submit control.** No new
method, no await, nothing existing to change — and a submit fired during a check goes
through with a value nobody has verified. The failure is silent and lands on the server.

**Rejected: the validator debounces itself.** The field would only supersede. Every
application-written check would then repeat the timer and the abort wiring, which is the
duplication `@core/forms` exists to absorb — the same argument the nine-field measurement in
`known-gaps.md` makes for the rest of the layer.

**Rejected: reusing `resource()`.** It re-runs on demand and holds a settled value, where a
check re-runs because a value changed and holds a code; `pending` there starts true and
means "nothing has settled", where here it means "an answer is owed". Two shapes, one
lifetime discipline, which is copied rather than shared.

## Consequences

`whenSettled(pending)` in `core/forms/settled.js` is one function over a signal, and each of
the three classes exposes it as a method over its own `pending`. `FormNode` carries
`pending` so a container can aggregate it; it does not carry `whenSettled`, which is
derivable from the signal.

A field written to through `field.value.value` rather than `setValue` schedules no check, the
same hole `serverError`'s clear-on-edit already has. `setValue` is what screens are told to
call and what `ui-field` calls.

An in-flight check is not cancelled when a *container* switches its members off, because a
group's disabled state reaches a field as a signal and not as a call. `pending` is false
while disabled and the settled code is ignored, so nothing waits and nothing shows; the
request simply finishes.

`source/lib/test/forms/async-validation.test.js` asserts each of the four owned behaviours
against a hand-settled promise, and the settled-check-leaves-no-listener case through
`instrumentedAbort`.

The example screen is the first caller. Its email field asks
`GET /api/customers/email-available` while the user types, which is the same uniqueness rule
the save path enforces, and the 422 is still what decides. The suite asserts the four owned
behaviours from outside: nothing is asked inside the quiet window, nothing is asked for a
malformed address or for one a load installed, and a submit fired in the same breath as a
keystroke waits rather than sending an unchecked value.

The suite also pays the cost. Its helper for filling the form now settles the check it
starts, and the values it writes are numbered, because a case that saves leaves a customer
behind and the next case would be told its own suite's record is the clash. A screen that
asks the server about a value makes every test that fills that value asynchronous.

**What would reopen it:** a rule that is asynchronous and about a *set* of values — an
availability check over a whole field array. Container validators are synchronous, and
nothing here extends `pending` to a rule a container owns.
