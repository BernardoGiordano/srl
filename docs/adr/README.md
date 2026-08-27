# Decision records

Why the code is shaped the way it is, one decision per file, each with a number that
never changes.

Source comments say what a line does and why *that line* is the way it is. They do not
carry the narrative of how a decision was reached — the alternative that was tried, what
it cost, what changed. That narrative is here, and a comment reaches it by number:

```js
// Deepest-first, so the specific question reaches the user first. ADR-0004.
```

The number is the whole interface. Files may be renamed and retitled, this directory may
be reorganised, and the citation still resolves — which is what a README section number
does not do, and why nothing in `source/` cites one.

`npm run docs:adr` checks that every record is well formed and every citation resolves.
`npm run docs:adr:write` regenerates the table below. Start a new record from
[the template](0000-template.md).

<!-- generated:adr-index -->

| Record | Decision | Status | Affects |
|---|---|---|---|
| [ADR-0001](0001-element-defaults-in-their-own-cascade-layer.md) | Framework element defaults ship in their own cascade layer | accepted | `source/lib/core/elements/element-defaults.js`, `source/lib/core/navigation/router.js` |
| [ADR-0002](0002-a-navigation-is-one-transaction.md) | A navigation is staged and committed as one transaction | accepted | `source/lib/core/navigation/router.js` |
| [ADR-0003](0003-navigation-failure-is-state.md) | Navigation failure is state, not a rejected promise | accepted | `source/lib/core/navigation/router.js` |
| [ADR-0004](0004-routes-are-flattened-at-configuration-time.md) | Routes are flattened at configuration time | accepted | `source/lib/core/navigation/router.js` |
| [ADR-0006](0006-formnode-is-an-interface.md) | FormNode is an interface, not a base class | accepted | `source/lib/core/forms/` |
| [ADR-0007](0007-a-disabled-field-keeps-its-value.md) | A disabled field keeps its value in the form's payload | accepted | `source/lib/core/forms/field.js`, `source/lib/core/forms/group.js` |
| [ADR-0008](0008-form-values-are-converted-at-the-service-boundary.md) | Form values keep the control's own type, and convert at the service boundary | accepted | `source/lib/core/forms/field.js`, application services |
| [ADR-0009](0009-a-form-arrays-dirty-baseline-is-its-row-keys.md) | A form array's dirty baseline is its row keys | accepted | `source/lib/core/forms/array.js` |
| [ADR-0010](0010-manifest-admission-is-one-whole-document-decision.md) | Manifest admission is one whole-document decision | accepted | `source/lib/core/remotes/manifest-policy.js`, `tools/checks/verify-deps.mjs` |
| [ADR-0011](0011-formcontrol-is-a-duck-typed-contract.md) | FormControl is a duck-typed contract, not a base class | accepted | `source/components/inputs/form-control.js`, `source/components/inputs/ui-field.js` |
| [ADR-0012](0012-every-manifest-url-is-same-origin.md) | Every manifest URL is a same-origin root-relative path | accepted | `source/lib/core/remotes/manifest-policy.js` |
| [ADR-0013](0013-one-http-client-with-an-injected-transport.md) | One HTTP client in the library, with the transport as a parameter | accepted | `source/lib/core/http/client.js`, `source/lib/auth/session-fetch.js`, application services |
| [ADR-0014](0014-compiled-templates-are-cached-per-url.md) | A compiled template is cached per URL and its strings array is never rebuilt | accepted | `source/lib/core/template/template.js` |
| [ADR-0015](0015-one-synchronous-preference-boundary.md) | One synchronous persistence boundary for non-auth preferences | accepted | `source/lib/core/preferences/persistence.js`, `tools/checks/verify-deps.mjs` |
| [ADR-0016](0016-a-remote-reaches-the-shell-only-through-its-host-context.md) | A remote reaches the shell only through its mount-scoped host context | accepted | `source/lib/core/remotes/mfe.js`, `source/lib/host/remote-host.js` |
| [ADR-0017](0017-remotes-share-dependencies-by-url-identity.md) | Remotes share the shell's dependencies by URL identity | accepted | `source/lib/core/remotes/mfe.js`, `app.manifest.json`, `index.html` |
| [ADR-0018](0018-binding-scopes-keep-their-identity.md) | A binding scope keeps its identity for the life of its host or row | accepted | `source/lib/core/template/template.js` |
| [ADR-0019](0019-a-projecting-component-renders-synchronously.md) | A projecting component renders synchronously on connect | accepted | `source/lib/core/elements/signal-element.js`, `source/lib/core/elements/projection.js` |
| [ADR-0020](0020-projection-takes-every-node-including-anchors.md) | Projection takes every authored node, anchors and whitespace included | accepted | `source/lib/core/elements/projection.js` |
| [ADR-0021](0021-a-token-store-authorizes-a-request.md) | A token store authorizes a request and never returns a credential | accepted | `source/lib/auth/session.js`, `source/lib/auth/types.d.ts`, `example/src/auth/` |
| [ADR-0022](0022-the-refresh-is-single-flight-per-session.md) | The single-flight refresh is per-session state | accepted | `source/lib/auth/session.js` |
| [ADR-0023](0023-a-token-response-is-rebuilt-not-validated.md) | A token response is rebuilt field by field, or refused | accepted | `source/lib/auth/session-policy.js` |
| [ADR-0024](0024-auth-failures-are-terminal-or-transient.md) | An authentication failure is either terminal or transient, never both | accepted | `source/lib/auth/session-policy.js`, `source/lib/auth/session.js` |
| [ADR-0025](0025-dpop-defeats-token-theft-not-xss.md) | DPoP is adopted to defeat token theft, and does not close XSS | accepted | `example/src/auth/dpop-store.js` |
| [ADR-0026](0026-remote-grants-are-least-privilege-not-a-sandbox.md) | Remote grants are least privilege, not a sandbox | accepted | `source/lib/host/remote-host.js` |
| [ADR-0027](0027-default-remote-host-wiring-lives-in-host.md) | The default REMOTE_HOST wiring lives in `host/`, not in `core/` | accepted | `source/lib/host/runtime.js`, `source/lib/core/application/runtime.js` |
| [ADR-0028](0028-ui-field-projects-the-callers-control.md) | `ui-field` projects the caller's control rather than rendering one | accepted | `source/components/inputs/ui-field.js` |
| [ADR-0029](0029-the-modal-is-a-native-dialog.md) | The modal is a native `<dialog>` | accepted | `source/components/overlays/ui-dialog.js` |
| [ADR-0030](0030-a-dialog-asks-rather-than-closes.md) | Escape and a backdrop click ask to close, they do not close | accepted | `source/components/overlays/ui-dialog.js` |
| [ADR-0032](0032-runtime-dependencies-are-vendored-and-pinned.md) | Runtime dependencies are vendored and integrity-pinned, never fetched from a CDN | accepted | `source/lib/vendor/`, `tools/delivery/vendor.mjs`, `tools/checks/verify-deps.mjs` |
| [ADR-0033](0033-the-library-publishes-its-own-interface.md) | The library publishes its own interface; the repository keeps only repository facts | accepted | `source/package.json`, `cli/package/interface.mjs`, `cli/layout.mjs` |
| [ADR-0037](0037-a-benchmark-result-carries-its-environment.md) | A benchmark result carries the environment that produced it | accepted | `tools/benchmark/` |
| [ADR-0038](0038-the-project-model-parses-an-ast.md) | One project model, parsed from an AST, that refuses to guess | accepted | `cli/project-model/`, `cli/checks/`, `tools/checks/` |
| [ADR-0039](0039-the-template-checkers-compiler-is-cached.md) | The template checker keeps one compiler per process | accepted | `cli/checks/template-check.mjs` |
| [ADR-0041](0041-production-html-is-a-transform-not-an-edit.md) | Production `index.html` is a transform, not a hand edit | accepted | `cli/delivery/production-html.mjs` |
| [ADR-0042](0042-the-template-bundle-is-per-application.md) | The template bundle is per application and derived from the project model | accepted | `cli/delivery/bundle-templates.mjs` |
| [ADR-0043](0043-benchmarks-are-normalised-by-reference-workloads.md) | Benchmarks are normalised by two fixed reference workloads | accepted | `tools/benchmark/browser/calibration.js`, `tools/benchmark/measure.mjs` |
| [ADR-0044](0044-a-regression-must-be-relatively-and-absolutely-large.md) | A regression must be both relatively and absolutely large, and the gate reads the median | accepted | `tools/benchmark/measure.mjs`, `tools/benchmark/budgets.json` |
| [ADR-0045](0045-the-benchmark-drives-chrome-directly.md) | The benchmark drives Chrome directly and blocks the network without disabling the cache | accepted | `tools/benchmark/browser.mjs`, `tools/benchmark/browser/support.js` |
| [ADR-0063](0063-a-remote-shares-the-stack-not-the-state.md) | A remote shares the stack, never the shell's state | accepted | `example/remotes/billing/`, `example/remotes/analytics/` |
| [ADR-0065](0065-the-session-guard-sits-on-one-shell-route.md) | The session guard sits on one shell route; scope guards are affordances | accepted | `example/src/routes.js`, `example/server/api.mjs` |
| [ADR-0066](0066-the-registry-consumer-gets-bundles.md) | The registry consumer gets bundles; the browser consumer still gets source | accepted | `source/package.json`, `tools/delivery/package-bundle.mjs`, `cli/package/interface.mjs`, `tools/checks/verify-deps.mjs` |
| [ADR-0067](0067-the-toolchain-is-a-second-package.md) | The toolchain is a second package, pinned to the first | accepted | `cli/package.json`, `cli/layout.mjs`, `cli/package/interface.mjs`, `source/package.json`, `package.json` |
| [ADR-0068](0068-the-installed-shape-is-checked-by-installing.md) | The installed shape is checked by installing, and the type table ships with the library | accepted | `tools/checks/pack-check.mjs`, `source/tsconfig.base.json`, `cli/bin/srl.mjs`, `cli/checks/importmap-check.mjs`, `tools/checks/verify-deps.mjs` |
| [ADR-0069](0069-the-dev-server-proxies-the-backend.md) | The development server proxies the backend, so the application develops on one origin | accepted | `cli/dev/serve.mjs`, `cli/bin/srl.mjs`, `cli/test/serve-proxy.test.mjs` |
| [ADR-0070](0070-a-production-template-is-minified-and-proved-equivalent.md) | A production template is minified, and the minified bytes are proved equivalent | accepted | `cli/delivery/template-html.mjs`, `cli/delivery/build.mjs` |
| [ADR-0071](0071-a-built-template-is-fetched-by-the-component-that-needs-it.md) | A built template is fetched by the component that needs it | accepted | `cli/delivery/build.mjs` |
| [ADR-0072](0072-a-check-returns-diagnostics.md) | A check returns diagnostics, and prints nothing | accepted | `cli/diagnostics/`, `cli/checks/`, `tools/checks/` |
| [ADR-0073](0073-the-application-shape-is-a-module.md) | The application shape is a module, and `srl new` is one of its two adapters | accepted | `cli/scaffold/application.mjs`, `cli/bin/srl.mjs`, `tools/checks/pack-check.mjs`, `cli/README.md` |
| [ADR-0074](0074-the-artifact-report-is-a-named-shape.md) | The artifact report is a named shape, written and read in one place | accepted | `cli/delivery/artifact-report.mjs`, `cli/delivery/build.mjs`, `cli/delivery/release.mjs`, `cli/delivery/remote-release.mjs`, `cli/delivery/verify-http.mjs`, `tools/benchmark/run.mjs` |

<!-- /generated:adr-index -->

## Writing one

State the rejected alternative by name. A record that only says what was chosen leaves
the next reader to rediscover why the obvious other thing is wrong, which is the work the
record exists to save.

State what would reopen it. A decision with no reopening condition gets reopened by
accident, in a review, by someone who cannot tell a settled question from an unexamined
one.

Supersede rather than delete. A record whose decision no longer holds gets
`Status: superseded by ADR-NNNN` and stays where it is, because the citations in source
still point at it and the reasoning is still the reason the successor exists.
