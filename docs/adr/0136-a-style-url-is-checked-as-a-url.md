# ADR-0136: A style `url()` is checked as a URL

- Status: accepted
- Date: 2026-10-09
- Affects: `source/lib/core/template/security.js`

## Context

The style sanitizer dropped any value containing `url(`. A cover image painted as a
background, `background-image: url(/api/cover/7)`, therefore needed
`bypassSecurityTrustStyle` and a hand-written same-origin check in every component that
drew one. The same URL bound to `<img [src]>` passes the URL sanitizer with no review.

The rule existed because CSS escapes and comments make it hard to tell what a `url()`
reads. That stays true for an argument written with them.

Two alternatives lost.

**Keep the drop.** Each caller reviews a bypass for a value the URL sink accepts unreviewed,
and a bypass that wraps a whole style trusts more than the URL.

**Parse the declaration with the browser's CSS parser.** It would read escapes and comments
correctly, but a parser that reads more than the sanitizer allows is a second definition of
what is safe.

## Decision

`sanitizeStyle` reads each `url()` it can read with no ambiguity: a quoted argument with no
backslash or line break, or a bare one with no whitespace, quote, parenthesis or backslash.
Each argument must be a relative URL, an `http:`, `https:` or `blob:` URL, or a base64
`data:image/` URL in a format the URL sanitizer already accepts. A failing argument drops
the value.

The rest of the value is checked as before. Any other `url(` spelling, `image-set(`,
`src(`, `@import`, `expression(`, a backslash or a comment drops it.

## Consequences

- A cover image or a gradient over one needs no bypass.
- A value can make the browser fetch a URL it names, as an `<img>` binding can.
- Sanitized HTML keeps a safe `url()` in an inline style, because it uses the same rule.
- Reopen this if a CSS parser change makes a readable `url()` fetch something other than
  its argument.
