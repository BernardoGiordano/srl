# ADR-0041: Production `index.html` is a transform, not a hand edit

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/delivery/production-html.mjs`

## Context

Every `index.html` in this repository ships in development mode: Tailwind v4 is loaded as
a browser script and compiles the stylesheet from a `MutationObserver` on every page load,
with the `<link>` to the compiled `app.css` commented out beside it. That is the right
default for a clone, because `npm start` then works with no build step.

It is the wrong thing to serve, for two reasons, and the second is the one that matters.
The JIT recompiles the whole stylesheet in the browser on every load, so every visitor
pays for a build the CLI already did once. And it rules out the Content-Security-Policy:
the shipped policy was validated with `app.css` linked and the JIT off, the JIT may need
`'unsafe-eval'`, and shipping the two together trades a fixed blank page for a new one.

The file itself says to make the swap by hand — comment out the script, uncomment the
link. Done by hand it is a change that must be made before every deploy and reverted
after it, which is a change that will one day be committed by accident in one direction or
forgotten in the other.

## Decision

The swap happens at deploy time, as a transform on stdout. The repository stays in
development mode, the server always gets production mode, and neither state depends on
remembering.

Both edits are required and a miss is fatal: dropping the JIT without linking `app.css`
produces a page with no stylesheet, which renders — so a smoke test asking for HTTP 200
passes — and is unusable. Each substitution is asserted and the tool exits non-zero if
either fails.

## Consequences

Editing the `<head>` of an application breaks the deploy loudly rather than deploying an
unstyled page.

The import map is deliberately not touched. Its exact text is hashed into the CSP of the
deployed server config, so a transform that reformatted it — even by one space — would
block the map and take module resolution down with it.
