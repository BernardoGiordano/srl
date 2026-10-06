# ADR-0123: A plain application omits the host sections of its manifest

- Status: accepted
- Date: 2026-10-06
- Affects: `source/lib/core/remotes/manifest-policy.js`, `source/lib/core/remotes/types.d.ts`, `source/lib/core/remotes/app.manifest.schema.json`, `tools/checks/manifest-schema.mjs`, `tools/checks/readme-check.mjs`, `cli/scaffold/application.mjs`, `source/package.json`, `docs/guide/startup.md`

## Context

Admission required `remotes`, `auth.apiBaseUrl` and a non-empty `i18n.supportedLocales`.
An application that mounts no remote and signs nobody in had to write an empty remote
list and an API location it never called. Learning why meant reading the micro-frontend
host contract first. No guide showed the top-level shape, and the scaffold wrote both
sections as boilerplate.

An absent section and a misspelled one looked the same to admission, which ignored keys
it did not read. While every section was required, a misspelled `remotes` still failed
as a missing one. Once a section may be absent, the same typo would read as "no
remotes" and start a page without them.

Three alternatives lost.

- A separate manifest shape for a plain application splits admission in two, and an
  application that later adds a remote would have to change shapes.
- Defaults applied by `startApplication` before admission would put policy in two
  places. ADR-0010 keeps it in one.
- A hand-written JSON Schema is a second opinion about the document, and it drifts the
  first time admission learns a key.

## Decision

**Every section is optional.** Admission gives an absent `remotes` an empty list, an
absent `auth` an undefined `manifest.auth`, and an absent `i18n` one locale, `en`, with
no bundles. Inside `i18n`, `defaultLocale` and `supportedLocales` stand in for each
other. A present section is checked in full as before. A default fills in for a
missing section and never repairs a bad value.

**Admission refuses a key it does not know.** `MANIFEST_KEYS` in `manifest-policy.js`
lists the keys of every object in the document, and admission refuses any other key,
so a typo fails at startup. A key starting with `$` is an annotation and is allowed
anywhere, which keeps `$schema` and the example's `$comment` working.

**The JSON Schema is generated from admission.** `tools/checks/manifest-schema.mjs`
writes `source/lib/core/remotes/app.manifest.schema.json` from `MANIFEST_KEYS`,
`MANIFEST_PATTERNS`, `ASSET_TYPES` and `DEFAULT_LOCALE`. Generation fails when a key has
no schema entry or an entry names a key admission does not know. `npm run docs:check`
fails when the file drifts, and `npm run docs:write` rewrites it. The package exports it
as `@srljs/core/app.manifest.schema.json`.

**The scaffold writes the smallest manifest.** `srl generate app` and `srl new` write
`$schema` and one `i18n` section with one bundle, and nothing a host or a session needs.

## Consequences

- An application that calls an API reads `manifest.auth?.apiBaseUrl` and decides what an
  absent value means to it. The example throws.
- A manifest carrying a key admission does not read now fails. Such a key was ignored
  before.
- The schema cannot express the rules that need the whole document or the page, such as
  the import map pin, two remotes on one mount and a mount inside another. Admission
  keeps them, and the schema says so in its description.
- A new manifest key needs an admission rule, an entry in `MANIFEST_KEYS` and a schema
  entry. Generation refuses to run until all three agree.
- Reopen this if an application needs a section admission cannot default safely, or if
  annotations need to be told apart from typos inside `$` keys.
