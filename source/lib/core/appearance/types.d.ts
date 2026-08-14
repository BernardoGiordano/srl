/**
 * A theme, as an application declares it and as `@core/appearance/theme.js`
 * persists the choice between them.
 */

/** `system` follows the OS; every other value names a concrete theme. */
export type ThemePreference = 'system' | 'light' | 'dark' | (string & {});

export interface ThemeDefinition {
  /** Controls native form controls, scrollbars, and the CSS `color-scheme`. */
  readonly colorScheme: 'light' | 'dark';
  /** Semantic library tokens. Custom themes may only set names beginning `--ui-`. */
  readonly tokens?: Readonly<Record<`--ui-${string}`, string>>;
}

export interface ThemeConfig {
  /** Used when there is no valid persisted preference. Defaults to `system`. */
  readonly defaultTheme?: ThemePreference;
  /** Application-defined themes added after `system`, `light`, and `dark`. */
  readonly themes?: Readonly<Record<string, ThemeDefinition>>;
  /** Persistence key. Defaults to `ui.theme`. */
  readonly storageKey?: string;
  /** Element receiving data attributes and token overrides. Defaults to `<html>`. */
  readonly target?: HTMLElement;
}
