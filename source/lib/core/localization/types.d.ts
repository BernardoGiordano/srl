/**
 * One locale's messages, and the negotiation an application configures.
 */

/** Flat, dotted message keys to their translations for one locale. */
export type MessageTable = Record<string, string>;

export interface I18nConfig {
  /** Used when nothing else matches, and merged underneath every other locale. */
  readonly defaultLocale: string;
  /** Offered to the user. Negotiation only ever resolves to one of these. */
  readonly supportedLocales: readonly string[];
  /** URL patterns containing `{locale}`. Merged in order. */
  readonly bundles: readonly string[];
}
