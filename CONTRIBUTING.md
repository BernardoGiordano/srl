# Contributing

Use Node.js 22 or newer. Install development dependencies and run the
repository checks before opening a change.

```bash
npm install
npm run check
```

The application itself can run without an install. The browser loads committed
source and the runtime files in `source/lib/vendor/`. The install supplies
type checking, lint, tests, packaging, and benchmarks.

## Checks while editing

Run the narrow check for the files you changed, then `npm run check` before
pushing.

| Change | Check |
|---|---|
| JavaScript or JSDoc | `npm run typecheck && npm run lint` |
| Component template or public members | `npm run templates:check` |
| Tool or language server | `npm run test:tools` |
| VS Code launcher | `npm run test:editors` |
| Import map, manifest, dependencies, or message keys | `npm run verify` |
| Generated documentation | `npm run docs:check && npm run docs:adr` |
| Browser behavior | `APP=example npm test` |
| Package contents | `npm run package && npm run pack:check` |

The [getting-started guide](docs/getting-started.md) explains the main commands.
The [performance guide](docs/guide/performance.md) explains the separate
benchmark gate.

## Code boundaries

`source/lib/core/` does not import authentication or application code.
`source/` does not depend on the example or repository tools.
`npm run verify` enforces these rules. The
[architecture map](docs/architecture.md) shows the dependency direction.

`source/package.json` declares browser mounts, import prefixes, bundles, and
vendored dependencies. The generated import map and the root TypeScript paths
must agree with it. Update the declaration and run the verifier when adding a
published module.

Keep JSDoc types beside JavaScript. A source comment should explain a local
rule or surprising choice. Put a longer decision and its tradeoffs in
[an ADR](docs/adr/), then cite its number near the code. Start from the
[template](docs/adr/0000-template.md) and run `npm run docs:adr:write` after
adding a record.

## Tests

Browser suites use Chrome and the real DOM. The application tests replace
HTTP at their boundary. Use the shared settling helper and manual clock
rather than timing guesses. [Writing tests](docs/guide/testing.md) has the
test conventions.

The [editor guide](docs/guide/editor-support.md#installed-editor-checks)
explains conformance runs against installed VS Code and WebStorm clients.

## Pull requests

Describe the behavior changed, the checks run, and any measurement behind a
performance claim. Keep a change focused enough that its tests and reasoning
can be reviewed together.
