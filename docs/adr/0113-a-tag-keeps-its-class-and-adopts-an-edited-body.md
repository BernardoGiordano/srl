# ADR-0113: A tag keeps its class and adopts an edited body

- Status: accepted
- Date: 2026-09-11
- Affects: `source/lib/core/elements/component.js`, `source/lib/core/elements/signal-element.js`, `cli/dev/update-client.js`

## Context

`customElements.define()` is permanent, so a tag can never get a second class. The class itself can still change, and most JavaScript edits land in a class body, in a handler, a getter, `onMount` or `render()`.

Three platform facts limit what can change. The registry keeps the original constructor. The module map only evaluates a file again under a new URL. Field initializers run once per instance. Private names are the sharpest case, because a class body evaluated again mints new private names, and an adopted method would read fields no live element has.

## Decision

`reviseComponentModule(url)` imports the edited module again with `?srl-revision=<n>` and installs each fresh class's own prototype members and statics on the class the registry holds. Live hosts and future elements then run the same code.

- Only the edited module gets the query. Its imports keep their URLs, so dependency identity holds (ADR-0017).
- `defineComponent` reads the query as a revision instead of a tag collision.
- `assertReplaceable` refuses a changed base class, template, `uses`, reactive property or field, and any private name. It checks everything before writing anything, so a refusal leaves the page untouched and becomes a reload.
- Fields are compared by constructing an element from each class without inserting either. Names and primitive values must match.
- Reactive property accessors are skipped, because lit generated them at `define` time.
- Hosts are found by walking the document and matched with `instanceof`, and each one renders with `cause: 'definition'`.

Replacing live instances was rejected, because the registry would keep building old ones. A shell class that delegates to the latest implementation was rejected, because it taxes every component in production.

## Consequences

- A component that keeps state in private fields can't be revised and reloads instead. Most pages in the example use private fields.
- A refused edit evaluates the module twice.
- Other exports of an edited module stay stale for their importers, because an ES module binding can't be handed out again.
- Building the two comparison elements runs their constructors once more per edit, in development only.
