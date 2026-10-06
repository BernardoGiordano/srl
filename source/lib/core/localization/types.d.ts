/**
 * A locale's messages and the i18n configuration.
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
  /**
   * The hash-named file each resolved bundle URL is served from. Keys are the URLs the
   * patterns resolve to. Absent in development, where the declared URL is the file.
   */
  readonly bundleFiles?: Readonly<Record<string, string>>;
}

/** How a registered bundle loads. A remote's bundle sets both. ADR-0129. */
export interface BundleRules {
  /** Keep only keys under this dotted prefix, such as `billing` for `billing.title`. */
  readonly namespace?: string;
  /** Load a locale only when the page pins its file. An unpinned one reads as empty. */
  readonly pinned?: boolean;
}
