# ADR-0083: A locale bundle is hash-named and immutable

- Status: accepted
- Date: 2026-08-30
- Affects: `cli/delivery/build.mjs`, `source/lib/core/remotes/manifest-policy.js`, `source/lib/core/localization/i18n.js`

## Context

Every file an artifact serves falls into one of two cache classes. Anything hash-named
under `assets/` is `public, max-age=31536000, immutable`, because its URL changes when its
bytes do. Everything else is `private, no-cache` and is revalidated on every load, because
its URL is fixed: the document, `app.manifest.json`, `build.json` — and the locale bundles.

The locale bundles do not belong in that second group, and the build said so. `emitRuntimeData`
copied `/i18n/en.json` to the same path it was declared at, under a comment reading "Locale
URLs remain stable and revalidated until a runtime mapping exists." A missing indirection was
the entire reason, and it had been the reason long enough to be documentation.

The cost is not the bytes, it is where they sit. `configureI18n` is startup step 4: it is
awaited before the first render, deliberately, because a component that renders once against
an empty message table and again against a full one flashes untranslated text. So the read is
on the critical path, and it was the only thing on that path a repeat visitor had to
revalidate. In the example application the revalidated class was 56,120 B over six files and
41,140 B of it — three quarters — was locales. On a deployed single-locale application it is
7,843 B: real, and small, which is why this is the smallest of the delivery candidates and
was recorded as worth exploring rather than as a fix.

The mapping cannot be a pattern. A bundle is declared as a URL containing `{locale}`, and
`{locale}` is the only thing a pattern varies; two locales of one bundle have different bytes
and therefore different hashes, so no substitution can produce them. Something has to say, per
resolved URL, which file answers for it.

Two alternatives were rejected.

**A build-time rewrite of the pattern, the way templates are handled.** `templateTransform`
walks each module's AST and replaces every `defineComponent` template literal with the hashed
URL, so a component's markup needs no runtime indirection at all. A locale bundle is not
declared in a module: it is declared in `app.manifest.json`, which is data the runtime fetches,
not code the build transforms. Rewriting it there is the same edit this decision makes, just
without a name.

**A manifest of locale files beside the bundles, as `templateFiles` sits beside
`templateBundle`.** Rejected because the two are not the same shape. `templateFiles` is a list:
the runtime starts every URL on it and needs no correspondence to anything. A locale mapping is
a correspondence — the runtime computes a URL from a pattern and a negotiated tag, and has to
find *that* URL's file. A list would make the consumer re-derive the pairing the build already
knew.

## Decision

**Locale bundles are emitted hash-named under `assets/`, and the emitted manifest's own `i18n`
block says which file each declared URL is served from.** `/i18n/en.json` becomes
`/assets/i18n/en-<hash>.json`, and `i18n.bundleFiles` maps the first to the second.

**The emitted path mirrors the declared one beneath `assets/`.** The name is not invented: its
uniqueness is inherited from a URL the manifest has already admitted as same-origin and
unambiguous. That also means the existing `immutable` rule in `cacheClass` covers the result
with no new clause and no per-asset exception — the change to that function is a comment.

**The declared URL stays the bundle's identity.** `load()` still resolves the pattern against
the negotiated tag, still keys its cache on the result, and `registerMessages` still
deduplicates on the pattern. `bundleFiles` is consulted at exactly one point, the `fetch`
argument. The field is absent in development, where the declared URL is the file, so the lookup
falls through and the dev server is untouched.

**The mapping is admitted as one whole-document decision, per
[ADR-0010](0010-manifest-admission-is-one-whole-document-decision.md).** `admitBundleFiles`
refuses a key that is not a URL the pair (`bundles`, `supportedLocales`) actually resolves to,
and puts every value through `admitPath`. Both checks need the rest of the document: a mapping
for a URL this manifest never produces is a file that is emitted and never fetched, and it is
locally valid in precisely the way that module exists to catch.

**The build proves the mapping before publishing it.** `verifyPayload` refuses a mapped URL
that is not hash-named, that names no emitted file, or whose file's bytes do not match the hash
in its name — the same `verifyHexHash` check the templates already get. A mapping is a promise
the runtime keeps without looking: a wrong one is a locale that silently loads empty behind a
year-long cache. Recomposition re-runs the check against the manifest it re-admits, so a
composed shell proves it too.

**A Remote's locale bundles are not hashed.** They are published under a base that already
carries the Remote's release, so their URLs change with every deploy that changes them; the
`i18n/` clause in `cacheClass` remains for exactly that case and is now the only thing it
covers. Hashing them would need the mapping to reach `load()` through
`registerMessages`, which takes a pattern and nothing else — a wider interface change for a
class of file that is not on the shell's startup path.

## Consequences

A locale that did not change is not re-fetched after a deploy that changed something else,
which is the property every other payload file already had. Startup step 4 stops being the one
revalidated read on the critical path. In the example application the revalidated class drops
from six files to three, and its locales — 41,140 B — move to the immutable class.

The mapping costs 219 B of JSON, 74 B compressed, on a document that is fetched on every load
and preloaded by the entry document ([ADR-0080](0080-the-entry-document-names-the-graph.md)),
so it costs no round trip and no request.

**This does not preload the bundle, and the round trip is still there.** The document could
now name a locale file — it is a stable, immutable, build-known URL, which is the thing
[ADR-0080](0080-the-entry-document-names-the-graph.md) needs and did not have. What it cannot
predict is *which* one: `preferredLocale()` negotiates from a stored preference and the
browser's languages, so a document that preloaded the default locale would send a second
language's bundle to everyone who chose the first. On a single-locale application there is
nothing to predict and the hint would be free, which makes this worth revisiting as a build
fact — one supported locale, one preload — rather than as a guess.

`emitRuntimeData` is gone, split into `emitLocaleFiles` and `emitReleaseIdentity`. It had been
two unrelated jobs sharing a name, and only the first has an interesting output.
