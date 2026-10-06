/**
 * Manifest admission, where runtime configuration becomes policy. ADR-0010.
 *
 * `app.manifest.json` decides where code is imported from, where credentials go,
 * which path each remote owns and which files seed the locale and template caches.
 * This module checks the whole document at once, before anything downstream is
 * built. Everything after it reads the admitted value, which is normalized, checked
 * for collisions and frozen.
 *
 * The module imports nothing, so `tools/checks/verify-deps.mjs` can load it in Node
 * and admit every checked-in manifest under the browser's rules. The page's import
 * map pins arrive as an argument, because the two callers read them from different
 * places. Fetching the document belongs to `remotes/mfe.js`.
 *
 * Every URL in the manifest must be a same-origin, root-relative path. Admission
 * rejects anything else and never repairs it.
 *
 * The manifest names bytes and the page pins them. Every asset a remote publishes,
 * every template file it announces, the template bundle and every hash-named locale
 * file must carry the page's pin, so a changed manifest can point only at bytes the
 * document already vouches for. ADR-0129.
 *
 * A section may be absent. An absent `remotes` means none, an absent `auth` means no
 * API location, and an absent `i18n` means one locale with no bundles. A present value
 * is still checked in full, and a key admission does not know is refused, so a
 * misspelled section fails instead of reading as absent. ADR-0123.
 */

/** @import { I18nConfig } from '@core/localization/types.js' */
/** @import { AppManifest, ManifestSource, RemoteDescriptor, RemoteGrants, RemoteRequirements } from '@core/remotes/types.js' */

/**
 * The only digest form the manifest and the import map may use. One algorithm keeps
 * the comparison simple.
 */
const SHA384 = /^sha384-[A-Za-z0-9+/]{64}$/u;

/**
 * A locale tag limited to characters that are safe inside a URL pattern. A tag with
 * `/`, `..` or a percent escape could point a bundle pattern outside its directory.
 */
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** The placeholder every bundle pattern must contain. */
const LOCALE_PLACEHOLDER = '{locale}';

/** A relative path, a root path or a URL, none of which is a bare specifier. */
const NOT_BARE = /^(?:\.|\/|(?:https?:)?\/\/)/u;

/**
 * The locale a manifest without `i18n.defaultLocale` or `i18n.supportedLocales` gets.
 *
 * @internal
 */
export const DEFAULT_LOCALE = 'en';

/**
 * The keys each object in the document may hold. Admission refuses any other key
 * except one starting with `$`, which annotates the document, as `$schema` and
 * `$comment` do. The published JSON Schema lists the same keys.
 *
 * @internal
 */
export const MANIFEST_KEYS = Object.freeze({
  manifest: Object.freeze(['remotes', 'auth', 'i18n', 'templateBundle', 'templateGroups', 'templateFiles']),
  auth: Object.freeze(['apiBaseUrl']),
  i18n: Object.freeze(['defaultLocale', 'supportedLocales', 'bundles', 'bundleFiles']),
  remote: Object.freeze([
    'name',
    'url',
    'integrity',
    'assets',
    'shared',
    'locales',
    'templates',
    'templateFiles',
    'mount',
    'requires',
    'grants',
  ]),
  asset: Object.freeze(['type', 'url', 'integrity']),
  requires: Object.freeze(['session', 'permissions']),
  grants: Object.freeze(['api', 'permissions']),
});

/**
 * The patterns admission applies to a string, for the JSON Schema to repeat.
 *
 * @internal
 */
export const MANIFEST_PATTERNS = Object.freeze({
  integrity: SHA384.source,
  locale: LOCALE.source,
  localePlaceholder: LOCALE_PLACEHOLDER,
  notBare: NOT_BARE.source,
});

/**
 * The asset types a remote may publish.
 *
 * @internal
 */
export const ASSET_TYPES = Object.freeze(['module', 'style', 'template', 'locale']);

/**
 * Admission state for one document: its URL, the base its paths resolve against, and
 * the page's integrity pins, read lazily and only when a remote needs them.
 *
 * @typedef {{
 *   url: string,
 *   origin: string,
 *   base: string,
 *   pins: () => Map<string, string>,
 * }} Policy
 */

/**
 * Validate, normalize and freeze one manifest, or throw naming the file and field.
 *
 * Every value is rebuilt instead of cast, so a typo in a deploy pipeline fails with
 * one message at startup.
 *
 * @param {unknown} value the parsed document
 * @param {ManifestSource} source where it came from and what the page pins
 * @returns {AppManifest}
 */
export function admitManifest(value, source) {
  const url = source.url;
  const root = asRecord(value, url, MANIFEST_KEYS.manifest);

  /** @type {Policy} */
  const policy = {
    url,
    origin: new URL(source.base).origin,
    base: source.base,
    pins: pinIndex(source),
  };

  const i18n = admitI18n(root.i18n, policy);
  const remotes = root.remotes ?? [];
  if (!Array.isArray(remotes)) {
    throw new Error(`${url}: remotes must be an array.`);
  }

  const admitted = /** @type {unknown[]} */ (remotes).map((entry, index) =>
    admitRemote(entry, index, policy, i18n.supportedLocales),
  );
  assertDistinct(admitted, policy);

  const templateBundle = root.templateBundle;
  const templateGroups = admitTemplateGroups(root.templateGroups, `${url}: templateGroups`, policy);
  const grouped = Object.values(templateGroups).flat();
  const listed = admitTemplateFiles(root.templateFiles, `${url}: templateFiles`, policy);
  if (grouped.length > 0 && listed.length > 0) {
    throw new Error(
      `${url} names its templates twice, as \`templateGroups\` and as \`templateFiles\`. One ` +
        `document cannot say both which chunk needs what and that everything is needed at once.`,
    );
  }

  return Object.freeze({
    remotes: Object.freeze(admitted),
    auth: admitAuth(root.auth, policy),
    i18n,
    templateBundle:
      templateBundle === undefined
        ? undefined
        : requirePin(
            admitPath(templateBundle, `${url}: templateBundle`, policy),
            `${url}: templateBundle`,
            policy,
          ),
    templateGroups,
    // The flat list stays derived, so a caller that wants every template doesn't need
    // to know how the document was grouped.
    templateFiles: grouped.length > 0 ? Object.freeze(grouped) : listed,
  });
}

/**
 * Admit the chunk-to-template groups. ADR-0081.
 *
 * Keys such as `entry` and `chunk:<path>` are the build's own names and aren't
 * checked. Every value becomes a `fetch`, so each one goes through the same-origin
 * rule. A URL may appear in only one group, since a template belongs to one chunk. An
 * absent key yields a frozen empty record.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {Policy} policy
 * @returns {Readonly<Record<string, readonly string[]>>}
 */
function admitTemplateGroups(value, where, policy) {
  // No prototype, because the keys come from the document. `JSON.parse` makes
  // `__proto__` an own key, and writing it to a plain object would replace the
  // prototype.
  /** @type {unknown} */
  const empty = Object.create(null);
  const groups = /** @type {Record<string, readonly string[]>} */ (empty);
  if (value === undefined) return Object.freeze(groups);
  const record = asRecord(value, where, undefined);
  const seen = new Set();

  for (const [name, entries] of Object.entries(record)) {
    if (!Array.isArray(entries)) throw new Error(`${where}.${name} must be an array.`);
    groups[name] = Object.freeze(
      /** @type {unknown[]} */ (entries).map((entry, index) => {
        const file = admitPath(entry, `${where}.${name}[${String(index)}]`, policy);
        if (seen.has(file)) throw new Error(`${where} names ${file} more than once.`);
        seen.add(file);
        return file;
      }),
    );
  }
  return Object.freeze(groups);
}

/**
 * Admit a flat list of template URLs.
 *
 * An absent key yields a frozen empty array, so the consumer iterates without a
 * guard. Entries must be same-origin, because a cross-origin fetch would fail under
 * `connect-src 'self'`. Duplicates are refused as a generator bug.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {Policy} policy
 * @returns {readonly string[]}
 */
function admitTemplateFiles(value, where, policy) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${where} must be an array.`);
  const seen = new Set();
  const files = /** @type {unknown[]} */ (value).map((entry, index) => {
    const file = admitPath(entry, `${where}[${String(index)}]`, policy);
    if (seen.has(file)) throw new Error(`${where} names ${file} more than once.`);
    seen.add(file);
    return file;
  });
  return Object.freeze(files);
}

/**
 * Apply the trust rule to one URL field and return its normalized path.
 *
 * Normalizing matters, because `/api/../auth` and `/auth` are the same destination. A
 * backslash is refused before parsing, because the URL parser treats it as a
 * separator and `/\evil.example/x` would become another origin.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {Policy} policy
 * @returns {string}
 */
function admitPath(value, where, policy) {
  const raw = requireString(value, where);

  if (raw.includes('\\')) {
    throw new Error(
      `${where} must not contain a backslash, got ${JSON.stringify(raw)}. The URL parser reads ` +
        `it as a path separator, so "/\\host/x" is another origin wearing the shape of a path.`,
    );
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    throw new Error(
      `${where} must be same-origin: a root-relative path beginning with "/", got ` +
        `${JSON.stringify(raw)}. The shell executes remote code, sends credentials and applies ` +
        `\`connect-src 'self'\`, so another origin is not something this file may introduce.`,
    );
  }
  if (raw.includes('#')) {
    throw new Error(
      `${where} must not contain a fragment, got ${JSON.stringify(raw)}. Nothing here is fetched ` +
        `with one, so it is either a typo or an attempt to hide the rest of the value.`,
    );
  }

  const target = new URL(raw, policy.origin);
  if (target.origin !== policy.origin) {
    throw new Error(`${where} must be same-origin, got ${JSON.stringify(raw)}.`);
  }
  return target.pathname + target.search;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {Policy} policy
 * @param {readonly string[]} supportedLocales
 * @returns {RemoteDescriptor}
 */
function admitRemote(value, index, policy, supportedLocales) {
  const entry = asRecord(value, `${policy.url} remotes[${String(index)}]`, MANIFEST_KEYS.remote);
  const name = requireString(entry.name, `${policy.url}: remotes[${String(index)}].name`);
  const where = `${policy.url}: remote "${name}"`;

  const url = admitPath(entry.url, `${where} url`, policy);
  const integrity = requireString(entry.integrity, `${where} integrity`);
  assertPinned(url, integrity, where, policy);
  const assets = admitRemoteAssets(entry.assets, where, policy);
  const templates =
    entry.templates === undefined
      ? undefined
      : admitPath(entry.templates, `${where} templates`, policy);
  const templateFiles = admitTemplateFiles(entry.templateFiles, `${where} templateFiles`, policy);
  for (const [index, file] of templateFiles.entries()) {
    requirePin(file, `${where} templateFiles[${String(index)}]`, policy);
  }
  const locales = admitBundlePatterns(entry.locales, `${where} locales`, supportedLocales, policy);
  if (
    assets.length > 0 &&
    !assets.some((asset) => asset.type === 'module' && asset.url === url && asset.integrity === integrity)
  ) {
    throw new Error(`${where} assets must include its entry module with the same URL and integrity.`);
  }
  assertTemplateAssets(assets, templates, templateFiles, where);
  assertLocaleAssets(assets, locales, supportedLocales, where);

  return Object.freeze({
    name,
    url,
    integrity,
    assets,
    shared: admitShared(entry.shared, where),
    locales,
    templates,
    templateFiles,
    mount: admitMount(entry.mount, where, policy),
    requires: admitRequirements(entry.requires, where),
    grants: admitGrants(entry.grants, where),
  });
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {Policy} policy
 * @returns {ReadonlyArray<import('@core/remotes/types.js').RemoteAsset>}
 */
function admitRemoteAssets(value, where, policy) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${where} assets must be an array.`);
  const seen = new Set();
  const assets = /** @type {unknown[]} */ (value).map((candidate, index) => {
    const assetWhere = `${where} assets[${String(index)}]`;
    const asset = asRecord(candidate, assetWhere, MANIFEST_KEYS.asset);
    const type = /** @type {import('@core/remotes/types.js').RemoteAsset['type']} */ (
      requireString(asset.type, `${assetWhere}.type`)
    );
    if (!ASSET_TYPES.includes(type)) {
      throw new Error(`${assetWhere}.type must be one of ${ASSET_TYPES.join(', ')}.`);
    }
    const url = admitPath(asset.url, `${assetWhere}.url`, policy);
    if (seen.has(url)) throw new Error(`${where} assets names ${url} more than once.`);
    seen.add(url);
    const integrity = requireString(asset.integrity, `${assetWhere}.integrity`);
    if (!SHA384.test(integrity)) {
      throw new Error(`${assetWhere}.integrity must be one sha384 SRI digest.`);
    }
    assertPinned(url, integrity, assetWhere, policy);
    return Object.freeze({ type, url, integrity });
  });
  return Object.freeze(assets);
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function admitShared(value, where) {
  const shared = requireStringArray(value, `${where} shared`);
  const seen = new Set();
  for (const specifier of shared) {
    if (NOT_BARE.test(specifier)) {
      throw new Error(`${where} shared entry ${JSON.stringify(specifier)} must be a bare specifier.`);
    }
    if (seen.has(specifier)) throw new Error(`${where} shared names ${specifier} more than once.`);
    seen.add(specifier);
  }
  return Object.freeze(shared);
}

/**
 * Require the manifest's digest to match the page's static import map pin. The
 * browser enforces that pin on dynamic imports, and every other loader passes it to
 * `fetch`, so a mutable manifest can't choose new bytes at runtime.
 *
 * @param {string} url
 * @param {string} integrity
 * @param {string} where
 * @param {Policy} policy
 */
function assertPinned(url, integrity, where, policy) {
  if (!SHA384.test(integrity)) {
    throw new Error(`${where} integrity must be one sha384 SRI digest.`);
  }
  if (policy.pins().get(url) !== integrity) {
    throw new Error(
      `${where} integrity does not match the page's static import-map pin for ${url}.`,
    );
  }
}

/**
 * Require the page to pin a URL the manifest names without a digest of its own, and
 * return the URL. The loader fetches it under that pin.
 *
 * @param {string} url
 * @param {string} where
 * @param {Policy} policy
 * @returns {string}
 */
function requirePin(url, where, policy) {
  const pin = policy.pins().get(url);
  if (pin === undefined || !SHA384.test(pin)) {
    throw new Error(
      `${where} names ${url}, which the page's import map doesn't pin. The manifest may only ` +
        `point at bytes the document vouches for.`,
    );
  }
  return url;
}

/**
 * A remote's template assets are its bundle, or its split files. Under a bundle there
 * is exactly one. Without one, every announced file needs a record, so composition can
 * carry its digest into the shell's import map.
 *
 * @param {ReadonlyArray<import('@core/remotes/types.js').RemoteAsset>} assets
 * @param {string | undefined} templates
 * @param {readonly string[]} templateFiles
 * @param {string} where
 */
function assertTemplateAssets(assets, templates, templateFiles, where) {
  const templateAssets = assets.filter((asset) => asset.type === 'template');
  if (templates !== undefined) {
    if (templateAssets.length !== 1 || templateAssets[0]?.url !== templates) {
      throw new Error(`${where} templates must name its single template asset.`);
    }
    return;
  }
  if (assets.length === 0) return;
  const recorded = new Set(templateAssets.map((asset) => asset.url));
  const missing = templateFiles.filter((file) => !recorded.has(file));
  if (missing.length > 0) {
    throw new Error(`${where} announces templates with no asset record: ${missing.join(', ')}.`);
  }
}

/**
 * A locale asset must be a file one of the remote's patterns resolves to for a
 * supported locale. Any other is a file the runtime never fetches.
 *
 * @param {ReadonlyArray<import('@core/remotes/types.js').RemoteAsset>} assets
 * @param {readonly string[]} patterns
 * @param {readonly string[]} supportedLocales
 * @param {string} where
 */
function assertLocaleAssets(assets, patterns, supportedLocales, where) {
  const resolvable = new Set(
    patterns.flatMap((pattern) =>
      supportedLocales.map((locale) => pattern.split(LOCALE_PLACEHOLDER).join(locale)),
    ),
  );
  for (const asset of assets) {
    if (asset.type === 'locale' && !resolvable.has(asset.url)) {
      throw new Error(
        `${where} has a locale asset ${asset.url} that no locale pattern resolves to for a ` +
          'supported locale.',
      );
    }
  }
}

/**
 * Admit the path prefix a remote owns, which becomes a `${mount}/*` route.
 *
 * `*`, `:` and `?` are refused, because they would change what the route matches. A
 * trailing slash is removed, so `/billing` and `/billing/` can't be declared as two
 * remotes.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {Policy} policy
 * @returns {string}
 */
function admitMount(value, where, policy) {
  const raw = requireString(value, `${where} mount`);

  for (const character of ['*', ':', '?']) {
    if (raw.includes(character)) {
      throw new Error(
        `${where} mount must be a plain path prefix, got ${JSON.stringify(raw)}. The router ` +
          `appends "/*" to it, so "${character}" here changes what the route matches rather ` +
          `than what the remote owns.`,
      );
    }
  }

  const path = admitPath(raw, `${where} mount`, policy);
  const mount = path.endsWith('/') ? path.slice(0, -1) : path;
  if (mount === '') {
    throw new Error(
      `${where} mount must not be "/". A remote mounted at the root owns every path in the ` +
        `application, including the shell's own routes.`,
    );
  }
  return mount;
}

/**
 * Check the invariants no single entry can see.
 *
 * A duplicate name makes one remote unreachable, because the name is the import cache
 * key and the nav label. Overlapping mounts are worse. Routes match in declaration
 * order, so the file's order would decide which guard runs and which grants apply.
 *
 * @param {readonly RemoteDescriptor[]} remotes
 * @param {Policy} policy
 */
function assertDistinct(remotes, policy) {
  /** @type {Map<string, RemoteDescriptor>} */
  const byName = new Map();

  for (const remote of remotes) {
    if (byName.has(remote.name)) {
      throw new Error(
        `${policy.url}: two remotes are named "${remote.name}". The name is the module cache key ` +
          `and the nav message key, so one of them would be unreachable under the other's label.`,
      );
    }
    byName.set(remote.name, remote);
  }

  for (const [index, remote] of remotes.entries()) {
    for (const other of remotes.slice(index + 1)) {
      if (remote.mount === other.mount) {
        throw new Error(
          `${policy.url}: remotes "${remote.name}" and "${other.name}" both mount at ` +
            `"${remote.mount}". The first declared one would answer for both, with its guard ` +
            `and its grants.`,
        );
      }
      const outer = covers(remote.mount, other.mount) ? remote : other;
      const inner = outer === remote ? other : remote;
      if (covers(outer.mount, inner.mount)) {
        throw new Error(
          `${policy.url}: remote "${outer.name}" mounts at "${outer.mount}" and owns everything ` +
            `beneath it, which contains remote "${inner.name}" at "${inner.mount}". A mount is a ` +
            `whole subtree, so one of these can never be routed to.`,
        );
      }
    }
  }
}

/**
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean}
 */
function covers(outer, inner) {
  return inner.startsWith(`${outer}/`);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {RemoteRequirements}
 */
function admitRequirements(value, where) {
  if (value === undefined) return Object.freeze({ session: false, permissions: Object.freeze([]) });
  const requires = asRecord(value, `${where} requires`, MANIFEST_KEYS.requires);

  const session = requires.session;
  if (session !== undefined && typeof session !== 'boolean') {
    throw new Error(`${where}: requires.session must be a boolean.`);
  }
  const permissions = requireStringArray(requires.permissions, `${where}: requires.permissions`);

  // Permissions only exist on a session, so requiring one without a session can never
  // be satisfied. Refuse it instead of repairing it.
  if (permissions.length > 0 && session === false) {
    throw new Error(
      `${where}: requires.permissions is non-empty but requires.session is false. ` +
        `Permissions come from a session, so this can never be satisfied.`,
    );
  }
  return Object.freeze({
    session: session ?? permissions.length > 0,
    permissions: Object.freeze(permissions),
  });
}

/**
 * Admit a remote's grants. A typo must fail at startup instead of silently becoming a
 * wider or narrower capability.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {RemoteGrants}
 */
function admitGrants(value, where) {
  if (value === undefined) {
    return Object.freeze({ api: Object.freeze([]), permissions: Object.freeze([]) });
  }
  const grants = asRecord(value, `${where} grants`, MANIFEST_KEYS.grants);

  const api = requireStringArray(grants.api, `${where}: grants.api`).map((prefix) => {
    if (!prefix.startsWith('/')) {
      throw new Error(
        `${where}: grants.api entry "${prefix}" must be a root-relative path prefix. ` +
          `Cross-origin grants are not expressible here: another origin needs CORS and a ` +
          `token minted for its audience, neither of which the shell can confer.`,
      );
    }
    // The trailing slash keeps `/api/analytics/` from also matching
    // `/api/analytics-admin/`.
    if (!prefix.endsWith('/')) {
      throw new Error(
        `${where}: grants.api entry "${prefix}" must end with "/". Without it the prefix also ` +
          `matches sibling paths that merely start with the same characters.`,
      );
    }
    // Normalize, because a grant is compared to a request's resolved pathname.
    return new URL(prefix, 'https://grants.invalid').pathname;
  });

  const permissions = requireStringArray(grants.permissions, `${where}: grants.permissions`);
  return Object.freeze({ api: Object.freeze(api), permissions: Object.freeze(permissions) });
}

/**
 * @param {unknown} value
 * @param {Policy} policy
 * @returns {AppManifest['auth']}
 */
function admitAuth(value, policy) {
  if (value === undefined) return undefined;
  const auth = asRecord(value, `${policy.url} auth`, MANIFEST_KEYS.auth);

  // One key, and it's a location. Which store an application uses and what its
  // endpoints are called is application configuration. ADR-0021.
  return Object.freeze({
    apiBaseUrl: admitPath(auth.apiBaseUrl, `${policy.url}: auth.apiBaseUrl`, policy),
  });
}

/**
 * @param {unknown} value
 * @param {Policy} policy
 * @returns {I18nConfig}
 */
function admitI18n(value, policy) {
  const url = policy.url;
  const i18n = asRecord(value ?? {}, `${url} i18n`, MANIFEST_KEYS.i18n);

  // Each absent field follows the other, so `{ "defaultLocale": "it" }` supports one
  // locale and `{ "supportedLocales": ["it", "en"] }` defaults to the first.
  const declaredDefault =
    i18n.defaultLocale === undefined
      ? undefined
      : admitLocale(i18n.defaultLocale, `${url}: i18n.defaultLocale`);
  const supported = i18n.supportedLocales ?? [declaredDefault ?? DEFAULT_LOCALE];
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new Error(`${url}: i18n.supportedLocales must be a non-empty array.`);
  }
  const supportedLocales = /** @type {unknown[]} */ (supported).map((entry, index) =>
    admitLocale(entry, `${url}: i18n.supportedLocales[${String(index)}]`),
  );
  const defaultLocale = declaredDefault ?? supportedLocales[0] ?? DEFAULT_LOCALE;
  if (!supportedLocales.includes(defaultLocale)) {
    throw new Error(
      `${url}: i18n.defaultLocale "${defaultLocale}" is not in supportedLocales. Every ` +
        `translation falls back to it, so it must be one of them.`,
    );
  }

  const patterns = admitBundlePatterns(
    i18n.bundles,
    `${url}: i18n.bundles`,
    supportedLocales,
    policy,
  );

  return Object.freeze({
    defaultLocale,
    supportedLocales: Object.freeze(supportedLocales),
    bundles: patterns,
    bundleFiles: admitBundleFiles(
      i18n.bundleFiles,
      `${url}: i18n.bundleFiles`,
      patterns,
      supportedLocales,
      policy,
    ),
  });
}

/**
 * Admit the file each resolved bundle URL is served from.
 *
 * A pattern can't carry a content hash, since `{locale}` is its only variable. A build
 * that hash-names bundles lists the emitted file for each resolved URL. The runtime
 * still resolves the pattern and uses this map for the final fetch. Without the map,
 * each bundle is fetched at its declared URL.
 *
 * Keys must be URLs the patterns and supported locales actually produce, and only the
 * whole document knows that set. ADR-0010.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {readonly string[]} patterns
 * @param {readonly string[]} supportedLocales
 * @param {Policy} policy
 * @returns {Readonly<Record<string, string>>}
 */
function admitBundleFiles(value, where, patterns, supportedLocales, policy) {
  if (value === undefined) return Object.freeze({});
  const declared = asRecord(value, where, undefined);
  const resolvable = new Set(
    patterns.flatMap((pattern) =>
      supportedLocales.map((locale) => pattern.split(LOCALE_PLACEHOLDER).join(locale)),
    ),
  );

  /** @type {Record<string, string>} */
  const files = {};
  for (const [url, emitted] of Object.entries(declared)) {
    const entryWhere = `${where}[${JSON.stringify(url)}]`;
    if (!resolvable.has(url)) {
      throw new Error(
        `${entryWhere} maps a URL no bundle pattern resolves to for a supported locale. A ` +
          `mapping the runtime never looks up is a file that is emitted and never fetched.`,
      );
    }
    // A build emits this map and pins every file in it, so a manifest can't remap a
    // locale to bytes the document doesn't vouch for. ADR-0129.
    files[url] = requirePin(admitPath(emitted, entryWhere, policy), entryWhere, policy);
  }
  return Object.freeze(files);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {readonly string[]} supportedLocales
 * @param {Policy} policy
 */
function admitBundlePatterns(value, where, supportedLocales, policy) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of URL patterns.`);
  const patterns = /** @type {unknown[]} */ (value).map((entry, index) => {
    const entryWhere = `${where}[${String(index)}]`;
    const pattern = requireString(entry, entryWhere);
    if (!pattern.includes(LOCALE_PLACEHOLDER)) {
      throw new Error(
        `${entryWhere} "${pattern}" has no ${LOCALE_PLACEHOLDER} placeholder, so it would serve the ` +
          `same messages for every language.`,
      );
    }
    // Admit each locale's substituted URL, because that URL is what gets fetched.
    for (const locale of supportedLocales) {
      const resolved = pattern.split(LOCALE_PLACEHOLDER).join(locale);
      admitPath(resolved, `${entryWhere} for locale "${locale}"`, policy);
    }
    return pattern;
  });
  return Object.freeze(patterns);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function admitLocale(value, where) {
  const locale = requireString(value, where);
  if (!LOCALE.test(locale)) {
    throw new Error(
      `${where} must be a language tag such as "en" or "pt-BR", got ${JSON.stringify(locale)}. ` +
        `It is substituted into every bundle URL, so it may not carry path syntax.`,
    );
  }
  return locale;
}

/**
 * Index the page's pins by normalized path, so they compare to manifest URLs as
 * destinations. Read lazily, since a page without remotes needs no import map.
 *
 * @param {ManifestSource} source
 * @returns {() => Map<string, string>}
 */
function pinIndex(source) {
  /** @type {Map<string, string> | undefined} */
  let index;
  return () => (index ??= readPins(source));
}

/**
 * @param {ManifestSource} source
 * @returns {Map<string, string>}
 */
function readPins(source) {
  const origin = new URL(source.base).origin;

  /** @type {Map<string, string>} */
  const index = new Map();
  for (const [key, digest] of Object.entries(source.pins())) {
    if (typeof digest !== 'string') continue;
    try {
      const target = new URL(key, source.base);
      if (target.origin === origin) index.set(target.pathname + target.search, digest);
    } catch {
      // A key that isn't a URL can't pin a manifest URL.
    }
  }
  return index;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string[]}
 */
function requireStringArray(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of strings.`);
  return /** @type {unknown[]} */ (value).map((entry, index) =>
    requireString(entry, `${where}[${String(index)}]`),
  );
}

/**
 * Require an object, and with `keys`, refuse a key outside them. A key starting with
 * `$` is an annotation and is always allowed.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {readonly string[] | undefined} keys
 * @returns {Record<string, unknown>}
 */
function asRecord(value, where, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object.`);
  }
  if (keys !== undefined) {
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || keys.includes(key)) continue;
      throw new Error(
        `${where} has a key admission does not know, ${JSON.stringify(key)}. It takes ` +
          `${keys.map((known) => JSON.stringify(known)).join(', ')}, and \`$\` keys as annotations.`,
      );
    }
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function requireString(value, where) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where} must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  return value;
}
