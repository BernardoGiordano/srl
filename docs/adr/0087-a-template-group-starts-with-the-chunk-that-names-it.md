# ADR-0087: A template group starts with the chunk that names it

- Status: accepted
- Date: 2026-09-01
- Affects: `source/lib/core/template/template.js`, `source/lib/core/application/runtime.js`, `cli/test/artifact-browser.test.mjs`, `source/lib/test/application/runtime.test.js`, `docs/guide/startup.md`, `docs/guide/delivery.md`

## Context

[ADR-0086](0086-the-manifest-groups-templates-by-chunk.md) gave the manifest a shape —
`templateGroups`, keyed by the chunk whose modules name each template — and then used it
for one thing: startup starts the `entry` group first and every other group a macrotask
later. That ordered the transfers and it did not change who pays for them. Every group
still starts, on every load, for every visitor, before anything asks for one.

Which makes template delivery the one part of this application that does not know what the
session is allowed to see. The reachability set is computed three times over: the sidebar
hides what the scopes do not admit, the route guard refuses to enter it, and
`example/server/api.mjs` enforces it a fourth time on the wire. Delivery is told none of
it, and startup is *structurally* unable to hear it — templates are step 3 and the session
settles at step 6, so the scopes that decide what is reachable arrive three steps after the
requests have left.

On the example application that is the whole signed-in application fetched by a visitor
looking at the login form. 47 of the 50 templates sit behind `requireSession`, in 35 chunk
groups; the login screen reaches three. The role split is smaller and real — `settings-users`
and `settings-audit` behind `users:read` and `audit:read` — and an ERP with a wide role
matrix is where that half starts to cost.

ADR-0086 named this itself, twice. Its "what this does not do" says the router still does
not start a level's group and cannot, because a `RouteDef` carries an opaque
`load: () => import('./pages/orders-page.js')` and nothing maps that closure to the chunk it
resolves to. Its "what would reopen this" says the fix, when it comes, is "start a group
because a level asked for it, not because startup finished".

Both are answered by the same observation, and it is not in the router. The router cannot
name the chunk it is about to import — but the chunk names *itself*, out loud, the moment it
evaluates: `defineComponent` calls `attachTemplate(ctor, url)` from the module body, and that
URL is a member of exactly one group. The fact the router was missing was never needed there.

Two alternatives were rejected.

**Tagging groups with the permission they need** was rejected because it is the leak the
Remote path already avoids. A Remote's markup waits for the guard on its route, not for a
permission written beside its file list, and `requires.permissions` on a descriptor is about
mounting a Remote rather than about fetching its markup. Putting roles in `app.manifest.json`
would publish the role matrix to an unauthenticated visitor and give the entitlement rule a
second home that has to be kept in step with the route table.

**A fact on the route, or a build-time transform of the route table** — the two options
ADR-0086 left open — were rejected as unnecessary rather than as wrong. Either one buys the
group one round trip earlier, started beside the chunk's own request instead of after it.
Neither is needed for the entitlement result, both put a hash-named chunk path into either
an author's hands or a new transform, and the round trip they buy is measured below and is
smaller than the one they cost in machinery.

## Decision

**A group starts on the first `attachTemplate` out of its chunk.** `registerTemplateGroups`
hands `@core/template/template.js` the manifest's partition; `attachTemplate` — which
`defineComponent` calls from the module body, and which is the only place in the system that
knows which chunk is currently running — starts the whole group of the URL it was given
before it awaits that URL. Nine components in one chunk cost one batch of nine requests at
the first of them, which is ADR-0071's serial chain closed per chunk rather than per
application.

**Entitlement is inherited, never restated.** A group carries no permission of its own and
the template module reads none. It starts because a chunk evaluated, and a chunk evaluates
only because something imported it — which for a route chunk is `#prepare`, downstream of
the `#authorize` that already gates that route. Every guard between the visitor and the code
is a guard between the visitor and its markup, for free and without a second copy of the
rule. This is the shape `prepareRemote` has always had, generalised: a Remote's markup is
not fetched until its guard says yes.

**Startup keeps step 3 and loses its tail.** The entry group is still started there, still
without being awaited, because the entry closure is code the document is already fetching
and no guard stands in front of it. `startRemainingTemplates` is deleted: there is no longer
a set of groups waiting for a moment to be started in.

**A deliberate start is a group's start.** `prefetchTemplates` drops each URL it starts from
the group index, so startup's entry group is not started a second time by the first component
that attaches out of it, and a group is started at most once however it is reached.

**Documents with no groups are unaffected.** Source delivery ([ADR-0085](0085-source-delivery-announces-its-templates.md))
carries a flat `templateFiles`, which step 3 still starts whole — development has no chunks
to group by, and no entitlement claim to make about markup it serves with `no-store`.
`bundle` seeds the cache and registers nothing. `split-lazy` announces nothing and each
component fetches its own, as before.

## Consequences

**A signed-out visitor pays for the login screen.** On the example application, `/login`
fetches 3 templates and 5.5 KB of markup where it fetched all 50 and 22,858 B. The 47 it
does not fetch are the ones `requireSession` would have refused, and the two behind
`users:read` and `audit:read` are refused by their own guards on the same rule.

**A signed-in visitor pays for the screens they open.** Measured against the built example,
signed in as `admin`: the dashboard costs 19 of the 50 templates — the entry group, the nine
of `shell-layout`, and the dashboard's own chunk — and navigating on to `/sales/orders` adds
5, for 24 over the session. Under ADR-0086 both visitors fetched 50.

**The cost is one round trip on the first navigation into a chunk, and it is real.** A
chunk's markup now starts when the chunk evaluates rather than while it is still in flight.
On the artifact origin, `/sales/orders`: the chunk requests leave at +0.0 ms through
+9.6 ms and the five template requests leave together at +11.7 ms through +17.7 ms — after
the code they belong to, where ADR-0086 would have had them served from a cache warmed at
boot. What is bought with it is that those five requests are the only five, and that they no
longer compete with the entry document's own transfers for a visitor who never opens that
screen.

**ADR-0086's module cost is refunded.** `runtime.js` no longer imports
`@core/foundation/clock.js`, so the `clock-*.js` chunk leaves the entry closure and the
entry document stops preloading it. `delivery/entry-route` moves from 57 requests to 56 and
46 module requests to 45, with `chainDepth` unchanged at 7 and `templateRequests` unchanged
at 3. That is exactly the request ADR-0086 recorded itself adding.

**The browser test's invariant changes shape, and is stronger for it.**
`cli/test/artifact-browser.test.mjs` asserted that the browser fetched every template the
manifest named, which was the assertion that a deferral had not silently become a dropped
group. It now asserts that the browser fetched exactly the entry group plus the group of
every chunk it actually requested — a template outside that set is one a visitor paid for
without loading the code that renders it, and a template missing from it is a group that was
dropped rather than deferred. It also asserts the set is smaller than the announced one, so
the narrowing cannot quietly become a tautology.

**The template module now holds a fact about the artifact's shape.** It held only caches
before. The justification is that it is where the fact is *observable*: the alternative
places — the router, the mount path — would each have to be handed the chunk identity that
only the module body knows. `registerTemplateGroups` is one setter called once by startup,
and a document that registers nothing behaves exactly as the module did before.

**What would reopen this.** A measurement showing the extra round trip on a first navigation
costs more than the requests it removes — most plausibly on an application whose visitors are
all signed in and whose route chunks are small, where the entitlement win is nearly zero and
every navigation pays. The fix then is the leg this record declined: a fact on the route, or a
build-time transform of the route table, so `#prepare` can start the group beside the chunk's
own request instead of after it. The group index this record installs is what such a change
would call into; nothing about it would have to move.
