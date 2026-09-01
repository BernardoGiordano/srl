# ADR-0086: The manifest groups templates by chunk

- Status: accepted
- Date: 2026-09-01
- Affects: `cli/delivery/build.mjs`, `cli/delivery/entry-hints.mjs`, `source/lib/core/remotes/manifest-policy.js`, `source/lib/core/remotes/types.d.ts`, `source/lib/core/application/runtime.js`, `cli/test/artifact.test.mjs`, `cli/test/artifact-browser.test.mjs`, `source/lib/test/application/runtime.test.js`, `source/lib/test/remotes/manifest-policy.test.js`, `tools/benchmark/baseline.json`

## Context

[ADR-0081](0081-the-manifest-names-every-template.md) had the manifest name every
template and had startup start all of them, and it was right that the fact was already
computed and thrown away. It was incomplete about *which* fact. Its own consequences say
so: "It does not order the list by need: the entries are sorted by tag, which is what the
build already had."

The build holds more than the list. `TemplateAsset.module` is the absolute path of the
module that called `defineComponent`, recorded when the template transform rewrites the
literal. `chunkRelationships` reduces every module of every emitted chunk to a
repository-relative name and writes the result to `artifact.json`. Both are in scope, in
the same function, four lines apart — and `asset.module` is read at zero call sites. The
join that says which chunk needs which markup exists in the process and is discarded at
the manifest, so the runtime receives a list with no shape and has exactly one move
available: start all of it.

On the example application that is 50 requests at step 3, before a route is known, when
the entry closure paints with three. On HTTP/2 they leave together and the cost is
bandwidth and connection contention against the entry's own chunks; on HTTP/1.1 the three
that matter queue behind forty-seven that do not, which ADR-0081 named as the shape it was
accepting.

The same missing shape is why `cli/delivery/entry-hints.mjs` documents a promise nothing
can keep. It says route chunks are not hinted from the document because "that chain is
shortened where it is actually known — in the router, which knows the levels a URL
enters." There is no template prefetch call anywhere in the router, and until the manifest
is grouped there is nothing for one to call: the router would have to hand over a list it
has no way to derive.

Two alternatives were rejected.

**Carrying both keys — the groups and the flat list** — was rejected because it is one
copy of the truth and one copy of the habit it replaces. The flat list under `split` is
the same fifty URLs with the shape removed; a document that says both invites a consumer
to read the cheaper one, and the flat union a caller may still legitimately want is one
`flat()` away from the groups.

**Grouping by route rather than by chunk** was rejected because the build has no route
table. `cli/project-model/` parses component declarations, not `routes.js`, and a chunk is
the unit the browser actually fetches — two routes in one chunk share its markup whether
or not a grouping says so.

## Decision

**Under `split` delivery `app.manifest.json` carries `templateGroups` and no
`templateFiles`.** Keys are the build's names for its own output: `entry`, then
`chunk:<emitted path>` for every other chunk, sorted with `entry` first. Values are the
template URLs named by modules that chunk holds. `groupTemplates` performs the join —
`portableModule(asset.module)` against `chunk.modules`, which is the normalisation the
build already applies to the entry module — and fails the build on a naming module no
chunk claims, because the alternative is a template in no group, announced nowhere, and
invisible from outside.

**`entry` is the closure the entry document already preloads.** The entry chunk, its
static imports transitively, and the dynamic imports the entry chunk itself makes with
their static closures — the same rule `entryHints` uses, deliberately: the markup a first
paint needs is the markup whose code the document was already fetching. Route chunks are
dynamic imports of the root module, not of the entry, so they stay out of it.

**Startup step 3 starts the entry group. The rest start after startup, on a yielded
macrotask.** `startRemainingTemplates` runs when `startApplication` is otherwise done and
goes through `@core/foundation/clock.js`, at zero delay. The delay is not the point; the
yield is. `startApplication` resolves into the root element connecting and the router
resolving its first URL, and those requests should reach the network first. A named
duration would be a number nobody could defend; a single yield is the ordering, stated.

Every template is still started eagerly, still before anything asks for it. ADR-0081's
promise is kept in full — what changes is that the three the first paint needs no longer
leave in the same batch as the forty-seven it does not.

**`templateFiles` stays, and stays derived.** `admitManifest` flattens the groups, entry
first, into the same frozen array the key always produced, so "every template this
artifact holds" remains one property and no consumer has to know how the document was
partitioned. A document carrying both keys is refused: it is a generator that could not
decide, and one message at startup is cheaper than a list started twice.

**The other two delivery modes are untouched.** `bundle` carries `templateBundle` alone.
`split-lazy` carries `templateFiles: []`, present and empty, which is the statement
ADR-0081 wanted it to make. Source delivery ([ADR-0085](0085-source-delivery-announces-its-templates.md))
carries `templateFiles` because development has no chunks to group by, and startup falls
back to it unchanged. A Remote's descriptor carries its own `templateFiles` and is not
grouped: a Remote is one artifact fetched as a unit, and `prepareRemote` already starts
its markup beside its entry module.

## Consequences

The entry cost of the example application falls from 50 template requests at step 3 to
3: `app-root`, `login-page` and `not-found-page`, which are the templates named by the
root module chunk and the only ones a first paint can reach. The other 47 sit in 35 chunk
groups — nine of them in `shell-layout-*.js`, which is the chunk ADR-0081's measurement
was about — and move behind the first navigation's own transfers instead of competing
with them. Chain depth is unchanged: this reorders transfers, it does not add a level, so
the win ADR-0081 bought is intact.

The manifest grows, and by more than the flat list cost. The example application's
`app.manifest.json` goes from 9,263 B to 11,311 B, 2,669 B to 3,090 B brotli — 35 chunk
keys, each a hash-named path. That is 421 compressed bytes on a document that is fetched
on every load, already preloaded by the entry document, and costs no round trip and no
request of its own, bought against 47 requests that no longer leave at boot. Naming the
chunks by a shortened key would recover most of it and would make the manifest's names
stop matching the artifact's, which is the trade ADR-0080 refused for the same reason.

**Startup's deferral costs one module in the entry graph, and it is a real cost.**
`startRemainingTemplates` schedules through `@core/foundation/clock.js`, which was reached
only from route-level chunks before — the table, the sidebar, the dynamic filter. Importing
it from `runtime.js` puts it in the entry closure, so the artifact emits a `clock-*.js`
chunk the entry document now preloads. Measured on the example application:
`delivery/entry-route` moves from 56 requests to 57 and 45 module requests to 46, with
`chainDepth` unchanged at 3 on the dist origin and 7 on the source origin — the module
joins a level that already existed rather than adding one. On the source origin, which
serves commented source, that request and this record's own new prose are 9,457 B; the
production artifact's `delivery/artifact-size` totals do not move at all.

One module request against 47 template requests off the boot window is the trade, and it
was taken deliberately over the alternative: a bare `setTimeout` in `runtime.js` costs
nothing and makes this the first module in the library to schedule a callback outside the
seam ADR-0079 built for exactly that. A one-macrotask yield has no duration for a suite to
sleep past, so the seam's original argument does not quite reach it — which is the reason
this is worth stating rather than assuming.

**A consumer reading the raw document under `split` no longer finds `templateFiles`.**
Anything reading the admitted manifest through `admitManifest` is unaffected, because the
union is derived there; anything reading the JSON directly has to read the groups.
`cli/test/artifact.test.mjs` and `cli/test/artifact-browser.test.mjs` read it directly and
were updated, and the browser test's assertion is the one that matters: the set of
templates the browser actually fetches still equals the whole announced set, so the
deferral is a reordering and not a silent narrowing.

**What this does not do, and it is the half the review that prompted it asked for.** The
router still does not start a level's group in `#prepare`. It cannot: a `RouteDef` carries
`load: () => import('./pages/orders-page.js')`, an opaque closure, and neither the router
nor the build has a fact that maps a route to the chunk that import resolves to — the
build parses component declarations, not route tables, and the emitted chunk path exists
only inside the rewritten import. Closing that needs a fact on the route or a transform of
the route table, which is its own decision. What this record changes is that the fact the
router would need is now *in the manifest* rather than absent from it: a hover prefetch or
a `#prepare` hook becomes one call against `templateGroups`, keyed by a chunk, instead of
a list nothing can derive.

**What would reopen this.** A measurement showing the yielded macrotask arrives too late —
that a second navigation regularly beats the deferred groups to the network and pays
ADR-0071's per-component round trip after all. The fix then is not a longer or shorter
delay but the router leg above: start a group because a level asked for it, not because
startup finished.
