# Changelog

## 0.2.0

- **Toolchain, published.** `@srljs/cli` is a second package: the dev server, the project
  model, the template checker and the artifact build and release pipeline, with Vite,
  TypeScript and parse5 as its own pinned dependencies rather than the library's. It names
  `@srljs/core` as an exact peer, so a repository that deploys an application installs both
  and needs no srl checkout of its own
  ([ADR-0067](docs/adr/0067-the-toolchain-is-a-second-package.md)).

## 0.1.0

First published version.

- **Framework.** Signals and typed dependency injection; a template dialect compiled at
  runtime from a component's sibling `.html` and statically checked without a build;
  custom elements with light-DOM rendering; a router with layout routes, guards and lazy
  loading; forms; an HTTP client with an injected transport; i18n with per-key fallback;
  theme and preference persistence; micro-frontend hosting with per-remote grants.
- **Collection.** Application frame (`ui-app-shell`, `ui-sidebar` and its parts,
  `ui-topbar`, `ui-breadcrumb`, `ui-avatar`, `ui-menu`), inputs (`ui-field`,
  `ui-combobox`, `ui-date-range`), data (`ui-table`, `ui-table-column`,
  `ui-dynamic-filter`) and `ui-dialog`, plus `style.css` and the optional
  `theme-default.css` palette.
- **Two delivery shapes.** `lib/` and `components/` ship as source with
  `lib/importmap.json` for a browser with an import map; `dist/srl-core.js` and
  `dist/srl-components.js`, minified pairs beside them, for Node and bundlers
  ([ADR-0066](docs/adr/0066-the-registry-consumer-gets-bundles.md)).
- **Runtime dependencies.** `lit` 3.3.3 and `@preact/signals-core` 1.14.4, pinned exactly
  and also committed into `lib/vendor` with integrity hashes, so the buildless path needs
  no install ([ADR-0032](docs/adr/0032-runtime-dependencies-are-vendored-and-pinned.md)).