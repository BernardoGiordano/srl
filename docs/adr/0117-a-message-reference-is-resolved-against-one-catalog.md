# ADR-0117: A message reference is resolved against one catalog

- Status: accepted
- Date: 2026-09-12
- Affects: `cli/message-catalog/`, `cli/checks/message-check.mjs`, `cli/project-model/parse.mjs`, `tools/checks/verify-deps.mjs`, `cli/language-server/service.mjs`

## Context

Messages were checked by comparing catalogs with each other. `npm run verify` read every
locale file an application shipped, flattened each one, and asked whether the translations
agreed with the default locale: a key present in Italian and absent from English was a
refusal, and the untranslated count was reported per file.

That finds a real failure — a key renamed in one language renders correctly in exactly
that language — and it cannot find the failure that actually reaches a user. `t('orders.titel')`
satisfied every rule in the repository. The catalogs agreed with each other perfectly,
none of them had the key, and the page rendered `orders.titel` in every language. The
source side of the question was never asked, because the strings in the source were
strings to every tool that read them.

Three consumers needed the answer, and each would have had to interpret a catalog itself.
The repository sweep had the flattening rule and the `$` comment rule written into it. An
installed application had no equivalent check at all: `srl check importmap` and
`srl check templates` shipped, and a consumer's own bundles were unexamined. The editor
could underline an unknown element and an ill-typed binding, and said nothing about the
key being typed two characters away from the one that exists.

A fourth consumer was missing rather than duplicated. Nothing could add an unanswered key
to a bundle, so the authoring loop was: write the reference, run the app, see the raw key,
open the right file, guess where it goes.

## Decision

**One module owns what a message is.** `cli/message-catalog/` reads an application's
manifest for the bundles it registers, flattens each locale file the way the runtime
flattens it, keeps the position of every key, and resolves a reference by the runtime's own
rule — the key, or a plural variant when the call passes `count`. Nothing else interprets a
catalog. The verifier, `srl check messages` and the language server are adapters over it,
so they cannot disagree about what a key is.

**A reference is a fact the parse already had.** `cli/project-model/parse.mjs` records
every `t()` and `standardText()` call while it is reading a module for its element
declarations, and templates are scanned with the checker's own markup parse and the
dialect's expression grammar. ADR-0038 and ADR-0093 made one parse answer three questions;
this is the fourth, and a regular expression beside the model would have been a second
reading of the same source.

**The strong rule reads calls; the weak rule reads strings.** A reference no bundle answers
is an error, because it reaches a user as a raw key in every language. A catalog entry no
source names is a warning, and any dotted string anywhere in the source is enough to
answer for it — a key held in a property, a lookup table, or the head of a template
literal. The two questions have different costs when wrong, so they read different
evidence.

**A computed key claims its family.** `t('billing.view.' + name)` is reported for the
prefix it starts from and the entries it may reach, and those entries are not reported as
unused. No check can say the built key exists, and none may conclude the entries are dead
either.

**A remote's bundle answers for the remote.** The shell's bundle answers for everything,
because its translations are registered at startup; a remote's answers for the remote's own
directory, because a remote loads on navigation. A shell key answered only by a remote's
bundle would render after one route and raw before it.

**Extraction inserts, and never deletes.** `srl check messages --write` adds each
unanswered key to the default-locale bundle that should hold it, inside the object that
already holds its siblings, with the key as its own message. Ordering, blank lines and
`$comment` notes stay where they are, and running it twice adds nothing.

**Rejected: a catalog format with its own extractor.** A `.po` file or a flat dictionary
per screen would make extraction trivial and would replace the one thing the bundles
already get right — a translator opens a nested JSON file with comments in it and reads
sentences.

**Rejected: a translator-provider seam.** The collection already has one for standard text,
and a second interface between the checker and the catalog would be a seam with one
implementation on each side. CLI output and editor diagnostics are the two adapters, and
they are enough.

**Rejected: making an unnamed key an error.** A key may be one release ahead of the screen
that will show it, and a bundle is also written by hand. A rule that refuses the build for
it would be turned off.

## Consequences

`verify-deps.mjs` lost its message flattening, its plural-variant rule and its
catalog-against-catalog comparison, and gained one call. Its findings now carry
`messages/` codes rather than `deps/` ones, which is where a filter or a suppression should
name them. The one rule it kept is the one no catalog can answer: `ui-nav` builds a
remote's link from the manifest and asks for `nav.<name>`, so that key is required by a
manifest entry rather than by any source.

An installed application gets the check it did not have. `srl check messages` reads the
same model from the same three roots — the library, the collection and the application — so
a consumer's bundles are checked the way this repository's are.

The editor answers per keystroke. A reference is read from the buffer rather than the file,
resolved against the bundles as saved, and reported with the span of the key literal. The
whole-project question — is this entry still named anywhere — is not asked of one file,
because one file cannot answer it.

Two grammars are stated twice, deliberately. `{name}` interpolation lives in
`source/lib/core/localization/i18n.js`, which reaches for signals and the import map and so
cannot be loaded from Node; `cli/test/message-catalog.test.mjs` pins the two regexes
against each other. The plural categories are `Intl.PluralRules`'s own list.

A suite's references are skipped. `configureI18n` takes whatever a test hands it, and a
suite about fallback asks for a key it has deliberately not declared. Vendored bytes are
skipped for the same reason from the other end: a minified module's `t` is not this one.

**What would reopen it:** a message whose key is genuinely unknowable until runtime — a
server-sent code with no prefix in the source, or a bundle fetched from a service instead
of shipped. Both are reported as computed today, which is the honest answer and not a
useful one; the next step would be a declaration in the manifest naming the families an
application resolves dynamically, and that is a new interface rather than a rule.
