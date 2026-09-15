# ADR-0032: Runtime dependencies are vendored and integrity-pinned

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/vendor/`, `tools/delivery/vendor.mjs`, `tools/checks/verify-deps.mjs`

## Context

A buildless application resolves bare specifiers through an import map, and a CDN is the obvious target. It failed in practice. jsDelivr's `/+esm` build of `@vaadin/router` pulled in three more modules, one at a caret range, and jsDelivr advises against Subresource Integrity on generated files. A graph like that can't be pinned, so nobody can know what runs tomorrow. The router in this repository is hand-written as a result.

Vendoring without hashes only swaps an uncontrolled CDN for a folder anyone with commit access can edit.

## Decision

Runtime dependencies are committed under `source/lib/vendor/`, served from the same origin and pinned by integrity hash in every import map. `npm run vendor` fetches and verifies them. `npm run verify` fails on:

- an undeclared bare specifier
- a cross-origin import map entry
- a vendored file without a hash
- a `node_modules` version that differs from the vendored copy

The last check matters most. `tsc` reads `node_modules` and the browser reads `source/lib/vendor`, and without the check the types could describe an API the browser doesn't have.

## Consequences

- The bytes that run are the bytes that were reviewed, and changing them shows up in a diff.
- Upgrading a dependency is a deliberate step with verification.
- The CDN checks stay even though no map points at a CDN today, because adding one back is a one-line change.
