# Architecture map

## Glossary

The document uses these words precisely:

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

One direction only, and `core/` never imports `auth/`. That is not aesthetic:
`core/remotes/mfe.js` needs a capability object built from the session and gets it by
asking the injector for `REMOTE_HOST`, which is what lets `host/remote-host.js` be
replaced wholesale by an application with a different capability policy. The default
installation of that provider therefore lives in `host/runtime.js`, not in
`core/application/runtime.js`: a default at the core layer would import `auth/`
transitively and collapse the seam it exists to hold open.

`npm run verify` fails if any file under `source/` imports `@app/…` or names an
application directory. In this repository example is always present, so that mistake
would otherwise stay invisible until the library was used somewhere else.

## The seams, and what proves each one

A seam with one adapter is a hypothetical; two make it real. Where only one exists,
the reason is recorded in the module that owns it.

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
| How anything is put on screen on demand | `source/lib/core/elements/mount.js` |
| Route matching, guards, child routes, link interception | `source/lib/core/navigation/router.js` |
| The order of application startup | `source/lib/core/application/runtime.js` |
| What a remote may do | `source/lib/core/remotes/mfe.js` (contract), `source/lib/host/remote-host.js` (adapter) |
| Where a UI preference is stored | `source/lib/core/preferences/persistence.js` |
| How an application talks to its API | `source/lib/core/http/client.js` (the client), `source/lib/auth/session-fetch.js` (the authorized transport) |
| Locale negotiation, plurals, formatters | `source/lib/core/localization/i18n.js` |
| The collection's own strings | `source/components/internal/text.js` |
| What "filtered" means | `source/components/data/filter-descriptor.js` |
| The mounts `/lib/`, `/components/` and the specifiers they serve | `source/package.json` — the library declares them; `cli/package/interface.mjs` reads them for the dev server, the test runner, the benchmark origin and the delivery tooling |
| Which directories are applications, and where the repository's root is | `cli/layout.mjs` |
| What static discovery knows about the project | `cli/project-model/` |
| A dependency or layering rule | `tools/checks/verify-deps.mjs` |
| A performance budget | `tools/benchmark/budgets.json` |
