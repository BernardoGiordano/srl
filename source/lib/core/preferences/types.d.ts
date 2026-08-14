/**
 * The storage adapter an application may supply, and what one preference read
 * is allowed to say about the value it finds. ADR-0015.
 */

/** Synchronous subset shared by localStorage, sessionStorage, and memory adapters. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PreferencesConfig {
  /** Defaults to browser localStorage. */
  readonly storage?: KeyValueStorage;
  /** Key namespace. Defaults to `ui.component-state`. */
  readonly prefix?: string;
}

export interface PreferenceLoadOptions<T> {
  /** Component-owned schema version. Defaults to 1. */
  readonly schemaVersion?: number;
  /** Optional migration from stored schema into current state. */
  readonly migrate?: (state: unknown, storedVersion: number) => T | undefined;
}

/** How `migrateLegacyKey` adopts a raw value written before this module owned it. */
export interface LegacyKeyOptions<T> {
  /**
   * Turn the raw stored string into state worth keeping, or return undefined to
   * discard it. Called at most once per key, because the key is then removed.
   */
  readonly accept: (raw: string) => T | undefined;
  /** Schema version to store the adopted value under. Defaults to 1. */
  readonly schemaVersion?: number;
}
