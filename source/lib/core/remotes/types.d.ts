/**
 * One application's admitted manifest, the remotes it declares, and the contract
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
   * Every template this remote published, as the URLs its own components will ask
   * for, put in flight alongside its entry module rather than discovered one at a
   * time once that module arrives. Empty under bundle delivery, where `templates`
   * already carries the markup itself. ADR-0081.
   */
  readonly templateFiles: readonly string[];
  /**
   * Path prefix the remote owns, e.g. `/billing`. Normalized without a trailing
   * slash, and admitted so that no two remotes claim one subtree.
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
 * Access control on the mount path, enforced by the shell's own guard so an
 * unauthorized user never downloads the remote's code in the first place.
 */
export interface RemoteRequirements {
  /** Redirect to /login without a session. */
  readonly session: boolean;
  /** Redirect to /forbidden unless the session holds all of these. */
  readonly permissions: readonly string[];
}

/**
 * Least privilege for one remote, declared in the manifest rather than in code.
 * Everything the host context will do is bounded by this, and nothing widens it
 * at runtime.
 */
export interface RemoteGrants {
  /**
   * Same-origin path prefixes the remote may call through `host.auth.fetch`.
   * Anything else throws before a request is made.
   */
  readonly api: readonly string[];
  /**
   * Permissions the remote may ask about. `host.auth.permissions()` is this list
   * intersected with the session's scopes, so a remote learns nothing about the
   * user's other entitlements.
   */
  readonly permissions: readonly string[];
}

/**
 * The contract every remote entry module must satisfy. Enforced at runtime by
 * `assertRemoteModule`, because a dynamic `import()` of a URL held in a variable
 * is `any` as far as the type checker is concerned. This is the seam where types
 * stop and validation has to start.
 */
export interface RemoteModule {
  /** Tag of the remote's root element. Defined by importing the module or during `mount`. */
  readonly rootTag: string;
  /**
   * Version of the host contract the remote was written against. Required
   * whenever `mount` is exported, so a shell upgrade that changes the
   * context fails loudly at load rather than at the first call into a method
   * that moved.
   */
  readonly contract?: number;
  /** Create one root instance with one fresh capability context. */
  readonly mount: (host: HostContext) => HTMLElement | Promise<HTMLElement>;
  /** Optional remote-owned cleanup. Host capabilities are revoked before this runs. */
  readonly unmount?: (root: HTMLElement) => void | Promise<void>;
}

/* ── The host contract ────────────────────────────────────────────────────
 *
 * What a remote is given, as opposed to what it may import. Capabilities are
 * handed to `mount` as one object and are revocable; nothing here is
 * reachable from a global, and no method returns a credential.
 *
 * Callbacks rather than signals, on purpose. Exposing a `Signal` would oblige
 * every remote to import the shell's reactive library and to agree on its
 * version, which is the coupling the contract exists to remove. `onChange`
 * costs the shell one adapter and costs a foreign remote nothing.
 */

export type Unsubscribe = () => void;

/** Who the user is, minus anything that could authenticate as them. */
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
   * An authorized request, through the shell's single outbound HTTP path:
   * credential attachment, refresh-on-401 and retry included. The remote never
   * sees a token, so this keeps working unchanged when the shell switches to a
   * strategy where JavaScript genuinely cannot read one.
   *
   * Rejects if `path` falls outside `grants.api`.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** As `fetch`, parsed, and throwing on a non-2xx. `unknown` because the remote must validate. */
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
   * Drop every subscription and make each method throw. Called whenever the
   * matching remote mount is torn down or fails to complete.
   */
  revoke(): void;
}

/**
 * What @core/remotes/mfe.js injects to obtain the two things it cannot know itself: the
 * guard for a remote's mount path, and the capabilities to hand its mount.
 *
 * This indirection is what keeps `source/lib/core/` free of any import from
 * `source/lib/auth/`. The core owns the remote contract; the application decides
 * what a capability is. See `source/lib/host/remote-host.js`.
 */
export interface RemoteHostProvider {
  /** Undefined when the remote declares no requirements. */
  guard(remote: RemoteDescriptor): RouteGuard | undefined;
  connect(remote: RemoteDescriptor): RemoteHost;
}

/**
 * One application's runtime configuration, as `@core/remotes/manifest-policy.js`
 * admitted it: every URL is a normalized same-origin path, every cross-field
 * collision has already been refused, and the object graph is frozen. A consumer
 * reads these values instead of re-reading the fetched document, because the
 * document alone cannot say whether the set of them is coherent.
 */
export interface AppManifest {
  readonly remotes: readonly RemoteDescriptor[];
  /**
   * Where this application's API lives. Nothing about *authentication* is here:
   * which strategy an application uses, and what its authorization server calls
   * its endpoints and fields, is the application's own configuration, and a
   * manifest key for it would be the library dictating a backend contract.
   */
  readonly auth: {
    /** Root-relative. Requests carry the session's authorization material. */
    readonly apiBaseUrl: string;
  };
  readonly i18n: I18nConfig;
  /**
   * Optional pre-bundled `{ url: source }` map of every template, fetched once at
   * startup so no component costs a request of its own. Emitted only under
   * `--templates bundle`; absent in development, where templates are fetched
   * individually and reloaded on change.
   */
  readonly templateBundle?: string;
  /**
   * The templates this artifact emitted, grouped by the chunk whose modules name
   * them: `entry` for the closure the document already preloads, and
   * `chunk:<emitted path>` for every other chunk.
   *
   * The group is what makes the list actionable. A flat list can only be started at
   * once, before a route is known; grouped, startup starts the entry group and the
   * rest follow the code that needs them
   * ([ADR-0086](../../../../docs/adr/0086-the-manifest-groups-templates-by-chunk.md)).
   * Emitted only under `--templates split`; an empty record everywhere else.
   */
  readonly templateGroups: Readonly<Record<string, readonly string[]>>;
  /**
   * Every template this artifact emitted, as the URLs its components will ask for.
   *
   * Not a bundle and not a substitute for one: the files stay separate and
   * immutable, and this is only the discovery a component cannot do for itself, so
   * a caller can put them in flight instead of paying one round trip per component
   * once its chunk arrives ([ADR-0081](../../../../docs/adr/0081-the-manifest-names-every-template.md)).
   *
   * Derived from `templateGroups` when the document carries one, entry group first,
   * so "everything this artifact holds" stays one property rather than a partition
   * the caller has to know about. Read from the document under source delivery,
   * which has no chunks to group by. Empty under bundle delivery.
   */
  readonly templateFiles: readonly string[];
}

/**
 * Where a manifest document came from, and what the page pins. The two halves an
 * admission adapter supplies: the browser reads them from `document`, and
 * tools/checks/verify-deps.mjs from the application's `index.html`, so both admit
 * a manifest under the same rules.
 */
export interface ManifestSource {
  /** The manifest's own location, used in every message. */
  readonly url: string;
  /** Absolute URL the page's pins resolve against, e.g. `document.baseURI`. */
  readonly base: string;
  /**
   * The static import map's `integrity` block. A function because a manifest with
   * no remotes needs no import map, and calling it is what decides whether a
   * missing one is an error.
   */
  readonly pins: () => Readonly<Record<string, unknown>>;
}
