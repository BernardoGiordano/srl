# Source layout

Two kinds of directory, and the difference is the point: `source/` is the library and may
not know an application exists; everything else is an application and may use the library
freely.

```
source/package.json         THE LIBRARY'S INTERFACE: the mounts a browser sees, the
                            specifier prefixes source is written against, the bundles
                            derived from them, the vendored dependencies, and the
                            `exports` map a registry consumer resolves through.
                            `source/` is the package; the repository around it is one
                            consumer of it
source/README.md            the package's npm landing page, and source/LICENSE the copy
                            of the root grant a tarball has to carry. Both checked by
                            `npm run verify`
source/dist/                GENERATED, not committed: srl-core and srl-components, each
                            minified and not, emitted by `npm run package` for the
                            consumer who has no import map (ADR-0066)

source/lib/                 THE FRAMEWORK, served at /lib/
  importmap.json            generated from the manifest and the vendored bytes
                            (`npm run importmap`): the fragment every application's
                            import map carries, pasted or fetched at /lib/importmap.json
  core/
    foundation/             what everything else is built out of, and nothing above
      reactive.js           the only import of @preact/signals-core
      inject.js             typed DI, root scope
      json.js               confines DOM's `any` from Response.json()
    template/
      template.js           .html -> lit template, cached by URL
      dialect.js            the grammar itself: attribute tables, directive syntax,
                            sink -> security context. Imports nothing, so the runtime
                            and the static checker share one copy
      expression-parser.js  dependency-free binding AST parser, shared with tools
      expression.js         the binding language evaluator/compiler
      security.js           DOM security contexts, sanitizers, trusted wrappers
    elements/
      component.js          defineComponent(): tag identity and the template pair
      signal-element.js     base class: light DOM + signal tracking + template render
      mount.js              one dynamic mount: load, definition, races, release
      outlet.js             <x-outlet>, signal-driven component swapping
      projection.js         <x-content>, the ng-content equivalent
    navigation/
      router.js             matching, child layout routes, guards, lazy loading,
                            link interception, <x-route-outlet>
    application/
      runtime.js            startApplication(): the boot transaction, ordered once
    remotes/
      mfe.js                the remote contract, validation, mount guards, lazy routes.
                            The contract, not the adapter: it imports no auth, which is
                            why it is here and host/remote-host.js is not
    http/
      client.js             ApiClient: base URL, query building, one error type carrying
                            the status, the server's code and the per-field codes of a
                            422. Takes the transport it sends through, so core/ imports
                            no auth; auth/session-fetch.js is the adapter for the
                            ordinary signed-in case
    preferences/
      persistence.js        the one owner of synchronous non-auth UI storage
    localization/
      i18n.js               locale signals, Intl formatters, negotiation, fallback
    appearance/
      theme.js              theme selection and the document attribute it sets
    <dir>/types.d.ts        each subsystem's non-trivial types, in real TypeScript, beside
                            the code they describe. foundation/types.d.ts holds only what
                            every subsystem needs: Signal, ReadonlySignal, InjectionToken.
  auth/
    session.js              AuthSession: the authenticated request lifecycle, whole —
                            restore, login, single-flight refresh, scheduling, fetch,
                            cross-tab coordination, disposal
    session-policy.js       sessionFrom(), the readers a store maps with, and failure
                            classification. Names no endpoint and no wire field: a
                            token store is application code, not library code
    guard.js                requireSession / requireScope, as route guards
    session-fetch.js        the session as @core/http's transport, resolved per call
  host/
    remote-host.js          the host side of the contract: the capabilities a remote
                            gets and the grants it is held to
    runtime.js              startHostedApplication(): startup plus the default
                            remote-host adapter, which core/ may not install itself
  vendor/                   lit, signals-core, tailwind-browser + provenance.json
  test/                     the framework's own suite, in real Chrome, no transform.
                            Mirrors core/ one directory per module group; harness.js and
                            fixtures/ stay at the root because every group uses them

source/components/          THE SHARED COLLECTION, served at /components/
  internal/                 not components: what the elements here share
  shell/                    the application frame: app-shell, sidebar and its parts,
                            topbar, breadcrumb, avatar, menu
  inputs/                   ui-combobox, ui-date-range, ui-field, form-control.js
  data/                     ui-table, ui-table-column, ui-dynamic-filter,
                            filter-descriptor.js
  overlays/                 ui-dialog: the one native `<dialog>` wrapper, and the
                            only place style.css claims layout rather than colour
  style.css                 zero-specificity component defaults, written against the
                            `--ui-color-*` tokens and defining none of them
  theme-default.css         the optional default palette: those tokens' light and dark
                            values, achromatic. An application with a brand links its
                            own file instead and leaves style.css untouched
  test/                     mirrors the directories above; runs under every application

example/                    THE APPLICATION, served by its own Node backend
  src/auth/                 memory, bff-cookie and dpop token stores, behind the
                            library's one interface. Application code because each
                            one is a contract with a specific backend
  server/                   no database and no dependencies: sessions in a Map,
                            data generated into arrays at boot. server.mjs,
                            api.mjs, auth.mjs, data.mjs, events.mjs (SSE),
                            static.mjs, random.mjs (seeded, so data is stable)
  index.html                import map (inline, static, integrity-pinned) + Tailwind.
                            Deliberately no `@app/` prefix
  app.manifest.json         both remotes, the API base URL, three locales
  app.css                   the compiled production stylesheet. Generated by
                            `npm run css`, so it is not committed and a fresh clone
                            does not have one; index.html loads the browser JIT until
                            it does
  i18n/{en,it,ar}.json      the shell's bundles; each remote carries its own
  src/main.js               entry: providers, session restore, then <app-root>
  src/routes.js             three levels of layout route: shell, section, detail
  src/navigation.js         the menu, derived from the same tree the router reads
  src/pages/sales/          orders (server-paged), order detail with three tabs,
                            customers
  src/pages/inventory/      products, movements, warehouses
  src/pages/people/         employees, employee detail with three tabs, teams
  src/pages/settings/       profile, appearance, users (scope-guarded), audit
  src/pages/panels/         the two panels the dashboard's <x-outlet> swaps
  src/ui/                   app-card, app-stat, app-badge, app-field, app-notice,
                            app-tabs. Candidates for source/components, kept here
                            until a second application wants them
  src/services/             a service per section, injected, over the library's one
                            `@core/http` client. Plus live-feed.js (SSE) and
                            lookup-service.js
  remotes/{billing,analytics}/  the same two micro-frontends, their own bundles
  test/                     the whole application in one suite; fake-server.js
                            stubs HTTP and EventSource, and nothing else

cli/                        THE TOOLCHAIN, published as `@srljs/cli` (ADR-0067): every tool
                            a repository built on srl needs, pinned to the exact
                            `@srljs/core` it was tested against. Vite, TypeScript and
                            parse5 are dependencies here, so the consumer who only loads
                            the library through an import map installs none of them
  package.json              the package's interface, and cli/README.md its npm landing
                            page, with cli/LICENSE the copy of the root grant a tarball
                            has to carry
  layout.mjs                what is true of a repository: where the package sits, and
                            which directories are applications. At the root because
                            everything else here consumes it
  bin/srl.mjs               one entry point, `srl <command>`: a dispatcher and nothing
                            else. Every tool below still runs by path
  package/
    interface.mjs           what the library publishes, read from source/package.json:
                            mounts, specifier prefixes, and the generated import-map
                            fragment applications paste (`npm run importmap`)
  project-model/            one AST pass over an application, shared by every tool
  diagnostics/              what a check found, as values: one Diagnostic type and the
                            only two things that print one, a terminal report and a
                            JSON document
  checks/
    template-check.mjs      static type checking of template expressions
    importmap-check.mjs     an application's inline import map against the library it
                            installed. The one check a consumer runs, because the
                            failures it catches are blank pages, not build errors
  delivery/
    build.mjs               the production artifact: chunked, minified, hash-named, one
                            sha384 pinned per chunk, and a report describing all of it
    production-html.mjs     an index.html's development form -> its production one
    template-html.mjs       one template minified, and proof the minified bytes parse to
                            the same tree the source did
    bundle-templates.mjs    optional, per application: N template requests -> 1
    release.mjs             a verified artifact -> a transport tree: assets, one
                            versioned release, one report. Knows no host
    release-target.mjs      the seam: where a release is going. `staticTarget()` is
                            the framework's own adapter, a plain directory
    remote-release.mjs      the same for a remote, which owns its graph and its versioned
                            URL base and publishes on its own cadence
    activate-release.mjs    one atomic switch of the pointer a host serves
    retention.mjs           prunes the releases that switch superseded
    verify-release.mjs      a staged or remote tree against its immutable report
    verify-http.mjs         a live origin against that same report: bytes and headers
  dev/
    serve.mjs               zero-dependency dev server: mounts + fallback + watch, and
                            `--proxy` for an application whose backend sets the cookie
  test/                     the suites for everything above, over fixtures/ (whole
                            applications, intact and broken) and support/

tools/                      THIS REPOSITORY'S OWN TOOLS, published nowhere: the ones that
                            only make sense inside the checkout
  checks/
    verify-deps.mjs         layering, deps, import maps, templates, translations, storage
    pack-check.mjs          both tarballs, installed the way a stranger installs them and
                            driven end to end
    readme-check.mjs        the generated sections of docs/reference/project-index.md
    adr-check.mjs           the decision records, and every citation that reaches one
  delivery/
    vendor.mjs              verify /lib/vendor against the hashes every app declares
    package-bundle.mjs      source/dist/: the four files a consumer with a bundler
                            installs, resolved out of the prefixes source is written
                            against (ADR-0066)
  benchmark/                the performance gate: workloads, baseline, budgets
  test/                     the Node-side suites for everything above

```

| Prefix | Resolves to | Served as |
|---|---|---|
| `@core/` | `source/lib/core/` | `/lib/core/` |
| `@auth/` | `source/lib/auth/` | `/lib/auth/` |
| `@host/` | `source/lib/host/` | `/lib/host/` |
| `@components/` | `source/components/` | `/components/` |
| `@app/` | the application's own `src/`, when it declares one | `/src/` |

The first four are identical in every application and the root `tsconfig.json` declares
them. `@app/` is different — a prefix can only mean one directory, so it can point into at
most one application's `src/` — and the root `tsconfig.json` therefore declares it for
none. `example` uses relative imports inside its own `src/` and omits `@app/` from its
import map entirely, which is what lets one program typecheck every application in the
repository. An application that wants the prefix declares it in its own import map and adds
a `tsconfig.json` in its own folder; until it does, a stray `@app/…` fails
`npm run verify`, where a shared mapping would have had tsc resolving it to *another*
application's source, silently.

The directories are locality, not new seams. Interfaces are still the exported modules and
the custom-element definitions.
