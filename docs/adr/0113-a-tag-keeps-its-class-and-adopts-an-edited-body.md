# ADR-0113: A tag keeps its class and adopts an edited body

- Status: accepted
- Date: 2026-09-11
- Affects: `source/lib/core/elements/component.js`, `source/lib/core/elements/signal-element.js`, `source/lib/core/diagnostics/types.d.ts`, `cli/dev/update-client.js`, `source/lib/test/elements/revision.test.js`, `source/lib/test/fixtures/revisable-component.js`, `cli/test/serve-updates.test.mjs`, `docs/guide/performance.md`, `docs/position-and-non-goals.md`, `docs/reference/source-layout.md`

## Context

An edited `.html` file is rendered into the hosts already showing it
([ADR-0111](0111-an-edited-template-revises-the-page-rendering-it.md)) and a linked
stylesheet is swapped in place ([ADR-0112](0112-a-development-update-names-what-changed.md)).
A `.js` edit still reloaded the page, and the stated reason was that
`customElements.define()` is permanent.

That reason is true and it is not the whole answer. It says a *tag* cannot be given a
second class. It does not say the class it already has cannot be changed, and the class is
where most of an edit lands — an event handler, a computed getter, an `onMount` body, a
`render()` override. Reloading for those costs what a reload always costs here: the form
comes back empty, the store fetches again, the route has to be walked back to.

Three platform facts bound what is possible, and all three are about identity rather than
about behaviour.

A registry rejects a repeated name, so the constructor a tag holds is the one it was
defined with, and a route, an outlet target, a remote entry and every element already in
the document hold that object. The module map keys an entry by URL, so an edited file is
only evaluated again under a URL it has not been evaluated under, and re-importing it does
not hand its importers new bindings. And a constructor cannot be run again on an element
that already exists, so field initialisers — the ordinary way a component here holds state
— run once per instance, from the class the registry has.

Private names are the sharpest form of the third. A class body evaluated a second time
mints private names of its own, so `#total` in the edited file is not `#total` in the class
on screen. A method adopted from the edited class would read a field no live element
carries, and it would throw at the first render rather than at the edit.

## Decision

**The tag keeps its class, and the class adopts the edited body.**
`reviseComponentModule(url)` imports the edited module again and, for each component it
declares, installs the fresh class's own prototype members and own statics on the class the
registry holds. A host already on screen and an element created a minute later then run the
same code, which is the property a replacement has to have and an instance swap does not.

**The revision query goes on the edited module and nowhere else.** `?srl-revision=<n>` is
what gets past the module map. The re-evaluated module's own imports still name the URLs
the rest of the page holds, so one module is duplicated rather than a graph and dependency
identity stays what [ADR-0017](0017-remotes-share-dependencies-by-url-identity.md) says it
is. The query is also the signal itself: `defineComponent` reads it to tell a redeclaration
from the identity collision it otherwise refuses, and every other consumer sees the
normalised URL, so a revised module's template is still the one URL the page fetched.

**Identity is checked before anything is written.** `assertReplaceable` refuses a changed
base class, a changed template, a changed `uses`, a changed reactive property, a changed
field and any private name, and each refusal names what changed. Nothing is installed until
every rule has passed, so a refused edit leaves the page exactly as it was and the adapter
answers it with the reload it would have done anyway.

**Fields are compared by building an element from each class.** Reading source cannot say
what an initialiser produces. Both classes are constructed as the registered tag —
`Reflect.construct` with the registered class as `new.target` is what makes a class the
registry does not hold constructible at all — and neither element is inserted. Names are
compared because a field the edit added would be `undefined` on every element, existing and
future alike; primitive values are compared because a changed initialiser is an edit a live
page could never show. Anything else is left alone, since a signal or a resource differs
between any two instances and says nothing about the edit.

**Declared reactive properties are skipped in both directions.** Their prototype entries
are the accessor pairs Lit generated at `finalize`, each reading a storage key of its own,
and the attribute list behind them was snapshotted by the registry at `define` time.
Replacing an accessor would leave every live host's value behind it, which is why a changed
`static properties` is refused rather than re-finalised.

**The host names its own cause.** `SignalElement.renderRevisedDefinition()` sets
`cause: 'definition'` and asks for a render, for the reason
[ADR-0109](0109-an-update-reports-why-it-happened.md) gives and by the same method call
ADR-0111 uses. Live hosts are found by walking the document rather than by keeping a
registry of them, also as in ADR-0111, and matched with `instanceof` rather than by tag, so
a component subclassed to tweak behaviour renders too.

**Rejected: replacing the live instances instead of the class.** An instance built from the
edited class carries its fields and its private names, and `Reflect.construct` can build
one. It fixes the page for exactly as long as nothing creates another element: the registry
still holds the old constructor, so the next route visit, the next `*for` row and the next
child in revised markup are all old-class instances. A replacement that is true only of the
elements standing still is worse than a reload, because it is wrong quietly.

**Rejected: registering a shell class and delegating to the current implementation.** It is
the one shape that would survive a private field, and it taxes every component in every
page, production included, to serve an event that only happens in development. It also
moves what a component *is* away from the class the author wrote, which is the thing this
module exists to keep exact.

**Rejected: patching the prototype and letting a private field fail at render.** The throw
is real, deterministic and catchable, and it arrives after the render has begun. A refusal
that is read before anything is written costs a reload; one discovered mid-render costs a
half-patched document and a reload.

**Rejected: a revision query throughout the dependency graph.** Re-importing the edited
module under a new URL is one duplicated module. Doing it to its imports as well would give
one dependency two evaluations and two singletons, and shared URL identity is the rule
remotes rely on (ADR-0017).

**Rejected: scoped custom element registries.** A second registry would make a repeated
name legal, and this framework renders into light DOM
([ADR-0020](0020-projection-takes-every-node-including-anchors.md)), so there is no scope
to attach one to. It is also newer than the browsers this is tested against.

## Consequences

`reviseComponentModule` is marked `@internal`, so it stays out of the bundle's flat
namespace ([ADR-0077](0077-a-module-declares-which-exports-are-the-door.md)) and the
development adapter reaches it by path, exactly as it reaches `reviseTemplate`.

`byModule` holds definitions strongly, one entry per component, in every page. It retains
nothing new: `customElements.define` retains every registered class for the life of the
page anyway.

A component that keeps state in private fields is not replaceable, and most of the pages in
the example application do. That is a real limit and it is stated rather than worked
around: `#summary = resource(...)` is a field, and a field is what a constructor installs.
The components that are replaceable today are the ones whose state is public — the shared
UI collection, and any page written that way.

An edit is evaluated twice when it is refused, because the refusal is found while the
module body is running. A component module here declares a class and ends with
`defineComponent`, so the second evaluation is a class expression and a rejected promise.
A module with side effects of its own would run them again, and then reload.

A component module that also exports something other than its component — a helper, a
constant — hands the new version only to the class in that file. Its other importers keep
the binding they have, because nothing can rehand an ES module export. That is the same
fact that makes a `.js` file declaring no component a reload, and it is why the answer to
a refusal is always the whole page.

`sameFields` constructs two elements per revised component. Their constructors run, so a
constructor that injects a service or opens a subscription does so once more per edit, in
development, on an element that is never connected and never rendered.

**What would reopen it:** a component that has to keep private state across an edit, which
is a shell class and a tax on production, or a platform that lets a class body be replaced
in place. Carrying DOM-held state — focus and scroll first — which ADR-0111 names for
markup and which applies here for the same reason. Or a second consumer of revisions, at
which point `renderRevisedDefinition` becomes a seam rather than a method call.
