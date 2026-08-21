# ADR-0065: The session guard sits on one shell route; scope guards are affordances

- Status: accepted
- Date: 2026-08-12
- Affects: `example/src/routes.js`, `example/server/api.mjs`

## Context

A route table can require a session per leaf or once at a parent. Per leaf, every route
added later is a route that might be added without it, and the omission is invisible until
somebody signs out.

Separately, a screen a user is not entitled to see can be handled three ways: hide the
control, guard the route, or let the server refuse. Hiding the control is not a boundary at
all — the URL is still reachable — and letting the server refuse produces a screen full of
failed requests with no explanation.

## Decision

Nearly every route is a child of one route whose path is `''`: the shell. Its `canActivate`
is the only place `requireSession` appears, so there is no leaf that can be added without
it, and its component renders the sidebar, the header and the `<x-route-outlet>` its
children land in.

Guards run parent to child on every navigation, so a session that ends while the user is
inside the application is caught on their next click rather than only on entry.

Scope guards sit on the leaves that need more than a session. They are not the security
boundary: the server enforces the same scope on every request. They exist so that a user
without an entitlement sees `/forbidden` instead of a screen full of failed requests.

## Consequences

The route table stays the place where "who may be here" is answered once, and the server
stays the place where it is enforced. Neither is a substitute for the other, and the suite
asserts the entitlement rather than asserting that a control is hidden.

Two routes are deliberately eager rather than lazy — the login screen and the not-found
page — because a route table that needs a network request to tell you a URL is wrong is
worse than one that costs two kilobytes.
