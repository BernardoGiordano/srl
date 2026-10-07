# ADR-0132: Build output goes through one confined writer

- Status: accepted
- Date: 2026-10-07
- Affects: `cli/delivery/output-tree.mjs`, `cli/delivery/build.mjs`, `cli/delivery/release.mjs`, `cli/delivery/remote-release.mjs`, `cli/delivery/verify-release.mjs`, `cli/delivery/retention.mjs`, `cli/delivery/artifact-report.mjs`, `cli/delivery/template-html.mjs`, `cli/project-model/index.mjs`, `cli/scaffold/files.mjs`, `cli/scaffold/application.mjs`, `cli/scaffold/project.mjs`, `source/lib/core/remotes/manifest-policy.js`

## Context

`build.mjs` joined strings from the project into output paths and wrote wherever they
landed. A component's tag named its template file, and a locale bundle URL named its
hash-named copy. The tag `x/../../` and the pattern `/i18n/{locale}.json?/../../x` both
wrote outside the stage.

Publishing moved whatever `--out` named aside and deleted it. Output outside the
repository was admitted without a check, so `srl build --out ..` deleted the project and
its siblings, and `--out ~/Documents` deleted the folder.

The scaffolds joined each path to the project root and checked for an existing file
with `stat`, which follows links. A dangling link read as absent, and a linked directory
in the project carried `srl generate` output outside it.

The release modules already confined their writes and never cleaned a caller's path.
They did it with four copies of one `inside()` function. The build and composition
followed neither copy.

Composition wrote the import map into `index.html` as raw `JSON.stringify` output. The
map carries every asset URL from each retained Remote release's descriptor, and
`release.json` is the one file a release doesn't hash. An asset URL holding
`</script><script>` became a classic script in the shell's document, which runs before
the Remote's `requires` gate.

The template minifier proves its output equivalent to its source by parsing both with
parse5 6. That parser reads `<select>` content by the rules from before customizable
select, and drops a `<button>` or `<div>` there that a current browser keeps. Source and
output lose the same element, so the proof passes and production drops markup.

Five alternatives lost.

**Refusing `--out` outside the repository.** CI and the tests build into temporary
directories. A marker file tells a build's directory from anyone else's without limiting
where a build may go.

**Normalizing a path before writing it.** A path that lands inside the root only after
cleanup was written to leave it. Refusing it names the bad input.

**Escaping only `</script`.** `<!--` inside a script element also moves where the parser
ends it. Escaping every `<`, `>` and `&` costs nothing, because `JSON.parse` returns the
same value.

**Upgrading parse5.** The CLI pins parse5 6.0.1 for the build, the checker and the
project model. An upgrade changes every reader at once, and needs its own decision.

**Shipping every template with a `<select>` as authored.** Five templates in the example
hold a `<select>` with options alone, which parses the same under both rules.

## Decision

`cli/delivery/output-tree.mjs` is the one module that writes build, release and
scaffold output.

- `within(root, path)` returns the path inside `root`, or refuses a path with an empty,
  `.` or `..` segment, a leading `/`, a backslash or a NUL.
- `writeWithin` and `copyWithin` refuse a write whose parent resolves outside the root
  through a symbolic link, or whose target is anything but a regular file.
- A symbolic link that points at nothing resolves to its target, so a directory created
  through it is checked where it would land.
- `createWithin` writes as `writeWithin` does, and refuses anything already at the
  path, a dangling link included. `entryWithin` reads what is there without following
  a link. The scaffolds admit every path through `entryWithin` before writing any, and
  create each file with `createWithin`. A new application or project directory is
  refused when any entry, a dangling link included, already has its name.
- `listFiles` lists every regular file, dot files included, and refuses a link or a
  special file. The build's inventory, release verification and retention read it.
- `admitOutput` refuses an output that holds the project or the home directory, with or
  without `force`. It replaces an existing directory only when the directory is empty or
  holds `artifact.json` at its top. `--force` admits any other directory. The
  `.previous` backup beside it follows the same rule, and admission runs again at
  publish.
- `embedJson` escapes `<`, `>`, `&`, U+2028 and U+2029. Both import-map writers use it,
  and the build re-parses `index.html` and requires the map's text to equal what it
  wrote. Report admission refuses an import map source holding any of those characters.

Composition, and a build given Remote reports, recompute each Remote's descriptor from
its bytes. Every URL must sit below the Remote's base, every asset must be a file it
published, every integrity must be that file's digest, and the entry must be among the
assets.

`admitPath` refuses a manifest URL that differs from its parsed form. `/api/../auth`
and `/auth` reach one destination, and a reader that compares strings sees two.

The project model reports `project/invalid-tag` for a `defineComponent` tag the runtime
would refuse, so the build stops before naming a file after it. The build refuses a
locale bundle URL with a query, because it maps each URL to one file.

The minifier counts each tag name's start tags in the source against the elements parse5
built. A template where parse5 built fewer ships as authored, which is the bytes
development serves.

## Consequences

- `srl build --out <dir>` fails when `<dir>` holds files and no `artifact.json`.
  `--force` replaces it.
- A manifest URL is written in its normal form. `/api/v2/../v1/` used to be admitted as
  `/api/v1/`, and is now refused by the build and by the runtime.
- Composition reads every Remote asset once more to recompute its digest.
- Release errors about paths start with `output:` instead of each module's name.
- A scaffold reports `scaffold/unsafe-path` for a path that leaves the project through a
  symbolic link. A directory linked to somewhere else inside the project still works.
- A template whose start tag parse5 drops ships unminified.
- Upgrading parse5 past customizable select would retire the minifier's fallback.
  Shared path admission across the router, the remote host and the HTTP client would
  give `within` and `admitPath` one canonical form to share.
