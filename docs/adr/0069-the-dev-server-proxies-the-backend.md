# ADR-0069: The development server proxies the backend, so the application develops on one origin

- Status: accepted
- Date: 2026-08-25
- Affects: `cli/dev/serve.mjs`, `cli/bin/srl.mjs`, `cli/test/serve-proxy.test.mjs`

## Context

[ADR-0067](0067-the-toolchain-is-a-second-package.md) published the toolchain so that a
repository deploying an srl application needs no srl checkout. The first repository to
install it kept one file back: its own development server, a hand-written copy of this
one's mount table with ten lines of proxy added.

That application has a backend, and its session is a cookie the backend sets — the
backend-for-frontend arrangement, where the browser never holds a token and the API is
reached through the origin that served the page. In production one nginx serves `/` from
the static tree and routes `/api/`, `/auth/` and `/media/` to the application server. One
origin, which is what makes the cookie work at all.

A development server that serves only files cannot reproduce that, and the three ways
around it are each worse than the problem:

- **Two origins.** The page on `:8000`, the API on `:8001`. The session cookie is now
  third-party, which means `SameSite=None; Secure` and a CORS preflight on every call —
  cookie attributes and request patterns the deployment never uses. The application is
  developed against an arrangement it does not ship, and the first thing that breaks in
  production is the part development could not exercise.
- **A second server beside this one.** What the consumer actually did. It re-implements
  the mounts, the history fallback and the live reload in order to add the proxy, and its
  copy of the mount table is a copy: this repository moved `/lib/` and nothing told it.
- **A proxy in front of both.** Correct, and a third process plus a config file to run
  `npm start`.

## Decision

`srl serve` takes `--proxy <prefix>=<origin>`, repeatable. A matching request is forwarded
upstream and the answer streamed back, status and headers untouched.

**Routes, not rewriting.** The prefix is not stripped and the path is not rearranged. In
production those prefixes are a location block in nginx; a flag that could rewrite paths
would be a second routing table to keep in step with the first, and a development server
that rewrites is a development server that hides a deployment bug.

**Untouched headers.** `Set-Cookie` arrives with the `Path`, `SameSite` and `HttpOnly` the
backend chose, a 401 stays a 401, a redirect is passed to the browser rather than followed
here. The one header rewritten is `Host`, which has to name the upstream for a backend that
routes on it. The application sees through this server what it will see through nginx.

**Ahead of the static rules.** The proxy is consulted before the method check and before
the history fallback, because both are rules about files. A `POST` to `/api/session` must
not be answered 405 by a server that is correct to refuse a `POST` of a stylesheet, and a
`GET` of an endpoint the backend does not have must 404 from the backend rather than
quietly return `index.html` — the failure that reads as `Unexpected token '<'` somewhere
unrelated.

**A segment boundary.** `--proxy /api` claims `/api` and `/api/...` and never `/apiary`,
the same rule the mounts use.

Still zero dependencies: `node:http` and `node:https` forward a request in about forty
lines, and every alternative is a dependency in the tool that a fresh clone has to install
before `npm start` works.

## Consequences

A repository with a backend runs the published server, and the mount table has one
definition again. `npm start` is one process for the static side and whatever the backend
already was — this server does not start it, and says so plainly when nothing answers:

```
{"error":"backend_unavailable","detail":"nothing answered on http://127.0.0.1:8001"}
```

What this is not: a production proxy. There is no load balancing, no retry, no TLS
termination, no timeout of its own. It is a development convenience whose entire purpose is
to make one origin in development mean what one origin means in deployment, and a
repository that wants more than that wants nginx, which it already has.

The behaviour is tested against a real upstream over a real socket in
`cli/test/serve-proxy.test.mjs` — the method, the body, the query, the cookie in both
directions, the upstream 404 that must not become `index.html`, the segment boundary, and
the 502. Each of those has a wrong answer that looks like an application bug rather than a
server one, which is why they are pinned rather than left to a smoke test.
