/**
 * What an application declares to `startApplication()`. The runtime owns the startup
 * order, and each hook's promise is awaited before the next step.
 */

import type { ComponentRef } from '@core/elements/types.js';
import type { AppManifest } from '@core/remotes/types.js';

/**
 * A startup hook. A function-valued property instead of a method, because the runtime
 * destructures the spec and a method would expect a `this`.
 */
export type StartupHook = (manifest: AppManifest) => void | Promise<unknown>;

/** The element the page already contains, and the module that defines it. */
export interface ApplicationRoot {
  /**
   * Imports the defining module after startup. Resolve it to the root class, as in
   * `.then((m) => m.AppRoot)`, and startup reads the tag from its definition.
   */
  readonly load: () => Promise<unknown>;
  /** The root component, for a page whose root module resolves nothing nameable. */
  readonly tag?: ComponentRef;
}

export interface ApplicationSpec {
  /** Defaults to `/app.manifest.json`. Ignored when `manifest` is given. */
  readonly manifestUrl?: string;
  /**
   * An already admitted manifest, for an application that embeds one or for a test.
   * Skips the fetch, not the installation.
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

/**
 * One step that ran, and its duration. Also emitted as a `srl:startup:<name>` User
 * Timing measure.
 */
export interface StartupStepRun {
  readonly name: StartupStep;
  /** Milliseconds, from the step starting to its hook settling. */
  readonly duration: number;
}

/**
 * What an artifact's `build.json` says it was built from. Commit and date may be null
 * for a build of an uncommitted tree. A document where both are null never becomes this
 * type.
 */
export interface ReleaseIdentity {
  /** The application the origin serves. A different name is a different deployment. */
  readonly app: string;
  readonly commit: string | null;
  readonly sourceDateEpoch: number | null;
}

export interface ReleaseWatchOptions {
  /** Defaults to `/build.json`, where every artifact emits it. */
  readonly url?: string;
  /**
   * The shortest gap between two reads, in milliseconds. Measured on the library clock,
   * so a test drives it without sleeping.
   */
  readonly minIntervalMs?: number;
  /** The fetch used for reads. Tests replace it, and it defaults to the browser's. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface StartedApplication {
  readonly manifest: AppManifest;
  /**
   * The steps that ran, in order. Skipped steps are absent, so a test can assert that an
   * application has no `ready` step.
   */
  readonly steps: readonly StartupStepRun[];
}
