# Contributing

`npm run check` is the contract. It is what CI runs, and a change that passes it locally
passes there. Everything below is how to get there faster than by running the whole chain
after every edit.

## Setup

```bash
npm install
npm run check
```

Node 22 or later. Nothing is installed to *run* the application — the browser loads the
committed files, and `source/lib/vendor/` holds the three runtime dependencies. `npm
install` exists so `tsc`, `eslint`, the test runner and the benchmark can resolve the same
versions the browser is served.

## The chain, and what each link is for

| Command | Refuses |
|---|---|
| `npm run typecheck` | A type error, in JavaScript checked from JSDoc and `.d.ts` beside it |
| `npm run templates:check` | A binding to a property that does not exist, a tag with no definition, a directive misuse |
| `npm run lint` | A style or correctness rule, type-aware |
| `npm run test:tools` | A broken tool: the project model, the checks, the delivery pipeline |
| `npm run vendor` | A vendored file whose bytes no longer match its integrity hash |
| `npm run package` | A published bundle that will not build, or that still names `@core/` — a specifier only an import map resolves |
| `npm run verify` | A dependency-rule violation, and four descriptions of the interface disagreeing |
| `npm run docs:check` | A generated reference table that drifted from the project model |
| `npm run docs:adr` | A malformed record, or a citation that resolves to nothing |
| `npm test` | A browser suite, in real Chrome, against the real DOM |

Run the narrow one while you work and the whole chain before you push.

## The rules a change is judged by

Three of them are enforced, and the checks name themselves when they fail.

**The dependency rule.** `source/lib/core/` may not import `source/lib/auth/`, and nothing
outside `source/` is reachable from inside it. `npm run verify` is the enforcement.
[The architecture map](docs/architecture.md) is the explanation.

**The interface is declared once.** `source/package.json` says what the library publishes —
the mounts, the specifier prefixes, the bundles, the vendored dependencies. The `exports`
map, the generated import-map fragment, each application's inline map and the root
`tsconfig` paths are all derived from it or checked against it. Adding a layer is one edit
there, not five: `npm run verify` refuses a prefix that no bundle is a barrel over, so the
consumer who installs from a registry reaches it for the same reason a browser does
([ADR-0066](docs/adr/0066-the-registry-consumer-gets-bundles.md)).

**Reasoning goes in a record, not a comment.** A source comment says why *that line* is the
way it is. The narrative — what was tried, what it cost, what would reopen it — is a file
under [`docs/adr/`](docs/adr/), cited by a number that never changes:

```js
// Deepest-first, so the specific question reaches the user first. ADR-0004.
```

Start a new record from [the template](docs/adr/0000-template.md), give it the next free
number, and run `npm run docs:adr:write` to regenerate the index. `npm run docs:adr` fails
on a citation that resolves to nothing, so deleting a record means rewriting the prose that
cited it.

## Where things go

```
source/lib/         the framework. Depends on nothing outside itself
source/components/  the shared collection, built on source/lib
source/dist/        generated: the bundles `npm run package` emits. Never edited
example/            an application. Any root directory with an index.html is one
cli/                the toolchain, and a package of its own: everything a repository
                    built on srl needs. Extracting it is a file move
tools/              the tools that only make sense in this repository. Published nowhere
docs/               the manual; docs/adr/ the reasoning
```

`source/README.md` is the package's npm landing page and `source/LICENSE` a checked copy
of the root one; both address the consumer reading a registry rather than this repository,
which is why they are the one documented exception to the no-nested-READMEs rule above.
A change to the published interface gets a line in [the changelog](CHANGELOG.md).

There are no nested READMEs. A manual in the directory somebody edits first is the one that
goes stale; [the documentation policy](docs/documentation.md) says where each kind of
knowledge lives instead.

Types live beside the code they describe: each subsystem owns a `types.d.ts` next to its
modules, and `@core/foundation/types.js` holds only what every subsystem needs and no
subsystem owns.

## Tests

Browser suites run in real Chrome against the real DOM. HTTP is the only boundary a suite
fakes — no mocked router, no mocked storage, no mocked component.

```bash
npm test                      # every suite
APP=example npm test          # the library suite plus that application's
npm run test:tools            # the Node-side tools, no browser
```

[Writing a test](docs/guide/testing.md) has the rules the existing suites already learned.

## Performance

`npm run benchmark` measures against committed budgets. A regression has to be both
relatively and absolutely large before the gate fails, and a result carries the environment
that produced it — a number from your laptop and a number from CI are not comparable, which
is why the harness records which one it was.

## Opening a change

Small and self-contained beats large and thorough. Say what you measured if the change is
about performance, and add a record if the change is a decision somebody could reasonably
reverse without knowing why it was made.
