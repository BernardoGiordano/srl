# ADR-0131: The dev origin admits a request before it maps it

- Status: accepted
- Date: 2026-10-07
- Affects: `cli/origin/index.mjs`, `cli/origin/types.d.ts`, `cli/dev/serve.mjs`, `cli/dev/updates.mjs`, `cli/diagnostics/index.mjs`, `cli/testing/web-test-runner.mjs`, `cli/testing/runner-sockets.mjs`, `editors/vscode/package.json`, `SECURITY.md`

## Context

`cli/origin/` decided which file a URL names, and no module decided whether a request
was addressed to it. A security review found six ways in from the developer's own
browser and network.

- A page on any site posted a `text/plain` body to `/__updates/diagnostics`, which
  needs no preflight. The server printed its message raw, so OSC 52 wrote the
  clipboard, OSC 0 set the window title, and a newline forged a `FAIL` line.
  ADR-0125 had fed network text into `formatLine`, which was built for strings a
  check wrote.
- No module read Host. A page that rebinds its own hostname to 127.0.0.1 reads every
  file served and the update stream. `--proxy` rewrites Host to the upstream's, so a
  backend that checks Host itself saw 127.0.0.1 and answered.
- `srl serve` bound every interface while its banner said `localhost`.
- The test-runner preset served the repository root, `.git/` included, to any Host
  and any peer. `@web/test-runner` binds every interface even when its `hostname` is
  `localhost`.
- Static serving followed a symlink out of its mount, and served `.env`.
- File names and request URLs reached the terminal raw through the update log.

The VS Code setting `srl.nodePath` was `machine-overridable`, so a cloned
repository's `.vscode/settings.json` could choose the executable the extension runs.
Only the extension's default absence from Restricted Mode kept that from running.

Five alternatives lost.

**Admission in each adapter.** Four servers sit on `cli/origin/`, and the preset is a
fifth that shares its mount rules. Copies of a Host check drift the way copies of the
traversal check did before ADR-0075.

**Loopback names only.** A phone on the network reaches `srl serve --host 0.0.0.0` at
an IP address. Rebinding needs a hostname the attacker controls, so a browser sends an
IP literal as Host only when the page's own origin is that address.

**A same-origin rule for every write at the origin.** The proxy forwards cross-site
POSTs a backend also receives in production, such as an identity provider's
`form_post` callback. The backend sees `Origin` untouched and decides. The rule covers
the endpoint the dev server owns.

**Stripping controls.** A visible escape tells the developer something tried to drive
the terminal. A stripped one hides it.

**Refusing every symlink.** A workspace links `node_modules/@srljs/core` to the
package source, and pnpm links every package. Comparing real paths keeps a link that
stays inside its mount.

## Decision

`createOrigin` admits each request before any route or mount sees it.

- Host must name `localhost`, a `*.localhost` name, an IP literal, or a hostname in
  `allowedHosts`. Any other Host, or one that isn't a plain host and port, is 403.
- A path with a dot segment is 403, except `/.well-known/`.
- A file that exists must stay inside its mount once symlinks are resolved.

`cli/origin/` also exports `sameOrigin(request)`. It trusts `Sec-Fetch-Site`, then
`Origin`, and passes a request carrying neither, since a tool that sends one can
already reach a loopback port.

`srl serve` binds 127.0.0.1. `--host` binds another address and the banner warns that
the network can reach it. `--allowed-host` adds a hostname and repeats.

`/__updates/diagnostics` reads a body only from a same-origin request whose type is
`application/json`. That type forces a preflight the server never answers.

`printable()` in `cli/diagnostics/` writes C0, DEL, C1, the bidi controls and the
line separators as visible escapes such as `\x1b`. `formatLine` applies it to every
part, newline included, so it prints one line. `formatText` keeps a message's newlines
and tabs. The update log and the proxy's error lines go through it too.

The test-runner preset's first middleware answers only a loopback peer, admits Host
with `admitsHost`, and 404s a dot segment.

The runner's WebSocket adapter uses the same peer and Host admission before accepting
the handshake. It also requires the browser Origin to match the connection's scheme,
Host, and port. Missing, opaque, and foreign origins are refused. Forwarded headers
and fetch metadata cannot substitute for that Origin.

The adapter validates message types, live session IDs, and required command and
result fields before the upstream parser or async API receives them. Result data
cannot replace session identity or lifecycle fields. Invalid messages close their
socket without stopping the runner. Frame errors, synchronous or returned async
listener failures, and the API's detached command, result, and disconnect work stay
inside the adapter. Rejection diagnostics and the runner's
error logger pass untrusted text through `printable()`.

The upstream dispatcher does not expose listener enumeration or rejection capture.
The adapter isolates its access to the dispatcher's internal Node event emitter and
the API's detached async methods. It refuses startup if those structures change.
Real-runner regressions verify the
handshake, invalid-session refusal, printable diagnostics, listener failure handling,
and a subsequent valid command.

`srl.nodePath` takes `machine` scope, so only user settings set it. The extension
declares `untrustedWorkspaces: { supported: false }`.

## Consequences

- A hostname from `/etc/hosts` or a tunnel needs `--allowed-host`.
- Opening `srl serve` to a phone needs `--host 0.0.0.0`. SECURITY.md keeps a server
  bound to an untrusted network out of scope.
- A page failure whose message spans lines prints `\x0a` between them.
- A workspace's `srl.nodePath` no longer applies.
- `formatText` can still start a new line from a project string with a newline in it,
  though it can't send an escape sequence.
- The test runner's WebSocket upgrade bypasses Koa middleware, so its adapter admits
  the handshake independently and validates messages before upstream dispatch.
- A test-runner dependency update that changes its dispatcher requires an adapter
  update before the preset can start.
- MCP answers carry project text to the agent. The editor guide says so, and nothing
  filters it.
- A page on another origin can still send a GET to the dev server, but without CORS
  headers it can't read the answer.
