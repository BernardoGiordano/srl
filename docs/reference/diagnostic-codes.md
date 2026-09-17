# Diagnostic codes

Generated from `cli/diagnostics/catalog.mjs`, the table `srl check --codes` prints.
Regenerate with `npm run docs:write`. `npm run docs:check` fails when the table drifts
from the catalogue.

Every finding `srl check` reports carries one of these codes. The code names the
problem, and the finding's message says where it is and how to fix it. `srl check
--json` prints findings as JSON, and ADR-0072 defines their shape.

<!-- generated:codes -->

| Code | Meaning |
|---|---|
| `check/no-application` | The repository root holds no directory with an index.html, so there is nothing to check. |
| `check/unknown-application` | `--app` names no application in the repository root. |
| `check/unknown-subject` | `srl check` was given a subject it does not have. |
| `check/write-outside-messages` | `--write` edits message bundles, so it runs only with the `messages` subject alone. |
| `project/read` | The project model read the application and found nothing that fails the build. |
| `project/dynamic` | A component definition is built at runtime, so no static tool can see the element it defines. |
| `project/duplicate-tag` | Two modules define the same tag, and whichever loads second throws. |
| `project/unresolved-uses` | A `uses` entry names a class that no module defines as a custom element. |
| `project/shadowed-lifecycle` | A class field hides a method the class inherits, so calls reach the field instead. |
| `project/stylesheet-without-template` | An element declares `styles: true` and renders no template for the stylesheet to reach. |
| `project/shared-stylesheet` | Two elements in one module both claim its sibling stylesheet, which is scoped to one tag. |
| `project/stylesheet-scope` | An element stylesheet holds a rule the browser and the build refuse to scope. |
| `types/no-config` | The repository root has no tsconfig.json to compile against. |
| `types/checked` | Every file tsconfig.json includes typechecks. |
| `templates/checked` | Every template in the application typechecks. |
| `templates/skipped-package` | Templates inside an installed package are left to that package's own checks. |
| `templates/no-compiler` | The template check has no tsconfig.json to compile against. |
| `templates/unknown-application` | `--app` names no application in the repository root. |
| `templates/unreadable` | A template file a component declares cannot be read. |
| `templates/syntax` | A template is not well-formed markup, such as a start tag that never closes. |
| `templates/for-with-if` | One element carries both `*for` and `*if`, which the runtime refuses. |
| `templates/else-without-if` | An `*else` has no `*if` on the element before it. |
| `templates/invalid-for` | A `*for` is not written as `item of items`. |
| `templates/invalid-for-clause` | A `*for` clause is neither `key: ...` nor `index as ...`. |
| `templates/template-without-fragment` | A `<template>` has no `*fragment`, so nothing renders it. |
| `templates/fragment-without-owner` | A `<template *fragment>` sits at the top level, with no element to assign it to. |
| `templates/fragment-outside-template` | An element other than `<template>` declares `*fragment`. |
| `templates/invalid-fragment` | A `*fragment` is not written as `name(param, ...)`. |
| `templates/fragment-on-sink` | A `*fragment` names a property that takes text or a URL, not markup. |
| `templates/duplicate-fragment` | One element receives two fragments for the same property. |
| `templates/inline-handler` | An `on...` attribute or binding is refused. Bind the event as `(event)="handler()"`. |
| `templates/empty-binding` | A binding has brackets and no name, such as `[]` or `[.]`. |
| `templates/refused-property` | A property binding names an event handler, `outerHTML` or a reserved member. |
| `templates/state-binding` | A binding writes an element's internal state, which is not a public input. |
| `templates/property-without-attribute` | An attribute names a property that has no attribute. Bind it as `[.name]`. |
| `templates/unknown-attribute` | A custom element does not observe the attribute the markup writes. |
| `templates/expression` | A binding expression does not parse, or uses something the dialect refuses. |
| `templates/missing-use` | The template names a defined element that the component does not list in `uses`. |
| `templates/unknown-element` | The template names an element that is neither standard markup nor a defined component. |
| `importmap/no-fragment` | The installed library has no `lib/importmap.json` to compare against. |
| `importmap/no-application` | The repository root holds no directory with an index.html. |
| `importmap/verbatim` | The import map carries the library's fragment unchanged. |
| `importmap/missing-specifier` | The import map omits a specifier the library publishes. |
| `importmap/edited-specifier` | The import map resolves a library specifier to a different URL than the library publishes. |
| `importmap/edited-hash` | The import map pins a library file to a different hash than the library publishes. |
| `importmap/prefixes` | The library prefixes resolve into the installed package. |
| `importmap/prefix-elsewhere` | A library prefix resolves outside the installed package, which loads a second copy of the framework. |
| `importmap/hashes` | Every hashed file matches its bytes. |
| `importmap/pinned-file-missing` | The integrity map pins a URL that resolves to no file. |
| `importmap/integrity-mismatch` | A pinned file's bytes no longer match its hash, so the browser refuses it. |
| `importmap/target-missing` | The import map points at a URL that resolves to no file. |
| `importmap/unhashed` | Some mapped files carry no integrity hash. |
| `importmap/script-pinned` | A vendored classic script carries an integrity attribute. |
| `importmap/script-unpinned` | A vendored classic script has no integrity attribute. |
| `importmap/csp-hash` | The run states the `script-src` hash a Content Security Policy must allow for the inline import map. |
| `messages/no-application` | The repository root holds no directory with an index.html. |
| `messages/written` | `--write` added unanswered keys to a bundle, each holding its key as its message. |
| `messages/occupied-key` | `--write` cannot add a key because a message already stands where its parent group goes. |
| `messages/no-default-locale` | A bundle ships no file for its default locale, so partial translations render raw keys. |
| `messages/locale-absent` | A supported locale has no bundle file, so it renders entirely in the default locale. |
| `messages/orphan-key` | A translation holds a key the default locale lacks. |
| `messages/locale` | The run states how many keys a translation holds and how many it leaves untranslated. |
| `messages/unused-key` | No source names a key the default locale holds. |
| `messages/computed-key` | Some references build their key at runtime, and the entries they may reach count as used. |
| `messages/references` | The run states how many message references the application source makes. |
| `messages/unknown-key` | A reference names a key no bundle it can reach declares, so the page shows the key. |
| `messages/missing-parameter` | A message interpolates a placeholder the call does not pass, so the page shows the braces. |
| `messages/unused-parameter` | A call passes a parameter its message does not interpolate. |
| `types/ts<number>` | TypeScript reports this error in a file tsconfig.json includes. The number is TypeScript's own. |
| `templates/ts<number>` | TypeScript reports this error in a template binding, placed at the binding. The number is TypeScript's own. |

<!-- /generated:codes -->
