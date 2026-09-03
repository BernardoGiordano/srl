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

/**
 * One step that ran, and what it cost.
 *
 * The duration is here rather than in a second list because the name alone is not
 * enough to act on: a startup total is the sum of seven steps, and a regression
 * inside one of them is invisible in the total. Also emitted as a
 * `srl:startup:<name>` User Timing measure, which is what lets a profiler and a
 * benchmark harness read the same fact without holding the return value.
 */
export interface StartupStepRun {
  readonly name: StartupStep;
  /** Milliseconds, from the step starting to its hook settling. */
  readonly duration: number;
}

/**
 * What one artifact's `build.json` says it was built from, once it has been proved
 * to say anything. Both halves of the identity are nullable because the build emits
 * them that way: an artifact of an uncommitted tree is legitimate, and it is the
 * release that refuses to ship one rather than the build that refuses to make it.
 * A document where both are null carries no identity and never reaches this type.
 */
export interface ReleaseIdentity {
  /** The application the origin is serving. A different name is a different deployment, not a new release of this one. */
  readonly app: string;
  readonly commit: string | null;
  readonly sourceDateEpoch: number | null;
}

export interface ReleaseWatchOptions {
  /** Defaults to `/build.json`, which is where every artifact this toolchain builds emits it. */
  readonly url?: string;
  /**
   * The shortest gap between two reads, in milliseconds. Commit boundaries are as
   * frequent as the user's clicks; this is what keeps a busy minute to one request.
   * Measured on the library's clock, so a suite drives it rather than sleeping.
   */
  readonly minIntervalMs?: number;
  /** The fetch a read goes out on. The seam a suite replaces; defaults to the browser's. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface StartedApplication {
  readonly manifest: AppManifest;
  /**
   * The steps that actually ran, in order. Skipped ones are absent, which is
   * what makes "this application uses no session" an assertion rather than a
   * comment.
   */
  readonly steps: readonly StartupStepRun[];
}
