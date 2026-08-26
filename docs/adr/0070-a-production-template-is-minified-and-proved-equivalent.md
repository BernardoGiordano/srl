# ADR-0070: A production template is minified, and the minified bytes are proved equivalent

- Status: accepted
- Date: 2026-08-26
- Affects: `cli/delivery/template-html.mjs`, `cli/delivery/build.mjs`

## Context

A component's template is authored HTML: indented so it can be read, commented so it can
be understood. The runtime compiler reads it with `innerHTML` and a tree walk that skips
comment nodes outright, so every byte of that indentation and every word of those comments
is paid for on the wire and discarded on arrival.

It is not a rounding error. The 25 templates of one application built on this framework
were 71,000 bytes of markup, 18,900 of them whitespace, plus design notes written for the
next reader. Minified they are 47,500 bytes: 12.9 KiB to 7.8 KiB Brotli, a third of the
markup gone with nothing rendered differently.

What stood in the way was an invariant worth taking seriously. The optional template bundle
is behaviour-preserving because it compiles nothing — the same compiler runs over the same
bytes in development and in production, so a bundling bug cannot change how a template
renders ([ADR-0042](0042-the-template-bundle-is-per-application.md)). Minification breaks
exactly that: production would serve bytes no developer ever looked at, and a greedy
transform is a rendering bug that appears only in the artifact.

## Decision

The artifact build minifies every template, and proves each result equivalent to its
source before it can be emitted.

The transform drops comments, collapses each run of ASCII whitespace in text to one space,
collapses `class` as the token list it is, and trims the template's own edges. It never
*removes* a run of whitespace, because `a<span> </span>b` and `a<span></span>b` are two
different renderings. It leaves whole subtrees alone when the markup says whitespace
matters there: `pre`, `textarea`, `script`, `style`, an inline
`style="white-space: pre-wrap"`, or a Tailwind `whitespace-pre*` class. parse5 owns HTML
syntax, as it does for `index.html` ([ADR-0041](0041-production-html-is-a-transform-not-an-edit.md)).

The proof replaces the invariant it breaks. `templateShape` reduces markup to the token
stream the compiler cares about — every element with its attributes, every text run with
its whitespace normalised, text inside a preserving element byte for byte — and
`minifyTemplate` throws when source and output disagree, naming the node that differs. The
verification is inside the transform rather than beside it, so no caller can take the bytes
without the proof.

The name follows the bytes: a template is hash-named after what is served, not after what
was authored, so the URL cannot stay still while its content changes.

## Consequences

Development serves authored bytes and production serves minified ones, which is a real
difference and the reason the proof exists. A transform that deletes a node, reorders one,
drops an attribute or eats the one space between two words fails the build with the
template named, rather than shipping a page that renders subtly wrong.

The one case the build cannot see is a stylesheet: an element made preformatted by a class
of the application's own, with no `whitespace-pre*` token and no inline `white-space`, has
its literal whitespace collapsed. Both escape hatches are markup on the element, and `<pre>`
is the one to reach for first. This is stated in the guide beside the dialect it constrains.

`npm run templates`, the optional bundle for a deployment with no build step, still writes
authored bytes: nothing verifies its output, and unverified minification is the one thing
this decision refuses.
