# ADR-0139: An external stylesheet carries its author's pin

- Status: accepted
- Date: 2026-10-09
- Affects: `cli/delivery/build.mjs`

## Context

ADR-0129 pins every byte the page runs, and the build refused any stylesheet outside
`/assets/`, because it could not hash bytes it never saw. A web font service's
stylesheet, such as Fontshare's or Google Fonts', is the usual way an application
loads its typeface, and the refusal left two ways round it.

Self-hosting the font means redistributing font files, which some free font licences
forbid. Loading the stylesheet from script at runtime passes the build and pins
nothing.

## Decision

A `<link rel="stylesheet">` to another `https:` origin is kept when it carries an
`integrity` attribute with a SHA-2 digest and a `crossorigin` attribute. The browser
checks the pin, and the build does not fetch or rewrite the link. Any other stylesheet
outside `/assets/` is refused, and the message names both attributes.

The reported CSP adds each such origin to `style-src`.

## Consequences

- The author computes the digest and updates it when the service changes its bytes.
  Until then the browser refuses the stylesheet and the page falls back to the next
  font in its stack.
- The service must answer with CORS headers, or the browser refuses the pinned
  stylesheet.
- Fonts and images the stylesheet loads are not pinned, and the reported CSP does not
  admit their origin, because the build cannot see them. A deployment that enforces the
  CSP adds a `font-src` for them.
- Reopen this if the build should fetch and pin the stylesheet itself.
