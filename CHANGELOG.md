# Changelog

## Unreleased

- **A check returns diagnostics, and prints nothing.** Every check in the toolchain — the
  dependency and layering verifier, `srl check importmap`, `srl check templates`, the
  packaged-install probe, and the two documentation gates — used to report what it found by
  writing to a terminal and answering with a count. Each now returns
  `Diagnostic[]`: a severity, a stable namespaced code, a message, and the file, line and
  column it belongs to. `cli/diagnostics/index.mjs` is the only module that formats one,
  which is why `--json` now works on all of them and prints the same findings the terminal
  report shows. `checkTemplateSource()`, the in-memory seam an editor integration calls,
  answers with placed findings instead of formatted strings — a breaking change to that
  function's return type, and the reason it is worth calling
  ([ADR-0072](docs/adr/0072-a-check-returns-diagnostics.md)).

## 0.4.0

- **A built template is one immutable file, fetched by the component that needs it.**
  `srl build` no longer points the runtime manifest at a `templates-<hash>.json` holding
  every template in the application: each is emitted as its own hash-named, immutable file
  and fetched when the chunk that names it loads, so a visitor downloads the markup of the
  routes they open rather than of every route there is. The per-template files were already
  being emitted beside the bundle and described as fallbacks; they are the delivery now.
  `--templates bundle` restores the single request for a deployment where a round trip costs
  more than the bytes, and a `templateBundle` an application set by hand is removed from the
  emitted manifest rather than passed through, so an artifact cannot name a file it does not
  contain ([ADR-0071](docs/adr/0071-a-built-template-is-fetched-by-the-component-that-needs-it.md)).
- **Production templates are minified, and the minified bytes are proved equivalent.**
  Comments and indentation are markup the runtime compiler discards on arrival — a third of
  the authored bytes in one real application, 12.9 KiB of Brotli down to 7.8. The transform
  collapses runs of whitespace rather than removing them, leaves `pre`, `textarea`, `script`,
  `style` and anything that declares `white-space` or a Tailwind `whitespace-pre*` class byte
  for byte, and reduces source and output to the token stream the compiler cares about to
  prove they agree. A greedy transform now fails the build naming the template instead of
  shipping a page that renders subtly wrong
  ([ADR-0070](docs/adr/0070-a-production-template-is-minified-and-proved-equivalent.md)).
- **The published bundles carry minified templates too.** `srl-components.js` inlines each
  component's markup as a string literal for the bundler consumer, and those literals held
  the authored bytes: `srl-components.min.js` is 77,570 bytes rather than 83,352 for the same
  15 templates.
- **`artifact.json` describes template delivery.** `templates` carries `delivery`, `bundle`
  (`null` when split), `url`, `count`, `bytes` and `files` — the last replacing `fallbacks`,
  since those files are no longer a fallback for anything.

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
- **A plain custom element is declared by importing it.** `uses` resolves each entry to a
  component definition and throws on a class that has none, so an element defined with
  `customElements.define` — one that owns its own children, and so cannot be a component
  whose template would wipe them — could never appear in one. The template checker
  nonetheless reported such an element as missing from `uses`, which is advice that breaks
  the application at runtime. A side-effect import is now what the model reads for those,
  because running the module is what makes the element exist.
- **`-1` keeps its literal type in a template.** TypeScript gives a numeric literal type to
  `-` applied directly to a numeric literal and to nothing else, and the checker emitted
  `-(1)`. A handler typed `(direction: 1 | -1)` — an ordinary move-up/move-down pair —
  rejected `(move-up)="move(row, -1)"` while accepting `(move-down)="move(row, 1)"`.

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