# ADR-0137: The dev server fills the Tailwind input from `app.css`

- Status: accepted
- Date: 2026-10-09
- Affects: `cli/dev/tailwind-source.mjs`, `cli/dev/serve.mjs`, `cli/scaffold/application.mjs`

## Context

Development compiles Tailwind in the page from `<style type="text/tailwindcss">`
blocks. The build compiles `src/app.css` with the Tailwind CLI. The browser compiler
cannot follow an `@import` to a file, so an application wrote its theme, custom variants
and base rules in the inline block and again in `app.css`. One port carried 184 lines in
both places. The scaffold showed the drift already, because its `dark` variant was in the
block and missing from `app.css`.

Two alternatives lost.

**Link the compiled `app.css` in development.** It needs a Tailwind watch process beside
`srl serve`, and the page would stop compiling classes added in the browser.

**Teach the browser compiler to load files.** That changes vendored bytes the pin table
answers for.

## Decision

An empty Tailwind block names its stylesheet.

```html
<style type="text/tailwindcss" data-source="src/app.css"></style>
```

`srl serve` fills it when it sends the entry document.

- The stylesheet must be inside the application directory.
- `@import 'tailwindcss'` is dropped, whatever follows it. The browser compiler adds
  it to an input with no import, and Chrome's preload scanner would otherwise request
  `/tailwindcss` from the raw block.
- A relative import inside the application is inlined in place, and a cycle stops.
- An import outside the application is dropped, because index.html links what the page
  needs from the library.
- `@source` with a path is dropped, because the browser compiler scans the page.
  `@source inline(…)` stays.

The file on disk keeps the empty block, and the build removes it as before. The scaffold
writes the block, and its `app.css` carries the `dark` variant.

## Consequences

- One file styles both development and the build.
- Editing `app.css` reloads the page, because no `<link>` names it.
- A stylesheet that imports a package by bare name loses that import in development.
- Reopen this if the browser compiler gains file imports.
