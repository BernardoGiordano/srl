# ADR-0081: Templates are delivered by chunk

- Status: accepted
- Date: 2026-09-01
- Affects: `cli/delivery/build.mjs`, `cli/delivery/artifact-report.mjs`, `cli/delivery/source-manifest.mjs`, `source/lib/core/template/template.js`, `source/lib/core/application/runtime.js`, `source/lib/core/remotes/manifest-policy.js`

## Context

A built artifact holds one hash-named, immutable file per template. The open question is when the browser fetches them.

A single JSON bundle of every template is one blocking request, and changing any template invalidates all of it.

Letting each component fetch its own template on demand is slow. `defineComponent` awaits the template before `customElements.define`, so nine components in one chunk make nine round trips in a row. On one deployed application that chain cost 350 ms of a 1,004 ms critical path.

Announcing every template at startup closes the chain, but a visitor on the login page then downloads the markup of the whole application.

The build already knows which chunk holds each component module, and so which templates each chunk needs.

## Decision

Under the default `split` delivery, `app.manifest.json` carries `templateGroups`. The keys are `entry` followed by `chunk:<emitted path>`, and each value lists the template URLs that chunk's modules name. The build fails if a module that names a template belongs to no chunk.

- The `entry` group covers the entry chunk's static closure and the dynamic imports the entry itself makes. Startup step 3 starts it without waiting on it.
- Every other group starts on the first `attachTemplate` from its chunk. A route chunk only evaluates after the router's guards let it load, so markup inherits the access rules that apply to code.
- `prefetchTemplates` only starts transfers into a source cache. Compiling happens in `attachTemplate`, once per component that mounts (ADR-0014). A failed prefetch surfaces where the template is actually needed.
- Admission runs every URL through the same-origin rule (ADR-0010) and flattens the groups into `templateFiles` for consumers.

A deployment can choose one of two other modes.

| `--templates` | Manifest key | Behavior |
|---|---|---|
| `split` (default) | `templateGroups` | Entry group at startup, other groups with their chunk |
| `split-lazy` | `templateFiles: []` | Each component fetches its own template |
| `bundle` | `templateBundle` | One JSON file seeds the cache |

Source delivery has no chunks. `cli/delivery/source-manifest.mjs` fills a flat `templateFiles` from the project model when it serves the checked-in manifest, and startup starts the whole list. A remote's templates are announced on that remote's entry and never on the shell.

## Consequences

- A signed-out visitor fetches only the templates the login screen needs.
- A signed-in visitor fetches templates for the screens they open.
- The first navigation into a chunk pays one extra round trip, because its templates start after the chunk evaluates.
- Split templates carry no Subresource Integrity. They are same-origin and named by content hash.
- If that extra round trip ever costs more than it saves, the fix is for the router to start a group beside the chunk request.
