# Changelog

`@srljs/core` and `@srljs/cli` release together at one version. Dates are the npm
publish dates. A decision record explains each larger change.

## Unreleased

### Added

- `srl build --force` replaces an output directory no build wrote. ADR-0132.
- `@srljs/core` is one import name in both delivery shapes. The import map maps it to
  `lib/srl-core.js`, which re-exports the bundle's names from the modules the deep paths
  load. ADR-0124.
- `app.manifest.json` sections are optional, and the package ships
  `app.manifest.schema.json` for editor completion. ADR-0123.
- `srl serve` prints failures in the page with their codes, and shows errors in a panel.
  ADR-0125.
- `@srljs/cli/testing/web-test-runner.mjs` runs component tests the way the repository
  does. `srl new` writes a test, a `test` script and the runner configuration. ADR-0126.
- `srl mcp`, a Model Context Protocol server with check, codes, elements, element and
  docs tools. ADR-0127.
- `srl model --custom-elements`, and a `custom-elements.json` in `@srljs/core`. ADR-0127.
- A generated component reference, `docs/reference/components.md`.
- A guide to signals, services and the HTTP client.
- Short command names: `n`, `g`, `g c`, `s` and `b`.

### Changed

- `srl build` replaces an output directory only when it is empty or holds the
  `artifact.json` a build wrote. It refuses a directory that holds the project or the
  home directory, `--force` or not. ADR-0132.
- Manifest admission refuses a URL that differs from its normal form, such as
  `/api/v2/../v1/`, instead of normalizing it.
- The project model reports `project/invalid-tag` for a `defineComponent` tag that is
  not a valid custom element name, so the build refuses it.
- Path errors from `srl release`, `srl remote-release`, `srl verify-release` and
  `srl retention` start with `output:`.
- Manifest admission refuses a key it does not know, except `$` annotations. ADR-0123.
- Template expression refusals have three codes, `templates/expression-syntax`,
  `templates/expression-assignment` and `templates/expression-member`.
- `srl model --json` carries `schemaVersion: 1`.
- `configureCollectionText` is exported from `@srljs/core/components`.
- An application's import map needs the `@srljs/core` entry. `srl check importmap`
  reports `importmap/missing-specifier` until the fragment is pasted again.

### Fixed

- `ApiClient` called its transport with the client as `this`, so passing
  `globalThis.fetch` threw "Illegal invocation" in browsers.
- `srl build --out ..` or `--out ~/Documents` deleted the named directory and
  everything in it, the project included. ADR-0132.
- A component tag or locale bundle URL holding `..` could make the build write outside
  its output directory.
- Composition wrote a Remote's asset URLs into the import map unescaped, so a changed
  release report could add a script to the shell's `index.html`. The import map is
  HTML-safe JSON, and composition checks each Remote's descriptor against its bytes.
- A template whose `<select>` held a `<button>` or another element lost it in
  production, because the minifier's parser dropped it from both sides of its proof.
  Such a template ships as authored.

## 0.9.0 (2026-09-22)

- `srl check` runs types, templates, the import map, messages and the project model in
  one process, with one code per problem and a catalogue. ADR-0120.
- Both packages ship their documentation with an `llms.txt` index. ADR-0121.
- `srl new` writes a project, and `srl generate` adds applications and components.
  ADR-0122.
- Declarations ship beside the bundles, and a strict consumer typechecks against them.
- Template edits revise the running page, and an edited component class is adopted in
  place. ADR-0111, ADR-0113.
- Inline Lit templates get editor support in Lit syntax.
- Updates can report why an element rendered. ADR-0109.
- One accessible interaction journey runs on Blink, Gecko and WebKit. ADR-0116.

## 0.8.0 (2026-09-10)

- A language server, with VS Code and WebStorm clients. ADR-0090.
- Service worker registration.
- Form arrays, groups and asynchronous validators.
- The table owns selection and renders a bounded window of rows.
- Template fragments receive row context.
- Concurrent identical GETs share one request.

## 0.7.0 (2026-09-01)

- Templates compile once per sink, and development follows the production template
  pipeline.
- The build writes the manifest's template groups from the chunk graph.

## 0.6.0 (2026-08-30)

- Three template delivery modes, `split`, `split-lazy` and `bundle`. ADR-0081.
- Nested route levels load together.
- Locale bundles are hash-named.

## 0.5.0 (2026-08-27)

- A scaffold, a resource API and a settled module.
- One application origin for development and tests. ADR-0075.
- The bundle offers only names not marked `@internal`.

## 0.4.0 (2026-08-26)

- Template bundling reworked.

## 0.3.0 (2026-08-25)

- `srl serve --proxy` forwards a path prefix to a backend.

## 0.2.0 (2026-08-25)

- `@srljs/cli` is published on its own, with the `srl` command.

## 0.1.0 (2026-08-21)

- First release of `@srljs/core`, the library and the component collection.
