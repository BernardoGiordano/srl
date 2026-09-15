# ADR-0111: Development edits update the running page

- Status: accepted
- Date: 2026-09-11
- Affects: `source/lib/core/template/template.js`, `source/lib/core/elements/signal-element.js`, `cli/dev/updates.mjs`, `cli/dev/update-client.js`, `cli/dev/serve.mjs`, `example/server/static.mjs`

## Context

Developers edit `.html` files more than anything else, and a full reload throws away form contents, fetched data, open dialogs, scroll position and the current route.

Clearing the template cache isn't enough. `attachTemplate` copies the compiled template onto the class, and `SignalElement.render` is synchronous. The dev server also only ever sent the word `reload`, with no filename and no way to recover messages missed during a reconnect.

## Decision

`cli/dev/updates.mjs` owns the update session, and both development servers use it. It watches the mounts, names each change by the URL the browser fetched it from, batches a multi-file save into one message and streams batches from `/__updates`. Each batch carries an id of the form `<session>.<n>`. A reconnect with `Last-Event-ID` gets a replay, or `{"reload":true}` when the id belongs to an earlier process or has aged out.

`cli/dev/update-client.js` decides what each change does.

| Change | Action |
|---|---|
| `.html` | `reviseTemplate(url, source)` |
| `.css` owned by an Element | `reviseStylesheet` (ADR-0119) |
| Linked `.css` | Swap the stylesheet |
| `.js` that declares components | `reviseComponentModule(url)` (ADR-0113) |
| Anything else, or any refusal | Reload |

A single reload in a batch reloads the whole batch.

`reviseTemplate` compiles the edited file and commits only if the compile succeeds. It then updates the source cache, the compiled cache and every class attachment, and asks live hosts to render. A revision wins over a response still in flight for the same URL. Hosts are found by walking the document, which costs nothing until an edit arrives. The new strings array is the one sanctioned exception to ADR-0014.

## Consequences

- A host keeps its fields, signals, subscriptions, services and projected children across a markup edit.
- State held by the DOM, such as focus, scroll and uncontrolled input values, is lost, and child components are rebuilt.
- `reviseTemplate` and `reviseComponentModule` are `@internal`, and the development client reaches them by path.
- Directory events and the scratch files of atomic saves (`*.tmp`) are ignored.
- Carrying focus and scroll across an edit would reopen this.
