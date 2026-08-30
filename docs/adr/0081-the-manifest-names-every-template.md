# ADR-0081: The manifest names every template

- Status: accepted
- Date: 2026-08-28
- Affects: `cli/delivery/build.mjs`, `cli/delivery/artifact-report.mjs`, `source/lib/core/template/template.js`, `source/lib/core/application/runtime.js`, `source/lib/core/remotes/mfe.js`, `source/lib/core/remotes/manifest-policy.js`

## Context

[ADR-0071](0071-a-built-template-is-fetched-by-the-component-that-needs-it.md) made split
delivery the default and was right about the delivery. It was wrong about the cost, in a
way a measurement makes plain.

Its consequences say the cost is "one request per component rather than one per
application, which on HTTP/2 overlaps with the chunk that triggered it." It does not
overlap. A component names its own template, so the URL is not known until that component's
module has been fetched and evaluated, and
`@core/elements/component.js` awaits `attachTemplate` *before* `customElements.define` —
deliberately, so an element already in the document is not upgraded without its markup.
Nine of those awaits sitting in one chunk are nine module bodies running in sequence, so
they are nine round trips in a row inside a single 12 KB file, and the router's next level
cannot start until the last one lands.

Measured on a deployed artifact, that is 350 ms of a 1004 ms critical path spent inside one
chunk: `shell-layout-*.js` arrives at 503 ms and the route below it does not begin until
853 ms. A first paint of that application's `/projects` costs roughly twelve separate
template requests spread across three chunks. In the example application, 28 of the 50
templates are under a kilobyte and the smallest is 23 bytes; each of those pays a full
round trip for markup smaller than the request that asks for it.

The fact needed to remove the serial chain was, as in
[ADR-0080](0080-the-entry-document-names-the-graph.md), already computed. The build's
template transform rewrites every `defineComponent` literal with the hashed URL and returns
the whole sorted list, `emitTemplateFiles` writes each one, and `templates.files` records
them in the artifact report. Nothing told the browser.

Three alternatives were rejected.

**Reverting to `--templates bundle` by default** was rejected because it is the decision
ADR-0071 already made and made correctly: one JSON keyed by the hash of every template means
a template that did not change is re-fetched after a deploy that changed another, and it
makes the `templates` startup step blocking for markup a first paint does not use.

**Injecting a per-chunk prefetch call into the emitted chunk** was rejected as the wrong
seam. It is where the fact is sharpest — a chunk's own list, at the top of the chunk — but a
chunk's composition exists only after bundling, and prepending a call there means resolving
which emitted chunk exports `prefetchTemplates` and by what relative path. That is the
document's contents becoming a function of engine version, which is the coupling
ADR-0080 kept out of the artifact for the same reason.

**Naming templates in the entry document**, the way ADR-0080 names chunks, was rejected
because it reaches the wrong set. The document can name the entry's static closure and the
one dynamic import that is always taken. `shell-layout-*.js` is neither: it is a route-level
chunk, and it holds the nine templates the measurement is about.

## Decision

**The emitted manifest names every template the artifact holds, and startup starts them
all.** Under split delivery `app.manifest.json` carries `templateFiles`, the list of URLs
its components will ask for, and startup step 3 — which already existed to seed a bundle —
calls `prefetchTemplates` with it. A Remote's descriptor carries the same list for its own
templates, and the shell starts them in `prepareRemote`, beside the Remote's entry module
and its stylesheets.

`prefetchTemplates` is `loadTemplate` per URL with the result discarded. That is sound
because [ADR-0014](0014-compiled-templates-are-cached-per-url.md) caches the *promise*
rather than the compiled result, "so two components mounting at the same moment share one
request instead of racing two": the nine existing awaits resolve from the cache, each
`await attachTemplate` stays exactly where it is, and the compile path is untouched. A
rejection is swallowed at the prefetch and surfaces at the `attachTemplate` that genuinely
needs it, so a template nobody mounts cannot fail a page.

**Startup does not wait.** `prefetchTemplates` returns synchronously, having started the
transfers. Step 3 is a step because it is ordered — the URLs have to be in flight before the
first component module evaluates — not because anything blocks on it.

**The list is a list, not a bundle.** The files stay separate, hash-named and
`Cache-Control: immutable`, which is the property ADR-0071 exists for and the one this does
not touch: a template that did not change is still not re-fetched after a deploy that
changed another.

**The list is admitted like every other URL in the manifest.** `admitTemplateFiles` puts each
entry through `admitPath` and refuses duplicates. The runtime turns this list into `fetch`
calls under the page's own `connect-src 'self'`, so a cross-origin entry would fail as a
blocked request behind an optimisation nobody is watching; one message at startup is the
better failure. The key is absent in development and under bundle delivery, and admission
returns a frozen empty array either way, so the consumer iterates without a guard.

**Seeding wins when both keys are present.** A bundle puts markup in the cache from bytes
already in hand, which makes a prefetch beside it a set of requests for templates nothing
will read from the network.

**`--templates split-lazy` is the opt-out, and it is this record's own escape hatch.** It
emits the same fifty files and announces none of them, which is ADR-0071's behaviour exactly:
a visitor downloads the markup of the routes they open and pays a round trip per component to
discover it. The delivery flag therefore has three values rather than two, and the branch in
`templateAnnouncement` is on `delivery` rather than on whether a bundle URL came back — the
two split modes emit byte-identical artifacts and differ only in the manifest, so inferring
one from the other would make them indistinguishable.

`split` stays the default because the cost it removes is latency, not bytes. Measured to
first paint against `split-lazy`: 59 ms *slower* at zero added round-trip time, 207 ms faster
at 40 ms, 547 ms faster at 100 ms. The sign flips near zero, which is the one regime real
users are never in — and, as ADR-0080 noted for its own hints, the regime `tools/benchmark`
measures under `--host-resolver-rules`. An application that would rather have ADR-0071's
promise than the latency now asks for it by name instead of being given it by default.

## Consequences

A chunk's markup costs one round trip rather than one per component, at every level rather
than only the shell's, and it is the same round trip the chunk itself is using. The 350 ms
gap between route level 1 and route level 2 closes, and the 28 sub-kilobyte templates in the
example application stop each paying an RTT for less markup than the request header.

**This revises one of ADR-0071's consequences, and it should be stated rather than
implied.** That record promised "a visitor downloads the markup of the routes they open."
They no longer do: they download all of it, in the background, starting at step 3. The
example application is 50 templates and 76,586 B of markup, which is 22,858 B brotli summed
over the files, against a round trip per component on every route a visitor does open. It
is the right trade at any realistic latency and the wrong one on a metered connection with
a visitor who opens one page — which is what `--templates split-lazy` is for.
`cli/test/artifact-browser.test.mjs` asserts both shapes: that `split` fetches exactly the
templates the manifest named, and that `split-lazy` fetches a strict subset of them.

`split` and `bundle` now fetch the same *templates* on a first visit, and the bundle is the
cheaper way to move them. Fifty independently compressed files are 22,858 B brotli; the same
markup as one JSON is 12,698 B, because fifty brotli streams share no dictionary and each
pays its own framing — the 23-byte template costs more in overhead than in content. So
`bundle` now wins the first visit on bytes as well as on requests, and `split` buys one
thing for the difference: per-file immutable caching, where a deploy that changed one
template re-fetches one file rather than all of them. That is the axis the flag actually
sits on — first visit against repeat visits — and it is a sharper one than ADR-0071 had,
where `split` also won the first visit by fetching less. `split-lazy` is the third corner:
the only mode that still wins the first visit on bytes, by not fetching what it does not
need, and the only one that pays a round trip to find out what that is.

A manifest grows by one line per template. In the example application that is 2,811 B of
JSON, 769 B compressed, on a document that is already fetched on every load and already
preloaded by the entry document — so it costs no round trip and no request.

What this does not do. It does not order the list by need: the entries are sorted by tag,
which is what the build already had, and on HTTP/2 they leave together anyway. On HTTP/1.1
fifty of them queue against six connections, which is a worse shape than the serial chain
was for the first template and a much better one by the ninth. And it does not gate chain
depth, so the router still prepares its levels one at a time — a URL's nesting depth is
still paid in round trips, which is the follow-up ADR-0080 also left open.
