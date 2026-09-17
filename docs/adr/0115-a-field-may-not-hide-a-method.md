# ADR-0115: A field may not hide a method

- Status: accepted
- Date: 2026-09-12
- Affects: `source/lib/core/elements/signal-element.js`, `cli/project-model/parse.mjs`, `cli/project-model/index.mjs`, `cli/project-model/types.d.ts`, `tools/checks/verify-deps.mjs`, `source/lib/test/elements/signal-element.test.js`, `cli/test/project-model.test.mjs`, `cli/test/fixtures/project-model/app-a/src/hidden-member.js`

## Context

`render = 'state'` in a component class body is legal JavaScript, and it is fatal.

A class field is installed with [[Define]], not [[Set]]. It creates an *own* data property
on the instance, which covers `SignalElement.prototype.render` instead of overriding it.
`defineComponent` accepts the class, `customElements.define` registers it, the element
connects, and then Lit calls `this.render()` on a string. The error names `render`, which
the author did in fact write, and points at a line inside Lit, which they did not.

The same shape breaks `updated`, `willUpdate`, `performUpdate` and `requestUpdate`, and it
is not a lifecycle-only fault. Any field that covers any callable member breaks every call
that would have reached the method.

`SignalElement` already meets the same [[Define]] trap on a different member.
`#adoptShadowedFields` repairs a field that covers a *reactive property*, where the covered
member is an accessor pair Lit generated at `finalize`. That one is repairable, and has to
be: the field is how the shape is written, every Lit example puts `open = false` next to
`static properties`, and deleting the own property uncovers the accessor so the value
survives and reactivity starts working. A method cannot be repaired that way. There is
nothing to hand the value back to, because the author asked for a string where a function
has to be, and no rearrangement makes both true.

Neither tool that reads an element could see it. `defineComponent` never looks at
instances, and `cli/project-model/` read only static members, so a field was invisible to
the static model that the language server and `npm run verify` both consume.

## Decision

**A field that covers a callable member is refused, and the refusal names both.** Two
tools answer it, from the two kinds of evidence available to them.

**The runtime answers from an instance, on connect.**
`SignalElement.connectedCallback` runs `#assertNoHiddenMembers` immediately after
`#adoptShadowedFields`, before `super.connectedCallback()` and therefore before the first
render. Every own data property whose value is not a function is looked up along the
prototype chain, and the first prototype carrying that name decides: a function there is a
hidden method and throws; an accessor there is a reactive property and is left alone.
Once per class, cached in a `WeakSet` keyed by the constructor and added only after the
class passes, so a broken class reports itself on every instance rather than on the first.

**The static model answers from the source, at the line that declared the field.**
`parse.mjs` records the instance methods and fields each class declares under its own name.
`index.mjs` resolves methods across inheritance the way it already resolves reactive
properties, and reports a field that covers one as a `project/shadowed-lifecycle` diagnostic
with a line and a column. `npm run verify` and `srl check` fail on it, and the language
server publishes it while the file is open, which is where an author actually meets it.

**A field whose value static analysis cannot follow is a warning, never an error.**
`refresh = chosen` may well be a function. Reporting a working component as broken is how
a diagnostic teaches authors to ignore it, so the model says what it saw and what it could
not resolve, in keeping with the explicit unknown states of
[ADR-0093](0093-one-element-model-preserves-authored-meaning.md).

**Every member, not a list of lifecycle names.** Hiding a callable member behind a value
breaks whichever member it is, and a list of blessed names would go stale the first time a
base class grew a method. The one list that exists is `ROOT_METHODS` in `index.mjs`: the
methods a class inherits from a root the walk stops at, which is `HTMLElement`,
`LitElement` and `ReactiveElement`. This model does not parse them, and they are published,
stable interfaces. A method an element declares itself is read from its source.

**A callable field is not a collision.** `render = () => ...` covers the method and works,
so it is accepted by both tools.

**Rejected: refusing inside `defineComponent`.** That is where the check belongs and it
cannot run there. A class extending `HTMLElement` is not constructible until
`customElements.define` has run on it, so the one instance that would answer the question
cannot exist before the definition is complete, and a definition that registers a tag and
then throws leaves the registry holding a class nothing returned.

**Rejected: reading the class source at definition time.** `String(element)` is already how
`assertReplaceable` finds private names, and the comment on `PRIVATE_NAME` says why it is
safe there: over-matching costs a reload, and a reload is always correct. Here
over-matching costs a refused component that would have worked. A regular expression cannot
tell a field declaration from `render = fn` inside a method body, so admission would rest
on a guess about a class the author wrote correctly.

**Rejected: catching it in `render()` and reporting it there.** The message improves and the
timing does not. By then the element has connected, Lit has begun an update, and the
author is still reading a stack inside the framework. The connect-time throw is the last
point before any of that.

## Consequences

An author who writes the trap now gets one of two messages naming the field, the method it
covers and the two ways out, and gets the static one before the page ever loads.

The runtime check costs one pass over the own keys of one instance per class, in
production as well as development. A page defining eighty components pays eighty short
loops, once, at the connect of each first instance, rather than per element, which is what
a windowed table with a thousand rows would have made expensive.

A model diagnostic carries a `line` and a `column` when it is about one declaration, and
null for both when it is about a whole file. The JSON projection emits the same.

The static check sees fields and not constructor assignments. `this.render = 'x'` creates
the same own property and is caught only by the runtime: following an assignment through a
constructor body means deciding what a value is, which is the guess
[ADR-0038](0038-the-project-model-parses-an-ast.md) keeps this model out of.

A field with a computed or private name is skipped statically for the same reason it is
skipped everywhere else in the model: a name no tool can spell is one no tool should
report a collision for. The runtime sees the resolved name and catches it.

**What would reopen it:** a legitimate reason to shadow an inherited callable with a value,
which would turn the rule into an opt-out rather than a refusal. A base class outside
`ROOT_METHODS` that the walk stops at, which would need an entry there rather than a new
mechanism. Or full type information in the model, which would resolve `refresh = chosen`
and turn today's warning into an answer.
