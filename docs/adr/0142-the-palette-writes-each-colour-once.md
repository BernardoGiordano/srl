# ADR-0142: The palette writes each colour once

- Status: accepted
- Date: 2026-10-28
- Affects: `source/components/theme-default.css`, `example/src/brand.css`

## Context

The default palette was three blocks. `:root` held the light values. A
`prefers-color-scheme: dark` query held the dark values for `:root:not([data-theme])`, and
`[data-theme='dark']` held the same dark values again. A selector cannot join a media query
to an attribute, so the dark values were written twice. An application that copied the shape,
as the example's brand palette and voiceai's console did, edited both copies hunk for hunk on
every restyle. A token's light and dark values sat a block apart.

The shape also lost a case. The theme controller writes `data-theme` as the resolved name and
an inline `color-scheme`. A registered theme with `colorScheme: 'dark'` matched neither dark
block, so every token it did not list kept its light value. The example's ocean theme listed
every token to get around this.

Two alternatives lost.

- **Generate the dark copies.** The palette is linked and served as written, and nothing
  builds it in development.
- **Register the dark palette through `registerTheme`.** Its tokens arrive only once
  JavaScript runs, so the first paint is light on a dark system.

## Decision

The palette is one `:root` block. A token whose light and dark values differ is a
`light-dark()` pair, and a token with one value for both schemes is written once. `:root`
sets `color-scheme: light dark`, which follows the system preference while no theme is
chosen. `[data-theme='light']` and `[data-theme='dark']` set only `color-scheme`.

A custom property keeps `light-dark()` as written, so each element resolves a pair by its
own used `color-scheme` wherever the colour is used. The controller's inline
`color-scheme` decides the arm for a registered theme too.

## Consequences

- Each colour is one line, and a dark copy cannot drift from another.
- A registered theme takes the arm of its own `colorScheme` for every token it does not
  list.
- `[data-theme='dark']` on a subtree still darkens that subtree. It sets the subtree's
  `color-scheme`, and the tokens resolve under it.
- `light-dark()` needs Chrome 123, Firefox 120 or Safari 17.5. A browser without it
  leaves every paired token unset, which `style.css` already treats as a visible failure.
- `light-dark()` takes colours only. A token that is not a colour, such as a gradient,
  pairs each of its colour stops. A token whose non-colour part differs between schemes
  would need a block of its own, and would reopen this record.
- A script that reads a token through `getPropertyValue` gets the `light-dark()` text.
  It reads the colour from a computed style instead.
- An application palette may keep the old shape. The controller still writes both the
  attribute and the scheme.
