# ADR-0093: One Element model preserves authored meaning

- Status: accepted
- Date: 2026-09-08
- Affects: `cli/project-model/`, `cli/checks/template-check.mjs`, `cli/language-server/`

## Context

The project model reduced an Element's reactive declaration to `properties: string[]`
and `observedAttributes: string[] | null`. That lost meaning before a consumer could use
it. A Lit property carrying `state: true` appeared as public input, inherited declarations
and static getters disappeared, and an unresolved parent became the same empty array as a
class that deliberately declared no inputs. The language server and checker then had no
shared source for custom event payloads or the projection buckets rendered by
`<x-content>`.

The rejected alternative was to reconstruct each missing fact in each consumer. That
would give completion, diagnostics, hover and documentation separate interpretations of
the same class and repeat the disagreement ADR-0038 removed from tag discovery.

## Decision

The existing project model resolves Element meaning after every JavaScript and `.mjs`
module has been parsed. A registered class inherits reactive properties and dispatched
events from local or imported parent classes. Static fields and static getters are the
same declaration form at this seam; a subclass entry replaces a same-named parent entry.

Each reactive declaration retains its source class and position, public-input,
internal-state or unknown kind, and observed attribute mapping. `properties` remains the
sorted public-input projection for consumers, while `state` is available for the owning
Element and documentation. `surfaceKnown` distinguishes a complete surface from known
fragments of a dynamic declaration. Unknown options, inheritance or attribute mappings
remain unknown rather than becoming empty.

The model also records events an instance dispatches. Literal names and literal-union
helper parameters are resolved; detail is represented only when syntax provides a safe
description: an instance property, a primitive type, an object key set, no detail, or
unknown. The template checker uses that metadata to type `CustomEvent.detail`, and the
language server uses the same records for completion and hover. Native event types remain
the DOM library's responsibility.

Projection names come from parsing each claimed external template and collecting its
`<x-content>` markers. Empty string denotes default projection. A dynamic name or an
unreadable template is null, not an empty list. Editor completion offers named buckets on
a child's `slot` attribute from its nearest parent Element.

## Consequences

Internal Lit state is no longer suggested to callers. Inherited and getter declarations
produce the same checker and editor surface as field declarations. Property navigation
can use the retained declaration, custom event handlers receive known detail types, and
named projection is discoverable while authoring caller markup.

The model remains conservative. It does not evaluate JavaScript, infer arbitrary detail
expressions, or claim completeness for computed event names and runtime-built options.
Known facts remain useful beside an explicit incomplete marker.

Parsing templates adds one local parse per rendered Element during model construction.
No consumer reparses those templates for projection metadata, and all consumers keep the
same model identity until live analysis reloads it.

Reopen this decision if the runtime adopts decorator or TypeScript authoring, publishes
an explicit custom-element manifest, or changes projection away from `<x-content>`.
