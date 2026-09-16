# Architecture map

## Glossary

These terms describe the boundaries used throughout the guide.

| Term | Meaning here |
|---|---|
| **Module** | An implementation behind one interface |
| **Interface** | Everything callers and tests must know: exports, configuration, ordering, errors and performance characteristics |
| **Depth** | How much behaviour and leverage sit behind an interface |
| **Seam** | A place where behaviour can vary without editing the caller |
| **Adapter** | A concrete implementation satisfying an interface at a seam |
| **Leverage** | What each caller gains from one implementation |
| **Locality** | Change, knowledge, bugs and verification concentrated in one place |
| **Element** | A custom element defined with `defineComponent` |
| **Application** | Any root directory holding an `index.html`; the tools discover them |
| **Remote** | A separately deployed micro-frontend, admitted by `app.manifest.json` |

## The dependency rule

```
application  ->  components  ->  { host }  ->  { core, auth }
                                                 auth -> core
```

Dependencies point in one direction. `core/` never imports `auth/`. The remote
module asks the injector for `REMOTE_HOST`, and `host/runtime.js` installs the
default provider. An application can replace that provider with its own policy
without changing core.

`npm run verify` also rejects application imports inside `source/`. This keeps
the published library independent of the example application.

## Replaceable boundaries

Each row shows the interface and the implementations that exercise it. Some
boundaries have one production implementation and a test adapter.

| Seam | Interface | Adapters |
|---|---|---|
| UI preference storage | `configurePreferences({ storage })`, `createMemoryStorage()` | browser `localStorage`, memory, a write-counting spy in the table suite |
| Collection standard text | `configureCollectionText({ resolve })` | the message table (default), an application resolver, the suites' dictionary |
| Auth token storage | `TokenStore` in `auth/types.d.ts`, built against `auth/session-policy.js` | supplied by the application: `example/src/auth/` carries three (`MemoryTokenStore`, `BffCookieTokenStore`, `DpopTokenStore`). The library ships none, because a store is where a backend's endpoints and field names live |
| Dependency injection | `token()`, `provide()`, `inject()` | every service an application or a suite provides |
| Template grammar and DOM sinks | `core/template/dialect.js` | the runtime compiler and the static template checker |
| Table row matching | `ui-table.filterPredicate` | the built-in matcher and an application predicate |
| Remote host context | contract in `core/remotes/mfe.js`, adapter `createRemoteHostProvider()` | one shipped adapter plus the fakes in three suites. Load-bearing at one: the seam exists to keep `core/` from importing `auth/` |
| Outbound HTTP transport | `new ApiClient(baseUrl, { fetch })` in `core/http/client.js` | `sessionFetch` (the signed-in path, in `auth/`), a remote's `host.auth.fetch`, and the recorded transport in the library suite. Same reason as the row above: the client is `core/` and the session is not |
| Reactive primitives | `@core/foundation/reactive.js` | one, the vendored `@preact/signals-core`. One on purpose: the module is the replacement point for the day signals change, and `vendor/provenance.json` names it as the only importer |

## Where to change X

| Change | File |
|---|---|
| The template grammar, a directive, an attribute-to-sink mapping | `source/lib/core/template/dialect.js` |
| What a binding expression may say | `source/lib/core/template/expression-parser.js`, `expression.js` |
| Sanitisation or a Trusted Types policy | `source/lib/core/template/security.js` |
| How a tag, class and template relate | `source/lib/core/elements/component.js` |
| Which markup an Element's stylesheet reaches | `source/lib/core/elements/style-scope.js` — the one rewrite the browser, the build and the project model share; `stylesheet.js` adopts it during source delivery |
| How anything is put on screen on demand | `source/lib/core/elements/mount.js` |
| Route matching, guards, child routes, link interception | `source/lib/core/navigation/router.js` |
| The order of application startup | `source/lib/core/application/runtime.js` |
| What a remote may do | `source/lib/core/remotes/mfe.js` (contract), `source/lib/host/remote-host.js` (adapter) |
| Where a UI preference is stored | `source/lib/core/preferences/persistence.js` |
| How an application talks to its API | `source/lib/core/http/client.js` (the client), `source/lib/auth/session-fetch.js` (the authorized transport) |
| Locale negotiation, plurals, formatters | `source/lib/core/localization/i18n.js` |
| Staleness, abort and failure state of one asynchronous read | `source/lib/core/foundation/resource.js` |
| Identity, refresh and reader lifetime of the example's shared order | `example/src/state/order-records.js` |
| The collection's own strings | `source/components/internal/text.js` |
| What "filtered" means | `source/components/data/filter-descriptor.js` |
| The mounts `/lib/`, `/components/` and the specifiers they serve | `source/package.json` — the library declares them; `cli/package/interface.mjs` reads them for the dev server, the test runner, the benchmark origin and the delivery tooling |
| How a URL becomes a file, and what may answer a request that has none | `cli/origin/index.mjs` — mounts, the traversal refusal, the directory index and the history fallback; the dev server, the benchmark origin, the artifact test origin and the test runner's rewrite are adapters over it |
| Which directories are applications, and where the repository's root is | `cli/layout.mjs` |
| What a saved file does to a page that is already open | `cli/dev/updates.mjs` owns the watching, the URL identity and the delivery; `cli/dev/update-client.js` decides whether a change is a template revision, a component stylesheet revision, a stylesheet swap or a reload |
| What a correct srl application is made of | `cli/scaffold/application.mjs` — the nine files `srl new` writes; `tools/fixtures/installed-layout.mjs` owns the declared dependency set its installed adapters use |
| What static discovery knows about the project | `cli/project-model/` |
| How public inputs, internal state, inherited declarations, events and projection names become one Element | `cli/project-model/parse.mjs`, resolved by `cli/project-model/index.mjs` |
| What a message is, which bundle answers for a file, and whether a reference resolves | `cli/message-catalog/` — the verifier, `cli/checks/message-check.mjs` and the editor are adapters over it |
| How an editor consumes the project model and template checker | `cli/language-server/`; editor launchers live under `editors/` |
| What one editor session owns, and when it starts, stops or restarts | `editors/vscode/session.cjs`; the watchers it needs are registered by `cli/language-server/server.mjs` |
| How an incomplete editor template becomes context, scope, typed members and edit ranges | `cli/language-server/semantics.mjs` |
| Which authoring form a document is written in, what each editor feature may ask of it, and the binding syntax the answer is written in | `cli/language-server/authoring.mjs` — one view over an external srl template or a module's inline Lit templates |
| A dependency or layering rule | `tools/checks/verify-deps.mjs` |
| Whether an application's import map still matches the library it installed | `cli/checks/importmap-check.mjs` — the one check a consumer runs, because the failures are blank pages |
| What tsc has to know to resolve `@core/` | `source/tsconfig.base.json` — published, extended rather than copied, resolves into the declaration tree; `source/tsconfig.source.json` resolves the same prefixes into the source for this repository |
| Whether the published tarballs work when installed | `tools/checks/pack-check.mjs` — runs a real npm install from declared dependencies, scaffolds through the local bin, checks, commits and builds |
| Whether an installed editor does what the plugins claim | `tools/conformance/` — installs the packed extension into a real editor and drives one scenario list through it |
| A performance budget | `tools/benchmark/budgets.json` |
