# UI preference persistence

The preference service stores UI settings through one synchronous, versioned API.

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

Table columns, filters, sidebar state, theme, and locale all use this service.
`npm run verify` rejects direct `localStorage` calls in the library and
collection, so an application can replace storage for every UI preference
at once.

The default adapter uses `localStorage` and one key per owner and id under
`ui.component-state`. Synchronous reads restore small settings before first
render. The prefix stays stable for existing saved preferences.

`configurePreferences({ storage, prefix })` accepts the synchronous
`getItem`/`setItem`/`removeItem` subset of Web Storage. `createMemoryStorage()`
keeps tests isolated and supports an embed that cannot use browser storage.
Its preferences last only for that page session.

Storage failures follow one policy.

- A read returns `undefined` when storage is unavailable, data is invalid, or
  migration cannot produce the requested version.
- A write returns `false` when storage refuses the value or the value cannot be
  serialized as JSON.
- Invalid owner, id, prefix, and schema version arguments throw because they are
  caller errors.

Each entry carries `schemaVersion` and `savedAt`.
`loadPreference(owner, id, { schemaVersion, migrate })` handles schema changes.
`migrateLegacyKey(owner, id, legacyKey, { accept })` moves a value from an old
bare key once. The caller decides whether the value is still valid, and the old
key is removed after the attempt.

Store UI preferences here. Authentication uses its own store, and `@auth/`
cannot import this module. Browser storage is shared within a browser profile,
so include an account or tenant in the id when preferences must stay separate.

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

`theme`, `resolvedTheme`, and `availableThemes` are signals. The selected name
is saved through the preference service. The resolved name appears as
`data-theme` on `<html>`, and remotes can follow the `themechange` event.
Custom themes override `--ui-` tokens; other tokens come from the linked palette.

The component styles and palette are separate files. `style.css` supplies low
specificity defaults and reads `--ui-color-*` tokens. `theme-default.css`
defines the light and dark token values. Link both when using the default
palette.

```html
<link rel="stylesheet" href="/components/style.css" />
<link rel="stylesheet" href="/components/theme-default.css" />
```

An application can replace the second link with its own palette or register a
theme through the module above. Keep the first link for component defaults.

Rules in `style.css` use Tailwind's `components` layer and `:where()`
selectors. Application classes and utilities can override them without
`!important`. Applications still choose layout, sizing, and spacing.
