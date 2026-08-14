# UI preference persistence

Every non-auth UI preference crosses one synchronous, versioned boundary:

```js
import {
  configurePreferences,
  createMemoryStorage,
  loadPreference,
  removePreference,
  savePreference,
} from '@core/preferences/persistence.js';

savePreference('search-panel', 'orders', { density: 'compact' });
const state = loadPreference('search-panel', 'orders');
removePreference('search-panel', 'orders');
```

Table columns, filter values, sidebar collapse, the theme and the locale all go through
it. Nothing else in `source/lib` or `source/components` calls `localStorage`, and
`npm run verify` fails the build when something does — the theme used to keep its own
key, so an application that configured its own store got that store for the table and
not for the theme. That inconsistency is now a verification failure rather than a bug
report, checked from the project model's AST rather than a text search, because four
modules mention `localStorage` in prose while calling it nowhere.

Default storage is `localStorage`, one key per owner/id pair under `ui.component-state`.
Preference payloads are small and must be restored before first render; IndexedDB would
make hydration asynchronous without improving capacity or queryability. The prefix keeps
the name the module had when it was `component-state.js`, because it is written into
every key already in a browser.

`configurePreferences({ storage, prefix })` accepts the synchronous
`getItem`/`setItem`/`removeItem` subset shared by Web Storage and memory adapters.
`createMemoryStorage()` is the second real adapter — a suite configures it so cases
cannot inherit each other's preferences, and an embed where storage is blocked by policy
gets preferences that simply do not outlive the tab.

**One failure policy, for every caller**, so none of them writes its own fallback:

- A read that cannot produce current state returns `undefined`: storage missing or
  throwing, no value, malformed JSON, a value that is not an envelope, a schema version
  with no `migrate`, or a `migrate` that throws or declines. Rendering never depends on
  storage having worked.
- A write that cannot store returns `false`: storage missing or throwing, quota
  exceeded, or state that is not JSON-serialisable.
- Nothing throws for a storage reason. The only exceptions are an empty owner, id or
  prefix, and a schema version that is not a positive integer — programming errors in the
  caller, wrong in every environment.

Every entry carries `schemaVersion` and `savedAt`;
`loadPreference(owner, id, { schemaVersion, migrate })` handles schema changes without
unsafe casts. `migrateLegacyKey(owner, id, legacyKey, { accept })` adopts a value an
earlier build wrote under a bare key, exactly once — it is how the theme and the locale
moved into this module without resetting anyone's choice. Two rules make that safe:
`accept` belongs to the caller, because only the theme knows a name is still registered
and only i18n knows a locale is still supported; and the legacy key is removed whether or
not its value was accepted, because a migration is not a permanent second lookup.

**Only preferences belong here.** Never persist tokens, row data or secrets. Auth state
is a separate seam behind `@auth/`, whose stores never hand out a credential, and the
verifier keeps the two apart in both directions: `@auth/` may not import this module
either, because the adapter it would write through is supplied by the application.
Browser storage is shared by accounts using the same browser profile, so include
tenant/user scope in an id when settings must not cross account boundaries.

## Themes

```js
import { configureTheme, setTheme } from '@core/appearance/theme.js';

configureTheme({
  defaultTheme: 'system',
  themes: {
    ocean: {
      colorScheme: 'dark',
      tokens: { '--ui-color-canvas': '#061b24', '--ui-color-primary': '#67e8f9' },
    },
  },
});

setTheme('ocean');
```

`theme`, `resolvedTheme` and `availableThemes` are signals, so a picker renders directly
from them. The selected name is a UI preference like any other and is stored through the
module above. The resolved name is reflected as `data-theme` on `<html>`, and a
`themechange` event lets a framework-independent micro-frontend follow along. Custom
themes may override any property in the `--ui-` namespace; unspecified tokens fall back
to the built-in light palette.

`source/components/theme.css` ships the semantic token palette, light and dark values,
and modest zero-specificity defaults for the elements a component renders itself. Link
it once after the import map:

```html
<link rel="stylesheet" href="/components/theme.css" />
```

Every selector in it is wrapped in `:where()`, so a Tailwind utility or an ordinary
application class wins without `!important`. Layout, sizing and spacing stay entirely
the consumer's.
