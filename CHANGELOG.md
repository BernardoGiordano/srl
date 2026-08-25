# Changelog

## 0.3.0

- **`srl serve --proxy <prefix>=<origin>`.** A URL prefix the development server forwards to
  a backend instead of serving it from disk, repeatable. An application whose session is a
  cookie its backend sets is deployed behind one origin, and until now could only be
  developed behind two — which means `SameSite=None` and a CORS preflight that production
  never performs, or a hand-written server beside this one that re-implements the mounts in
  order to add the proxy. Routes only: the prefix is not stripped, status and headers pass
  through untouched, and the check sits ahead of the 405 and the history fallback so a
  `POST` reaches the backend and an upstream 404 does not come back as `index.html`
  ([ADR-0069](docs/adr/0069-the-dev-server-proxies-the-backend.md)).

## 0.2.0

- **Toolchain, published.** `@srljs/cli` is a second package: the dev server, the project
  model, the template checker and the artifact build and release pipeline, with Vite,
  TypeScript and parse5 as its own pinned dependencies rather than the library's. It names
  `@srljs/core` as an exact peer, so a repository that deploys an application installs both
  and needs no srl checkout of its own
  ([ADR-0067](docs/adr/0067-the-toolchain-is-a-second-package.md)). One bin, `srl`, with
  `serve`, `build`, `model`, `check importmap`, `check templates` and the release pipeline
  behind it; every command is still a module runnable by path.
- **Types for the buildless path.** `@srljs/core/tsconfig.base.json` is the type checker's
  half of the published interface — the four path mappings that make `@core/` resolve, plus
  the JS-checking options the library's JSDoc assumes. A consumer extends it instead of
  copying a table that would drift from the import map
  ([ADR-0068](docs/adr/0068-the-installed-shape-is-checked-by-installing.md)).

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