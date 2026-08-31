# ADR-0085: Source delivery announces its templates, and a reload revalidates

- Status: accepted
- Date: 2026-08-31
- Affects: `cli/delivery/source-manifest.mjs`, `cli/origin/index.mjs`, `cli/origin/types.d.ts`, `cli/dev/serve.mjs`, `example/server/static.mjs`, `example/server/server.mjs`, `cli/test/origin.test.mjs`, `cli/test/serve-templates.test.mjs`

## Context

[ADR-0081](0081-the-manifest-names-every-template.md) closed the serial template chain by
having the manifest name every template, and it closed it in exactly one place: a built
artifact. `cli/delivery/build.mjs` writes `templateFiles` from the files it just emitted.
A source tree has no bundler, so the checked-in `app.manifest.json` carries no such key,
`startApplication`'s templates step is skipped outright, and every template is discovered
the way ADR-0081 was written to stop — a chunk's module body runs, learns its own template
URL from `import.meta.url`, awaits it, and only then does the next module body run.

That record says so in as many words: "The key is absent in development and under bundle
delivery." Absent under bundle delivery is a decision. Absent in development was an
omission, and it meant every delivery improvement of the last month existed in production
and nowhere a developer works. The 350 ms gap between route level 1 and route level 2 that
ADR-0081 measured and closed is still there on every reload of a source tree.

The second half was the cache policy. `cli/origin/` defaults to `Cache-Control: no-store`
for a good reason — a stale module served out of memory cache after an edit is the most
confusing failure a buildless setup has — but `no-store` does not merely prevent staleness,
it deletes the browser cache, so the second reload costs exactly what the first did. The
example application: **776,793 B over 54 requests, every reload.** Nothing measured it;
`delivery/edit-to-reload` is still PENDING and the benchmark's source origin is not either
development server.

Three alternatives lost.

**Precompute the list into `app.manifest.json` and commit it.** It is a generated file in
the source tree, stale the moment a component is added, and a developer would learn it had
gone stale as a 404 on one route. The build already refuses to pass a configured
`templateBundle` through for the same reason.

**Have the runtime discover the list itself.** It cannot. A component names its own
template relative to its module, so the URL exists only after that module has been fetched
and evaluated — which is the chain, not a way out of it.

**A development-only manifest key.** It would give development a second runtime path, and
the value of this change is that there is one: the same key, the same step, the same
`prefetchTemplates`, so a delivery bug shows up while editing rather than at build.

## Decision

**`cli/delivery/source-manifest.mjs` is the second producer of `templateFiles`,** beside
`templateAnnouncement` in `build.mjs` and in the same directory for that reason. It reads
the list from `cli/project-model/` — the same `shippedTemplates` that `npm run templates`
bundles and `npm run verify` checks a bundle against — and hands back the checked-in
manifest with the key filled in. The browser cannot tell which module wrote the manifest
it fetched.

**A Remote's markup is announced on that Remote's entry and never on the shell**, matching
`templateAnnouncement(templateOutput, publicationBase)`. The router runs a Remote's guard
before `prepareRemote`, and markup the shell had already fetched is the request that guard
exists to refuse. A template is attributed to the Remote whose entry URL it sits under.

**It declines rather than fails.** A configured `templateBundle` is left alone, because
seeding wins over a list and a list beside a bundle is requests nothing reads. A project
the model cannot parse — a half-typed module, a clone with no `node_modules` — costs the
announcement and not the server: the file on disk is served unchanged. The model is
imported lazily for that last case, so `npm start` on a fresh clone still works.

**`cli/origin/` owns conditional requests, and they are not an option.** A file streamed
from disk carries a weak `ETag` of its size and mtime, the shape nginx uses and for the
same reason: answering a conditional request must not cost reading the file the answer
says not to send. An `If-None-Match` naming it is answered 304, with the `Content-Type`
dropped and everything else the 200 would have said about caching the URL repeated. A
transform carries no validator unless it states one, because stat describes the file and
not what a transform made of it; the generated manifest states a hash of its own bytes and
so revalidates like everything else.

**Both development servers state `no-cache`.** Whether a browser ever asks is policy and
stays the adapter's; the rule about files is the origin's.

**`example/server/static.mjs` becomes the fifth adapter over `cli/origin/`.** It was a
fifth hand-written implementation of the mount walk, the traversal refusal, the history
fallback and the content type — the copy ADR-0075 missed, and the one that mattered most,
because it is what `npm run example:serve` starts and so the server a developer of the
example application is actually looking at.

## Consequences

Measured on the example application, reload to reload:

| | requests | transferred |
|---|---|---|
| before | 54 | 776,793 B |
| after | 101 | 30,300 B |

More requests, because the fifty templates now start at step 3 instead of being discovered
one module body at a time; a twenty-fifth of the bytes, because every one of the 101
revalidates. All fifty start within 1.5 ms of the manifest landing, and signing in — which
mounts the whole shell — then fetches **zero** templates, because they are already in the
source cache. An edit is the one whole body in an otherwise entirely 304 reload.

**A cold development load now costs what production's `split` costs**, which is the trade
ADR-0081 already made and its consequences already state: 107 KB of markup for routes the
visitor has not opened. Candidates 4 and 5 of the 2026-08-31 review are what narrow it, in
both deliveries at once, and this change is a precondition for measuring either.

**The stale-module guard is weaker than `no-store` by exactly one case:** an edit that
changes neither size nor mtime. A checkout that restores an old timestamp at an identical
byte count is the only way to produce one, and `touch` is the fix. This is the trade to
revisit if it ever bites; the alternative is hashing every file on every request, which
turns a 304 into a full read of the file it exists to avoid sending.

**ADR-0081's "the key is absent in development" no longer holds**, and that sentence should
be read as describing bundle delivery only.

**What would reopen this.** A measured `delivery/edit-to-reload` workload, which does not
exist yet — the benchmark's source origin serves a production cache policy and is not
either development server, so nothing here is gated. Candidate 7 of the same review is
that gap, and until it closes these numbers are a measurement rather than a budget.
