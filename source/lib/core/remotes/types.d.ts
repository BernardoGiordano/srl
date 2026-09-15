/**
 * An application's admitted manifest, the remotes it declares, and the contract
 * between a shell and a remote it mounts.
 */

import type { I18nConfig } from '@core/localization/types.js';
import type { RouteGuard } from '@core/navigation/types.js';

export interface RemoteDescriptor {
  /** Stable identifier, used in logs and as the import cache key. Unique per manifest. */
  readonly name: string;
  /** Same-origin root-relative URL of the remote's ESM entry point, normalized. */
  readonly url: string;
  /** SRI digest also pinned in the page's static import map. */
  readonly integrity: string;
  /** Every independently published module, stylesheet, and template bundle. */
  readonly assets: readonly RemoteAsset[];
  /** Exact bare specifiers supplied by the shell instead of bundled by this remote. */
  readonly shared: readonly string[];
  /** Remote-owned locale URL patterns, registered before its module evaluates. */
  readonly locales: readonly string[];
  /** Optional content-hashed template bundle seeded before its module evaluates. */
  readonly templates?: string;
  /**
   * The URLs of this remote's templates, started beside its entry module. Empty under
   * bundle delivery, where `templates` carries the markup. ADR-0081.
   */
  readonly templateFiles: readonly string[];
  /**
   * Path prefix the remote owns, such as `/billing`. It has no trailing slash, and no
   * two remotes may claim one subtree.
   */
  readonly mount: string;
  /** Checked before the remote's code is fetched. */
  readonly requires: RemoteRequirements;
  /** The ceiling on what the remote's host context can do. */
  readonly grants: RemoteGrants;
}

export interface RemoteAsset {
  readonly type: 'module' | 'style' | 'template';
  /** Same-origin root-relative publication URL. */
  readonly url: string;
  /** SHA-384 digest enforced by import-map, link, or fetch integrity. */
  readonly integrity: string;
}

/**
 * Access rules on the mount path, enforced by the shell's guard, so an unauthorized
 * user never downloads the remote's code.
 */
export interface RemoteRequirements {
  /** Redirect to /login without a session. */
  readonly session: boolean;
  /** Redirect to /forbidden unless the session holds all of these. */
  readonly permissions: readonly string[];
}

/**
 * Least privilege for one remote, declared in the manifest. The host context can never
 * exceed it.
 */
export interface RemoteGrants {
  /**
   * Same-origin path prefixes the remote may call through `host.auth.fetch`.
   * Anything else throws before a request is made.
   */
  readonly api: readonly string[];
  /**
   * Permissions the remote may ask about. `host.auth.permissions()` intersects this
   * list with the session's scopes, so the remote learns nothing else.
   */
  readonly permissions: readonly string[];
}

/**
 * The contract every remote entry module satisfies. `assertRemoteModule` checks it at
 * runtime, because an `import()` of a variable URL is `any` to the type checker.
 */
export interface RemoteModule {
  /** Tag of the remote's root element. Defined by importing the module or during `mount`. */
  readonly rootTag: string;
  /**
   * The host contract version the remote targets. Required whenever `mount` is
   * exported, so a changed contract fails at load.
   */
  readonly contract?: number;
  /** Create one root instance with one fresh capability context. */
  readonly mount: (host: HostContext) => HTMLElement | Promise<HTMLElement>;
  /** Optional remote-owned cleanup. Host capabilities are revoked before this runs. */
  readonly unmount?: (root: HTMLElement) => void | Promise<void>;
}

/* ── The host contract ────────────────────────────────────────────────────
 *
 * What a remote is handed, as opposed to what it may import. Capabilities arrive as
 * one revocable object passed to `mount`. Nothing is global, and no method returns a
 * credential.
 *
 * The contract uses callbacks instead of signals, so a remote doesn't have to import
 * the shell's reactive library or match its version.
 */

export type Unsubscribe = () => void;

/** Who the user is, without anything that could authenticate as them. */
export interface HostIdentity {
  readonly subject: string;
  readonly name: string;
}

export interface HostAuth {
  /** Null when signed out. */
  user(): HostIdentity | null;
  /** Granted permissions the session actually holds. */
  permissions(): readonly string[];
  can(permission: string): boolean;
  /** Fires on sign-in, sign-out and any change of scopes. */
  onChange(listener: () => void): Unsubscribe;
  /**
   * An authorized request through the shell's outbound path, with credentials, refresh
   * on 401 and retry. The remote never sees a token, so this works under any token
   * strategy.
   *
   * Rejects if `path` falls outside `grants.api`.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Like `fetch`, but parsed, and throwing on a non-2xx. Returns `unknown`, so the remote validates it. */
  json(path: string, init?: RequestInit): Promise<unknown>;
}

export interface HostRouter {
  /** The shell's current pathname. A remote routes its own subtree off this. */
  path(): string;
  navigate(to: string): void;
  onChange(listener: () => void): Unsubscribe;
}

export interface HostI18n {
  locale(): string;
  direction(): 'ltr' | 'rtl';
  t(key: string, params?: Readonly<Record<string, unknown>>): string;
  /** Merge the remote's own bundle, a URL pattern containing `{locale}`. */
  register(pattern: string): Promise<void>;
  /** Fires on a locale change and when any bundle is merged. */
  onChange(listener: () => void): Unsubscribe;
}

export interface HostContext {
  /** Matches `HOST_CONTRACT` in @core/remotes/mfe.js. */
  readonly contract: number;
  readonly name: string;
  /** The path prefix the shell has given this remote. */
  readonly mount: string;
  readonly auth: HostAuth;
  readonly router: HostRouter;
  readonly i18n: HostI18n;
}

/** A context plus the shell's handle for taking it away again. */
export interface RemoteHost {
  readonly context: HostContext;
  /**
   * Drop every subscription and make each method throw. Called when the remote's mount
   * is torn down or fails.
   */
  revoke(): void;
}

/**
 * What `@core/remotes/mfe.js` injects to get a remote's guard and host context. The
 * indirection keeps `source/lib/core/` free of imports from `source/lib/auth/`. See
 * `source/lib/host/remote-host.js`.
 */
export interface RemoteHostProvider {
  /** Undefined when the remote declares no requirements. */
  guard(remote: RemoteDescriptor): RouteGuard | undefined;
  connect(remote: RemoteDescriptor): RemoteHost;
}

/**
 * An application's runtime configuration, as `@core/remotes/manifest-policy.js`
 * admitted it. URLs are normalized same-origin paths, collisions are already refused
 * and the object is frozen.
 */
export interface AppManifest {
  readonly remotes: readonly RemoteDescriptor[];
  /**
   * Where the application's API lives. Authentication strategy and endpoint names are
   * application configuration and don't belong in the manifest.
   */
  readonly auth: {
    /** Root-relative. Requests carry the session's authorization material. */
    readonly apiBaseUrl: string;
  };
  readonly i18n: I18nConfig;
  /**
   * Optional `{ url: source }` map of every template, fetched once at startup. Emitted
   * only under `--templates bundle`.
   */
  readonly templateBundle?: string;
  /**
   * Templates grouped by the chunk whose modules name them. `entry` holds the closure
   * the document preloads, and `chunk:<emitted path>` holds each other chunk. Startup
   * starts the entry group, and the rest follow their code. ADR-0081.
   *
   * Emitted only under `--templates split`, and an empty record otherwise.
   */
  readonly templateGroups: Readonly<Record<string, readonly string[]>>;
  /**
   * Every template URL, entry group first. Derived from `templateGroups` when present,
   * read from the document under source delivery, and empty under bundle delivery.
   */
  readonly templateFiles: readonly string[];
}

/**
 * Where a manifest came from and what the page pins. The browser reads both from
 * `document`, and `tools/checks/verify-deps.mjs` reads them from `index.html`.
 */
export interface ManifestSource {
  /** The manifest's own location, used in every message. */
  readonly url: string;
  /** Absolute URL the page's pins resolve against, e.g. `document.baseURI`. */
  readonly base: string;
  /**
   * The static import map's `integrity` block. A function, because a manifest without
   * remotes needs no import map.
   */
  readonly pins: () => Readonly<Record<string, unknown>>;
}
