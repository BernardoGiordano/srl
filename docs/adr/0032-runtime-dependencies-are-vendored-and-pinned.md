# ADR-0032: Runtime dependencies are vendored and integrity-pinned, never fetched from a CDN

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/vendor/`, `tools/delivery/vendor.mjs`, `tools/checks/verify-deps.mjs`

## Context

A buildless application resolves bare specifiers through an import map, and the obvious
place to point that map is a CDN. It was tried, and it failed on a real dependency:
jsDelivr's `/+esm` bundle for `@vaadin/router` pulled three further modules, one at a
caret range, and jsDelivr's own documentation says not to use Subresource Integrity with
dynamically generated files. There is no way to pin that graph, so there is no way to know
what executes tomorrow. The router in this repository is hand-written as a direct result.

Vendoring without a hash is not the fix on its own. It swaps a CDN nobody controls for a
folder anybody with commit access can edit silently.

## Decision

Runtime dependencies are committed under `source/lib/vendor/`, served same-origin, and
pinned by integrity hash in every import map. `npm run vendor` fetches and verifies them;
`npm run verify` fails on an undeclared bare specifier, a cross-origin entry, a vendored
file with no hash, and a `node_modules` version that differs from the vendored one.

That last check is the sharpest edge in the architecture: `tsc` reads `node_modules` and
the browser reads `source/lib/vendor`, so without it the type checker validates against an
API the browser will not have, and nothing else ties the two together.

## Consequences

The hash is what makes `source/lib/vendor` a control rather than a copy: the bytes that
run are the bytes that were reviewed, and a change to them is a change to a diff.

Upgrading a dependency is a deliberate act with a verification step, rather than something
a CDN can do on a Tuesday.

The CDN checks stay in the verifier even though the maps point only at `/lib/vendor`
today, because re-adding a remote entry is one line and the pinning requirement has to
survive it.
