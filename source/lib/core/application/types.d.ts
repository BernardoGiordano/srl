/**
 * The shape an application declares so that `startApplication()` in
 * `@core/application/runtime.js` owns the order of startup and the application
 * owns only the parts that are its own. A hook returning a promise is awaited
 * before the next step begins, which is the entire point of the sequence.
 */

import type { ComponentRef } from '@core/elements/types.js';
import type { AppManifest } from '@core/remotes/types.js';

/**
 * A startup hook. Declared as a property holding a function rather than as a
 * method, because the runtime destructures the spec and a method signature would
 * carry a `this` nobody supplies.
 */
export type StartupHook = (manifest: AppManifest) => void | Promise<unknown>;

/** The element the page already contains, and the module that defines it. */
export interface ApplicationRoot {
  /**
   * Imports the defining module. Dynamic, so it runs after startup, not before.
   * Resolve it to the root class — `.then((m) => m.AppRoot)` — and startup reads
   * the tag from that component's own definition rather than from a second copy
   * of it here.
   */
  readonly load: () => Promise<unknown>;
  /** The root component, for a page whose root module resolves nothing nameable. */
  readonly tag?: ComponentRef;
}

export interface ApplicationSpec {
  /** Defaults to `/app.manifest.json`. Ignored when `manifest` is given. */
  readonly manifestUrl?: string;
  /**
   * An already-validated manifest, for an application that embeds its own or a
   * test that supplies one. Skips the fetch, not the installation.
   */
  readonly manifest?: AppManifest;
  /**
   * Runs first, before the manifest is fetched, so it takes no argument.
   * Typically `configureTheme()`.
   */
  readonly configure?: () => void | Promise<unknown>;
  /** Installs this application's injection providers. */
  readonly providers?: StartupHook;
  /** Settles whatever the first route must not race, e.g. the session restore. */
  readonly ready?: StartupHook;
  /** Defined last, once everything it renders against is in place. */
  readonly root?: ApplicationRoot;
}

/** Startup steps, in the order `startApplication()` runs them. */
export type StartupStep =
  | 'configure'
  | 'manifest'
  | 'templates'
  | 'locale'
  | 'providers'
  | 'ready'
  | 'root';

export interface StartedApplication {
  readonly manifest: AppManifest;
  /**
   * The steps that actually ran, in order. Skipped ones are absent, which is
   * what makes "this application uses no session" an assertion rather than a
   * comment.
   */
  readonly steps: readonly StartupStep[];
}
