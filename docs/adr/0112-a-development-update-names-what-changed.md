# ADR-0112: A development update names what changed

- Status: accepted
- Date: 2026-09-11
- Affects: `cli/dev/updates.mjs`, `cli/dev/update-client.js`, `cli/dev/serve.mjs`, `example/server/static.mjs`, `example/server/server.mjs`, `cli/test/serve-updates.test.mjs`, `tools/benchmark/workloads.mjs`, `docs/guide/delivery.md`, `docs/reference/source-layout.md`, `docs/architecture.md`, `docs/position-and-non-goals.md`

## Context

[ADR-0111](0111-an-edited-template-revises-the-page-rendering-it.md) made an edited `.html`
file something a live page can apply: `reviseTemplate` recompiles it and renders it into
the hosts already showing it, and nothing in the repository called it. The development
server was the reason. It knew a file had changed and told the browser the word `reload`.

Three things were missing, and each was thrown away in a different place. The watcher had
the changed filename and spent it on a log line. The debounce that turned an editor's
three writes into one event also merged a three-file save into one message with nothing in
it. And a browser that reconnected after a gap had no way to ask what it had missed,
because the messages carried no identity to ask against.

Disposal was missing too. `startWatching` started a recursive watch per mount and returned
nothing, so closing the server closed the HTTP listener and left the watchers running for
the life of the process. A suite that starts a server per case leaks one recursive watch of
the repository per case.

The example application's server had none of it. It is the server `npm run example:serve`
starts, it is an adapter over `cli/origin/` exactly as the development server is
([ADR-0075](0075-one-application-origin-not-four-servers.md)), and it reloaded nothing
because the reload client lived in the other file.

## Decision

**One module owns the session, and both servers are adapters over it.**
`cli/dev/updates.mjs` holds the watchers, the mount table read backwards, the batching, the
event stream, the history a reconnect is answered from, and the disposal. `cli/dev/serve.mjs`
and `example/server/static.mjs` each state one thing — start a session over my mounts — and
neither repeats the mapping or the cleanup. Two consumers are what make it a seam rather
than a file move; a third would not change its shape.

**A change is named by the URL the browser fetched it by.** The mount table already maps a
URL prefix to a directory, and an edit asks the same question from the other end. Longest
target first, which is the same rule as "first matching prefix wins" seen backwards. A path
on disk would be useless to the page: it names no URL the page ever requested and no cache
entry it holds.

**A multi-file save is one update.** The coalescing window is what turns an editor's
truncate-write-rename into a single event, and it is also what makes a three-file save one
message carrying three URLs. The old debounce did the first and destroyed the second by
keeping only the most recent filename.

**The gap is answerable.** Each batch carries `<session>.<n>`. A browser reconnects with
`Last-Event-ID`, and the session replays the union of everything after that id, or answers
`{"reload":true}` when the id is from a previous process or older than the retained window.
Without the session token the ids alone could not tell a restarted server from a live one,
because a fresh process numbers from 1 as well — and a restarted development server is
precisely the case where a reload is right.

**Policy is the browser's half, and it is a module rather than a string.**
`cli/dev/update-client.js` maps `.html` to a revision, `.css` to a stylesheet swap and
everything else to a reload. It is a file, not an injected string, so it type-checks with
the rest of the repository and `planUpdate` — the whole decision — is asserted in Node
without a browser. The injected tag holds the connection and nothing else, which is what a
developer finds when they ask what the page is doing.

**A fallback is a reload, never silence.** A `.css` file no `<link>` names is reachable
through an `@import` or a build step this cannot see. A template URL that 404s has been
deleted or renamed. An application served without an import map cannot reach
`@core/template/template.js` at all. In each case the page is already stale, and the reload
the developer would have got anyway is the honest answer.

**A reload decides its whole batch.** Revising a template and then reloading the page
spends the revision on a render nobody sees, so a batch containing one module edit is a
reload outright.

**A directory is not an edit.** `mkdir` and a rename both report the directory as well as
what moved inside it, and `/src` is a URL no page fetched, which the client would answer
with a reload. A file that no longer exists is still announced: a deleted template is a
page that has gone stale, and the client's fetch of it is what says so.

**The scratch half of an atomic save is ignored.** An editor that saves atomically writes
`page.html.tmp` and renames it. Only the rename is the edit, and announcing the scratch
name hands the browser a URL ending in `.tmp` — which it answers, correctly and uselessly,
with the reload this exists to avoid.

**Rejected: sending the file's bytes down the stream.** The browser can fetch the URL it
was just given, the origin already sends an `ETag` and answers `If-None-Match`, and a
stream carrying file contents makes the delivery path care about encoding, size and
binary files. The bytes a page applies should come from the same request any other page
would make.

**Rejected: a generic hot-module protocol.** ADR-0111 refused one for the runtime, and the
same argument holds here. Three answers exist because three answers are what the framework
can honestly give; a published `{ type, payload }` envelope would be a shallow module with
one producer and one consumer.

**Rejected: leaving the example server on reloads.** It is the server a developer of that
application actually looks at. Two servers that disagree about what a save does is the
divergence ADR-0075 closed for the mount walk, reopened one directory over.

## Consequences

`/__updates` and `/__updates/client.js` are the two URLs on a development origin that are
not files. Both are injected into the response and never into `index.html`, so the bytes
this server sends and the bytes nginx sends are still the same.

`serveApplication` and `staticOrigin` both hand back a `close` that ends the watchers and
the open streams. A suite that opens a server per case no longer leaks a recursive watch
per case, and `npm run example:serve` releases its watchers on SIGINT alongside the ticker.

`example/server/server.mjs` takes `--no-watch`, matching the development server's flag.
`--api-only` never imports the static half at all, so a deployment starts no watcher.

`cli/dev/update-client.js` is the one browser module in `cli/`, so `tsconfig.json` includes
`cli/**/*.js` — the same entry `tools/**/*.js` already has for the benchmark's workloads.

The measured claim is still pending. `delivery/edit-to-reload` has no number, and it now
has two questions behind one name: how long a template edit takes to become visible, and
how long every other edit takes to come back as a reload.

**What would reopen it:** a second producer of updates, such as a CSS build step that wants
to publish its output rather than have the watcher notice the file. A need to carry DOM-held
state across a revision, which is ADR-0111's question and not this one. Or JavaScript
replacement, which stays a non-goal and would need element identity settled first, not a
delivery channel.
