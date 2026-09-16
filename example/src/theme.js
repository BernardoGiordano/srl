/**
 * Register this application's ocean theme before the first render. Unlisted tokens
 * inherit the light palette. `registerTheme` accepts only `--ui-` tokens.
 *
 * @type {Record<string, import('@core/appearance/types.js').ThemeDefinition>}
 */
export const THEMES = {
  ocean: {
    colorScheme: 'dark',
    tokens: {
      '--ui-color-canvas': '#04212b',
      '--ui-color-surface': '#07303d',
      '--ui-color-surface-raised': '#0b3d4d',
      '--ui-color-hover': '#0f4b5e',
      '--ui-color-text': '#e6fbff',
      '--ui-color-text-muted': '#8fb9c4',
      '--ui-color-border': '#125365',
      '--ui-color-primary': '#67e8f9',
      '--ui-color-primary-hover': '#a5f3fc',
      '--ui-color-primary-contrast': '#04212b',
      '--ui-color-accent': '#fbbf24',
      '--ui-color-accent-strong': '#fcd34d',
      '--ui-color-sidebar': '#032128',
      '--ui-color-sidebar-hover': 'rgb(103 232 249 / 12%)',
      '--ui-color-sidebar-active': 'rgb(103 232 249 / 22%)',
      '--ui-color-sidebar-text': '#ecfeff',
      '--ui-color-sidebar-muted': '#9ccdd8',
      '--ui-color-overlay': 'rgb(1 12 16 / 72%)',
      '--ui-color-focus-ring': '#fbbf24',
      '--ui-color-shadow': 'rgb(0 0 0 / 45%)',
    },
  },
};
