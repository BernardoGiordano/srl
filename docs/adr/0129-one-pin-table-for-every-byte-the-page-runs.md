# ADR-0129: One pin table answers for every byte the page runs

- Status: accepted
- Date: 2026-10-06
- Affects: `source/lib/core/foundation/pins.js`, `source/lib/core/elements/stylesheet.js`, `source/lib/core/remotes/manifest-policy.js`, `source/lib/core/remotes/mfe.js`, `source/lib/core/template/template.js`, `source/lib/core/application/runtime.js`, `source/lib/core/localization/i18n.js`, `source/lib/host/remote-host.js`, `cli/delivery/build.mjs`, `cli/delivery/service-worker.mjs`, `cli/delivery/remote-release.mjs`, `cli/delivery/activate-release.mjs`, `cli/package/interface.mjs`, `cli/checks/importmap-check.mjs`, `tools/checks/verify-deps.mjs`

## Context

Integrity was tied to `import()`. The import map pinned module digests, and admission
checked a remote's module digests against those pins. Nothing else the page loaded was
pinned. Split templates carried no integrity, by an explicit line in ADR-0081. The
template bundle and the locale bundles loaded bare. A remote's stylesheet and template
bundle carried digests, but the digests came from `app.manifest.json`, which is fetched
with `no-cache` and can change after the document did.

A template is executable. Its bindings run against the component, and its static markup
can frame a page or post a form. A security review showed a remote-folder, CDN or
manifest writer reaching zero-click script through a changed template, and a remote's
bundle seeding the shell's login template. It also showed WebKit importing a module whose
import-map pin didn't match, with nothing on the page noticing. The service worker then
kept whatever arrived under `/assets/` for a year, with no way to retire it.

Four alternatives lost.

**Digests in the manifest.** The manifest is the document an attacker in this model can
rewrite, so a digest it carries vouches for nothing.

**A second inline table, such as a JSON data block.** It would be a second place to keep
in step with the import map, and a second answer to whether the CSP covers it. The import
map's integrity block already holds pins, already sits in the document and is already
admitted by hash.

**Checking the engine by user agent.** A user agent names an engine, not a behaviour, and
the list is wrong the day an engine changes. Verifying a remote module in script before
importing it fails too, because the CSP refuses `blob:` scripts and a verified copy would
break the remote's relative imports.

**Refusing `<iframe>` in templates.** Its `[src]` and `[srcdoc]` already go through sinks,
and ADR-0128 refuses a static `srcdoc`. Refusing the element would remove a supported sink
and close nothing a pin doesn't.

## Decision

The integrity block of the page's import map is the page's one pin table.
`@core/foundation/pins.js` reads it, and every loader fetches under `pinned(url)`, so
changed bytes fail their request.

- The build pins every chunk, template file, template bundle, locale file and the
  stylesheet, plus every asset a composed remote publishes. The stylesheet's `<link>`
  repeats its pin, because browsers read a stylesheet's integrity only from the element.
- Remote pins come last in the block. Composition removes and appends them, so a
  recomposed shell keeps its order, and a rollback restores the same bytes.
- Admission requires every remote asset, whatever its type, to match the page's pin. It
  requires a pin for every template file a remote announces, for the shell's
  `templateBundle` and for every `i18n.bundleFiles` value. A built remote publishes an
  asset record for each split template and each locale file, which is how composition
  learns their digests.
- A remote's template bundle seeds only URLs under its entry's directory. A remote's
  locale bundle merges only keys under the remote's name, and loads a file only when the
  page pins it.
- A shell bundle that fails its pin seeds nothing, and each template then loads under its
  own pin. A remote bundle that fails its pin fails the remote.

Every import map carries three fixed `data:text/javascript` URLs. The two nonempty
URLs contain `export const probe = true;` and differ only in their fragments. One has
the matching digest, and `@core/foundation/pin-probe.js` resolves to the other, pinned
to the digest of zero bytes. The third URL contains no bytes and carries that empty
digest as a matching control.

Before the first remote loads, `pinsEnforced()` requires all three pins and checks
`import.meta.resolve()` for every URL. Exact and scoped remapping cannot substitute
network resources. Both matching controls must import successfully and return their
expected exports before a `TypeError` from the mismatch proves enforcement. The
controls prove that CSP permits both digests. The fixed URLs have no transport,
variable MIME type, syntax error, or evaluation error that could imitate enforcement.
An import rejection alone is never proof.

The production CSP admits the controls by their exact hashes. It does not add a
`data:` or `blob:` script source. `srl check importmap` reports both probe hashes
alongside the inline map's hash for source deployments. A missing or edited pin,
remapped URL, failed control, or unexpected rejection refuses remotes. Inconclusive
checks can be retried; definitive enforcement or ignored-integrity verdicts remain
cached for the page. An engine that imports the mismatch refuses remotes and the
error names the engine.

The Chromium and WebKit regression exercises the runtime module under strict CSP,
checks refusal of a changed network module, and simulates ignored integrity by
omitting browser-parsed pins while leaving the runtime's table intact. It also
checks missing pins, incomplete CSP, retry, shared verdicts, and exact and scoped
remapping. Legacy network probes with syntax, evaluation, MIME, and second-request
failures are refused before any request.

The generated service worker precaches every file except the document against its pin,
and the build refuses a precached file without one. Cache-first stores a response only
when its request carried integrity. The cache name hashes each precached URL with its
digest. `srl build --worker retire` emits a retiring worker instead. It skips waiting,
deletes the application's caches, unregisters and answers nothing, so deploying it as
`sw.js` retires every installed worker at the next navigation.

The production CSP adds `form-action 'self'`. Templates refuse `<object>` and `<embed>`,
which `object-src 'none'` already blocks in a built artifact.

Release activation verifies the release's bytes before it moves the pointer. Under source
delivery, `npm run verify` walks each remote's import graph and requires pins for every
module, Element-owned stylesheet, announced template and locale file it reaches. The
stylesheet inventory comes from the project model's `styles: true` declarations and
includes modules in the entry directory and modules reached outside it. Source
stylesheet loading passes the page pin to Fetch before any rules are adopted or the
Element is defined. Chromium and WebKit regressions mount a styled source remote with
matching CSS and refuse changed CSS without defining its tag or adopting its rules.

## Consequences

- A changed template, bundle, locale file, stylesheet or remote asset fails its request
  instead of reaching the page.
- On Chromium, every page that mounts a remote logs one console error, which is the
  probe's refusal.
- An engine that ignores import-map pins runs no remotes. The shell still runs there,
  and its own chunks go unverified on that engine.
- Under source delivery, editing a remote's template, Element stylesheet or locale file
  means updating its pin in `index.html`, as editing its modules already did. The shell's
  own templates and Element stylesheets stay unpinned there, like its `/src/` modules.
- Under source delivery with no `bundleFiles`, a changed manifest can still point the
  shell's `i18n.bundles` at another same-origin JSON file. `t()` renders text, so that
  reaches words and not markup.
- An engine signal for import-map integrity, or a CSP directive that requires integrity
  on every subresource, would replace the probe or the per-loader pins.
