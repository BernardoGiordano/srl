# Invariants and constraints

A change that breaks one of these is a design change, not a refactor. Most are
enforced; the enforcement is named.

| Invariant | Enforced by |
|---|---|
| JavaScript and HTML run without bundling or transpilation | The browser loads the committed files; `npm start` needs no `npm install` |
| Ordinary development needs no persistent compiler | Only `npm run css` builds anything, and only for production CSS |
| Runtime dependencies stay committed, same-origin and integrity-pinned | `npm run vendor`, import-map `integrity`, `npm run verify` |
| No runtime dependency is fetched from npm or a CDN | `npm run verify` fails on an undeclared bare specifier or a cross-origin entry |
| Template expressions avoid `eval` and `unsafe-eval` | `core/template/expression.js` is a parser; the shipped CSP has no `unsafe-eval` |
| The runtime compiler and the static checker share one grammar | Both import `core/template/dialect.js` |
| Trusted Types and context-sensitive sanitisation stay enforced | `core/template/security.js`, the sink tests, `require-trusted-types-for 'script'` in the deployment's CSP |
| Locale switching is reactive and reload-free | `t()` reads a signal; asserted across two independently-owned components |
| The remote host interface never exposes a credential | No method returns a token; `host.auth.fetch` is the only way out |
| Remote contexts are mount-scoped and revocable | Every `mount(host)` gets a fresh frozen context; leaving the route revokes it |
| Light DOM and Tailwind compatibility are intentional | No shadow roots; projection moves real child elements |
| Dependency direction: application → components → host → {core, auth} → vendor | `npm run verify`, failure modes 1–14 |
| Tests exercise real browser source, with no transform and no mock loader | `@web/test-runner` serves the same mounts the application does |
| Production optimisation stays optional and behaviour-preserving | The CSS step, `npm run templates`, a comment strip |

The twelve original constraints, and where each is met:

| Constraint | Status | Where |
|---|---|---|
| No build / compilation time | Met for JS and HTML; one CSS step | `npm run css` is the only build |
| Full typecheck and linting | Met, both type-aware | `tsconfig.json`, `eslint.config.js` |
| Micro-frontends | Met, including a remote sharing no dependency with the shell | `source/lib/core/remotes/mfe.js` |
| Hot-swap components on signal events | Met | `source/lib/core/elements/outlet.js` |
| Full Tailwind compatibility | Met, via light DOM, RTL included | `source/lib/core/elements/projection.js` |
| No runtime dependency on npm or a CDN | Met | `source/lib/vendor/`, `tools/delivery/vendor.mjs` |
| Dynamic routing, Angular-style | Met, child layout routes included | `source/lib/core/navigation/router.js` |
| Composable HTML components | Met | `example/src/ui/app-card.html` |
| Templates separate from logic | Met | `source/lib/core/template/template.js` |
| Runtime internationalisation | Met, plurals, RTL and per-remote bundles included | `source/lib/core/localization/i18n.js` |
| No bloat | Met; see the measured envelope in [the performance envelope](guide/performance.md) | `tools/benchmark/baseline.json` |
| Safely persisted session tokens | Interface plus three strategies; the choice is open | `source/lib/auth/` |
