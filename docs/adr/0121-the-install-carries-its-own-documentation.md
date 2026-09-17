# ADR-0121: The install carries its own documentation

- Status: accepted
- Date: 2026-09-17
- Affects: `tools/delivery/package-docs.mjs`, `tools/checks/readme-check.mjs`, `tools/checks/dialect-reference.mjs`, `tools/checks/pack-check.mjs`, `source/lib/core/template/dialect.js`, `source/lib/core/template/expression-parser.js`, `source/package.json`, `cli/package.json`, `docs/reference/template-dialect.md`, `docs/reference/diagnostic-codes.md`, `docs/guide/templates.md`, `docs/documentation.md`

## Context

Neither tarball shipped a guide or a decision record. The shipped source cited records
about two hundred times, and every citation pointed at a repository the reader might never
open. A coding agent working from `node_modules` had the code and the record numbers, and
no records.

The template guide had the same problem from the other side. It restated the dialect by
hand and had fallen behind it. It left out `$index` and its siblings, the `index as`
clause, where `*else` may go, and which expressions the parser refuses. The runtime and
the checker both read `dialect.js`, so they agreed with each other and the guide agreed
with neither.

Three alternatives lost.

- Links from the package READMEs to GitHub resolve to the default branch, which describes
  the next version rather than the installed one, and they need a network.
- A docs package, or a pointer from one package into the other, depends on how the package
  manager lays out `node_modules`. The CLI's source cites records more often than the
  core's does.
- A hand-written reference page beside `dialect.js` is closer to the code, but nothing
  fails when the two disagree.

## Decision

**Documentation is package output.** `npm run package` copies `docs/` into both
workspace packages and writes an `llms.txt` index at each package root, from the tables in
`docs/README.md` and the records in `docs/adr/`. Both `files` lists name `docs` and
`llms.txt`, so the copies enter through the mechanism ADR-0033 and ADR-0066 already use,
and no second manifest exists. The copies are build output and are not committed.

**A shipped page links only inside its package.** The copy is refused when a relative link
leaves the package or names a file the package lacks. It is also refused when a guide or
reference page is missing from `docs/README.md`, because the index would not list it.
`npm run package:check` fails when a copy is stale.

**The install is checked for it.** The packaged-install probe (ADR-0068) confirms that each
installed package has its index, that every relative link in the shipped pages resolves,
and that every record the package cites exists under its own `docs/adr/`.

**The dialect reference is generated.** `docs/reference/template-dialect.md` carries
blocks that `tools/checks/dialect-reference.mjs` writes from `dialect.js` and
`expression-parser.js`. Tables such as the boolean attributes, the loop locals and the
security sinks are printed as the dialect holds them. Rules that live in code are shown by
running sample spellings through the dialect's own functions, so the page states the
parser's verdict rather than an author's. The loop locals moved into `dialect.js` as
`FOR_LOCALS`, and the runtime, the checker and the language server read them from there.
`docs/reference/diagnostic-codes.md` is generated the same way from the catalogue ADR-0120
introduced. `npm run docs:check` covers all three generated pages.

## Consequences

- An agent in `node_modules/@srljs/cli` resolves `ADR-0072` to
  `node_modules/@srljs/cli/docs/adr/0072-a-check-returns-diagnostics.md`, at the installed
  version.
- Each tarball grows by the size of `docs/`, about 600 KB unpacked. The two copies are
  identical.
- A page that links to source outside `docs/` can no longer ship. Such a link has to name
  the file in prose or point at the repository by URL.
- Changing the dialect changes the reference page, and `npm run docs:check` fails until
  `npm run docs:write` runs. The sample spellings in the generator are written by hand, so
  a new construct appears on the page only when someone adds a sample for it.
- The `Start here` pages ship under `Optional` in `llms.txt`, because they describe the
  repository rather than the installed package.
- Reopen this if the tarball size starts to matter, or if a docs site replaces the
  shipped copy as the place readers go.
