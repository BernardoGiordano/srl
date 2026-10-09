# ADR-0138: An application may leave out the collection and locales

- Status: accepted
- Date: 2026-10-09
- Affects: `cli/delivery/build.mjs`

## Context

The production build treated every application as one that renders the shared
collection and ships translations. It required exactly one `/components/style.css`
link, refused a compiled stylesheet without the collection's `--ui-color-canvas` token,
and refused a manifest that named no locale bundle.

The manifest contract already said otherwise. Startup documents `i18n` as optional,
with one `en` locale and no bundles when it is absent, and the collection is a
separate package an application may not use. A port of an existing application with
its own design system and English-only copy failed the build three times, each on a
check that guarded a misconfiguration it did not have.

Two alternatives lost.

**Link the collection's stylesheet and declare an empty locale.** The artifact ships
CSS for elements it never renders and a bundle with no messages, to satisfy checks
about something else.

**Drop the checks.** They catch real mistakes: an application that renders the
collection and forgets its stylesheet ships unstyled components, and a declared bundle
that does not exist ships a manifest that lies.

## Decision

- The `/components/style.css` link is optional, like the palette link already was. At
  most one of each is allowed.
- The compiled stylesheet must carry the collection's tokens only when index.html
  links the collection's stylesheet.
- A manifest without `i18n` builds with no locale files and stays without `i18n`.
  Every bundle a manifest declares must still exist.

## Consequences

- An application that renders the collection without linking its stylesheet is no
  longer caught by the token check. The template checker still knows which elements it
  uses.
- The scaffold keeps both links, so a new project starts with the collection.
- Reopen this if the collection's elements stop working without their stylesheet in a
  way the build could detect from the model alone.
