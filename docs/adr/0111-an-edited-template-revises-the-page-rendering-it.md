# ADR-0111: An edited template revises the page that is rendering it

- Status: accepted
- Date: 2026-09-11
- Affects: `source/lib/core/template/template.js`, `source/lib/core/elements/signal-element.js`, `source/lib/core/diagnostics/types.d.ts`, `source/lib/test/template/revision.test.js`, `docs/guide/performance.md`, `docs/position-and-non-goals.md`, `docs/reference/source-layout.md`

## Context

Component-level hot replacement is a non-goal here, and the stated reason is that
`customElements.define()` is permanent and a reload re-fetches one file. That reasoning
holds for JavaScript. It does not hold for markup, and the two had been refused together.

A `.html` file is the file a developer edits most while working on a screen, and a reload
costs far more than the request it saves. The page comes back with an empty form, a store
that has to fetch again, a dialog closed, a table scrolled to the top and a route that has
to be walked back to. None of that is the edit; all of it is thrown away by it. The reload
is a rounding error in milliseconds and is not a rounding error in what it destroys.

Nothing in the framework could have done better on its own. Clearing the URL cache is not
enough, because `attachTemplate` copies the compiled template onto the *class*. A cleared
cache leaves every live host rendering the compile it already has, and
`SignalElement.render` is synchronous and cannot wait for a fresh one. No reverse lookup
existed either — the module could answer "what does this class render" and had no way to
ask which classes, or which live elements, render a given URL.

Two invariants stood in the way, both deliberately. A compiled strings array is never
rebuilt, because lit keys its parsed template on that array's identity
([ADR-0014](0014-compiled-templates-are-cached-per-url.md)). A binding scope keeps its
identity for the life of its host, because rebuilding it per render rebuilds every
binding's effect ([ADR-0018](0018-binding-scopes-keep-their-identity.md)). Both are rules
about a page in use, and an edit to markup is by definition a different template.

## Decision

**One call, in the module that owns all four moving parts.** `reviseTemplate(url, source)`
compiles the edited file, writes the source cache, the compiled cache and every class
attachment, and asks the live hosts to render. The source cache, the compiled cache, the
class attachment and the inheritance walk are private to
`@core/template/template.js`, and a revision has to move all four together or leave the
page rendering a mixture of two versions.

**Committed only after the compile succeeds.** An editor saves a file mid-thought and a
watcher is quick enough to catch it half-written. Markup that does not compile throws and
changes nothing, so the screen keeps the revision it had instead of blanking.

**A published revision beats bytes still in flight.** An edit can land while the first
request for that template is open, and that request resolves afterwards carrying the file
as it was. `fetchAndCompile` therefore publishes the revision rather than compiling what
arrived. Compiling it would attach markup the developer has already replaced, and would
also hand one URL a second strings array — two hosts of one template rendering from
different parsed templates for the rest of the session, which outlives the edit that
caused it.

**The new strings array is the mechanism, and the exception is named.** ADR-0014 forbids
rebuilding an array because a rebuild silently converts every render into a DOM rebuild. A
markup edit *wants* that rebuild, and a new array is exactly how lit is told to perform
one. The exception is this one call, on the development path, once per edit. Every other
writer of the compiled cache is unchanged, which is what keeps the invariant checkable.
`attachTemplate` still compiles once per URL, and a page nobody is editing never reaches
the revision path at all.

**Live hosts are found by walking the document.** The alternative is a registry of
connected hosts, which costs a set entry on every connect and disconnect in every page,
production included, to serve an event that only happens in development. The walk costs
nothing until an edit arrives, and it finds subclasses for free because `templateFor` is
the same inheritance walk a render does. The walk does not descend into shadow roots and
does not need to, because a component renders into light DOM
([ADR-0020](0020-projection-takes-every-node-including-anchors.md)).

**The host names its own cause.** `SignalElement.renderRevisedTemplate()` sets
`cause: 'template'` and asks for a render, because the render path that knew why is the
only one allowed to say so ([ADR-0109](0109-an-update-reports-why-it-happened.md)). It is
a method the template module calls rather than a handler the element registers, because
one consumer is not a seam and a registration would be a second way to reach the same
object.

**Rejected: replacing the element.** A fresh instance loses the fields, the signals and
the subscriptions that are the entire reason not to reload. It is a reload, scoped to one
tag, and it is what a reload already does better.

**Rejected: a registry of live hosts keyed by URL.** Above. It moves a development cost
into every production connect and disconnect.

**Rejected: clearing the caches and letting the next render re-fetch.** There is no next
fetch. The compiled template is attached to the class, nothing re-attaches it, and the
render that would need it is synchronous.

**Rejected: a revision query string on the template URL.** One template would hold two
cache entries and two compiled arrays, and a URL is shared dependency identity here
([ADR-0017](0017-remotes-share-dependencies-by-url-identity.md)). The cache is keyed by
URL precisely so that a prefetch and an attach agree, and a revision that changed the key
would break that agreement to avoid writing one map entry.

**Rejected: a generic hot-module seam.** A published protocol for "some module changed"
would be a shallow module with one caller, and it would have to be designed before the
JavaScript half is understood. Markup replacement is a complete answer on its own, and the
JavaScript question stays where it is, in the non-goals.

## Consequences

`reviseTemplate` is marked `@internal`, so it stays out of the bundle's flat namespace
([ADR-0077](0077-a-module-declares-which-exports-are-the-door.md)). The development
adapter reaches it by path, the way `cli/checks/template-check.mjs` reaches the dialect.
An application has no reason to call it, and a name in the door reads as a promise.

`attachedByUrl` holds element classes strongly. That retains nothing new in practice:
`customElements.define` retains every one of them for the life of the page.

ADR-0018's scope identity gets the same scoped exception. A revision is a new compiled
template and therefore a new scope per host, so each binding rebuilds its effect once per
edit, which is a cost measured in an edit rather than in a render.

What survives an edit is the host — its fields, its signals, its subscriptions, its
injected services, its place in the document, and the authored children it projects, which
are moved rather than recreated
([ADR-0019](0019-a-projecting-component-renders-synchronously.md)). What does not survive
is what the old DOM held — focus, scroll position, an open `<details>`, a value typed into
an uncontrolled input — and the instances of any child components the markup declares,
which are constructed again with the new nodes.

Nothing in the repository calls this yet. The development server still reloads the whole
page on any change; delivering the edit to the browser — the watcher that keeps the
changed file's identity, the session that batches a multi-file save and the adapter that
routes an `.html` edit here and everything else to a reload — is the piece that follows,
and until it lands this is reachable only from a test.

**What would reopen it:** JavaScript replacement, which is a question about element
identity rather than about markup and is still a non-goal. A need to carry DOM-held state
across an edit, focus and scroll first, which would mean recording it before the render
and restoring it after. Or a second consumer of revisions — an editor preview rendering a
template it is not serving — at which point the notification becomes a seam rather than a
method call.
