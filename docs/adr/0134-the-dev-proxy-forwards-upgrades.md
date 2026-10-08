# ADR-0134: The dev proxy forwards upgrades

- Status: accepted
- Date: 2026-10-08
- Affects: `cli/dev/serve.mjs`, `cli/README.md`

## Context

ADR-0075 made `srl serve --proxy` the way an application develops on the origin it
deploys to. A WebSocket under a proxied prefix never opened, though. The proxy relayed
requests and responses, and a backend that switches protocols sends no response for it
to relay, so the page's socket hung. The same page worked behind nginx.

An application with a socket therefore pointed it at the backend's own address in
development and at the page's origin in deployment. That is one more value per
environment, in a runtime document. Since ADR-0123, admission refuses a manifest key it
does not know, so the value had nowhere to live.

Three alternatives lost.

**A second origin in development.** The page opens its socket on the backend's address.
Deployment has no such origin, so the application carries a setting that exists only to
undo the difference, and the backend has to admit a cross-origin handshake it never sees
in production.

**A same-origin rule for proxied upgrades.** The test runner's adapter refuses a foreign
Origin, because its sockets are the dev server's own endpoint. A proxied socket is the
backend's. ADR-0131 already left forwarded writes to the backend, which sees `Origin`
untouched and decides, as it does behind nginx.

**A WebSocket-aware proxy.** The proxy joins two sockets and has no reason to read the
frames between them. Any other upgrade protocol passes the same way.

## Decision

`srl serve` answers the server's `upgrade` event.

- The upgrade meets the origin's Host admission first. A refused Host is 403.
- Only a path under a `--proxy` prefix upgrades. Any other is 404, because nothing on
  disk speaks a socket.
- The request goes to the backend with every header the browser sent. Host is rewritten
  to the upstream's, and Origin is untouched.
- A 101 from the backend reaches the browser as written, and the two sockets are joined
  byte for byte. Any other response reaches the browser as written too, with
  `Connection: close` ending its body. A backend that is not running is a 502.
- Closing the server ends every joined socket, because an upgraded socket leaves the
  HTTP server's connection tracking.

## Consequences

- A page opens its socket on its own origin in development and behind a reverse proxy
  alike, so it needs no socket address per environment.
- A backend that compares Origin with its own Host sees the upstream's Host, as for any
  proxied request, and has to admit the dev origin explicitly.
- A joined socket stays open until either end closes it or the server stops.
- Reopen this if a backend needs the proxy to rewrite or strip a handshake header.
