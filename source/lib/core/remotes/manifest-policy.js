/**
 * Whole-manifest admission: the one place runtime configuration becomes policy.
 *
 * `app.manifest.json` is fetched on every load and decides where executable code
 * is imported from, where credentials are sent, which path each remote owns and
 * which files the locale and template caches are seeded from. The cross-field
 * decisions are made once, here, before anything downstream is constructed, and
 * everything after this module reads admitted values — normalized,
 * collision-checked and frozen — rather than the parsed document. ADR-0010.
 *
 * The module imports nothing, like `template/dialect.js` and for the same reason:
 * `tools/checks/verify-deps.mjs` loads it in Node and admits every checked-in
 * manifest against the same rules the browser applies at startup. The two adapters
 * differ only in where the page's import-map pins come from, which is why those
 * arrive as an argument instead of being read from `document` here.
 *
 * What belongs here: URL shape and trust, cross-field collisions, and the
 * normalized shape downstream modules may assume. What does not: fetching the
 * document and reading the page's import map (`remotes/mfe.js`), and anything
 * that acts on an admitted manifest.
 *
 * ## The trust rule
 *
 * Every URL in the manifest is a same-origin root-relative path, and admission
 * rejects anything else rather than repairing it. ADR-0012. Cross-origin
 * authentication is therefore not expressible as a manifest string: it is a
 * capability of a deployment, not a value a fetched JSON file can introduce.
 */

/** @import { I18nConfig } from '@core/localization/types.js' */
/** @import { AppManifest, ManifestSource, RemoteDescriptor, RemoteGrants, RemoteRequirements } from '@core/remotes/types.js' */

/**
 * The digest form the manifest and the page's import map must agree on. One
 * algorithm rather than a set: two spellings of the same pin is a comparison
 * nobody would write correctly a second time.
 */
const SHA384 = /^sha384-[A-Za-z0-9+/]{64}$/u;

/**
 * A locale tag, restricted to the subset that is safe to substitute into a URL
 * pattern. `bundles` interpolates the negotiated locale into a path, so a tag
 * carrying `/`, `..` or a percent-escape would let the locale list choose a file
 * outside the bundle directory that the pattern appears to name.
 */
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** The placeholder every bundle pattern must contain. */
const LOCALE_PLACEHOLDER = '{locale}';

/**
 * Admission state for one document: where it came from, what its paths resolve
 * against, and the page's integrity pins, read at most once and only if a remote
 * needs them.
 *
 * @typedef {{
 *   url: string,
 *   origin: string,
 *   base: string,
 *   pins: () => Map<string, string>,
 * }} Policy
 */

/**
 * Validate, normalize and freeze one manifest document, or throw naming the file
 * and the field.
 *
 * Every value is rebuilt rather than cast over: the document is fetched at
 * runtime, and a cast would turn a typo in a deploy pipeline into
 * `undefined is not a function` deep inside a route resolution instead of one
 * message at startup.
 *
 * @param {unknown} value the parsed document
 * @param {ManifestSource} source where it came from and what the page pins
 * @returns {AppManifest}
 */
export function admitManifest(value, source) {
  const url = source.url;
  const root = asRecord(value, url);

  /** @type {Policy} */
  const policy = {
    url,
    origin: new URL(source.base).origin,
    base: source.base,
    pins: pinIndex(source),
  };

  const i18n = admitI18n(root.i18n, policy);
  const remotes = root.remotes;
  if (!Array.isArray(remotes)) {
    throw new Error(`${url} is missing a \`remotes\` array.`);
  }

  const admitted = /** @type {unknown[]} */ (remotes).map((entry, index) =>
    admitRemote(entry, index, policy, i18n.supportedLocales),
  );
  assertDistinct(admitted, policy);

  const templateBundle = root.templateBundle;

  return Object.freeze({
    remotes: Object.freeze(admitted),
    auth: admitAuth(root.auth, policy),
    i18n,
    templateBundle:
      templateBundle === undefined
        ? undefined
        : admitPath(templateBundle, `${url}: templateBundle`, policy),
    templateFiles: admitTemplateFiles(root.templateFiles, `${url}: templateFiles`, policy),
  });
}

/**
 * The list of template URLs an artifact emitted, admitted one entry at a time.
 *
 * A frozen empty array when the key is absent rather than `undefined`, because the
 * only consumer iterates it: an optional list that is sometimes a list and
 * sometimes nothing is a check at every call site for a document that simply says
 * "no templates to announce".
 *
 * Same-origin under the same rule as every other URL here. The runtime turns these
 * into `fetch` calls, and the page applies `connect-src 'self'`, so a cross-origin
 * entry would fail as a blocked request behind an optimisation nobody is watching
 * — one message at startup is the better failure. Duplicates are refused because a
 * list of content-addressed files that names one twice is a generator bug, and it
 * is cheaper to say so than to let it be silently harmless.
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
 * The trust rule, applied to one field.
 *
 * Normalization is part of admission rather than a courtesy: `/api/../auth` and
 * `/auth` are the same destination, and a downstream comparison that sees only
 * one spelling of it is the bug this returns a single form to prevent. A
 * backslash is rejected before parsing because the URL parser treats it as a
 * separator, which makes `/\evil.example/x` a cross-origin URL that reads like a
 * path.
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
  const entry = asRecord(value, `${policy.url} remotes[${String(index)}]`);
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
  if (
    assets.length > 0 &&
    !assets.some((asset) => asset.type === 'module' && asset.url === url && asset.integrity === integrity)
  ) {
    throw new Error(`${where} assets must include its entry module with the same URL and integrity.`);
  }
  const templateAssets = assets.filter((asset) => asset.type === 'template');
  if (
    (templates === undefined && templateAssets.length !== 0) ||
    (templates !== undefined &&
      (templateAssets.length !== 1 || templateAssets[0]?.url !== templates))
  ) {
    throw new Error(`${where} templates must name its single template asset.`);
  }

  return Object.freeze({
    name,
    url,
    integrity,
    assets,
    shared: admitShared(entry.shared, where),
    locales: admitBundlePatterns(entry.locales, `${where} locales`, supportedLocales, policy),
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
    const asset = asRecord(candidate, assetWhere);
    const type = requireString(asset.type, `${assetWhere}.type`);
    if (type !== 'module' && type !== 'style' && type !== 'template') {
      throw new Error(`${assetWhere}.type must be module, style or template.`);
    }
    const url = admitPath(asset.url, `${assetWhere}.url`, policy);
    if (seen.has(url)) throw new Error(`${where} assets names ${url} more than once.`);
    seen.add(url);
    const integrity = requireString(asset.integrity, `${assetWhere}.integrity`);
    if (!SHA384.test(integrity)) {
      throw new Error(`${assetWhere}.integrity must be one sha384 SRI digest.`);
    }
    if (type === 'module') assertPinned(url, integrity, assetWhere, policy);
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
    if (/^(?:\.|\/|(?:https?:)?\/\/)/u.test(specifier)) {
      throw new Error(`${where} shared entry ${JSON.stringify(specifier)} must be a bare specifier.`);
    }
    if (seen.has(specifier)) throw new Error(`${where} shared names ${specifier} more than once.`);
    seen.add(specifier);
  }
  return Object.freeze(shared);
}

/**
 * Require the manifest pin to match the page's static import-map pin. The
 * browser applies that integrity metadata to dynamic imports and every pinned
 * relative sub-import; comparing here prevents a mutable manifest from choosing
 * a new executable URL or digest at runtime.
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
 * A mount is a path prefix the remote owns, turned into a `${mount}/*` route.
 *
 * The syntax the router gives meaning to is excluded rather than escaped: `*`
 * and `:` would make a remote's mount into a wildcard or a parameter segment,
 * and a query string is not part of a path prefix at all. A trailing slash is
 * normalized away so `/billing` and `/billing/` cannot be declared as two
 * different remotes that own one subtree.
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
 * The invariants no single entry can see.
 *
 * Names collide silently: the name is the import cache key, the label
 * `ui-nav` asks for, and how a remote is identified in every message. Mounts
 * collide dangerously: routes are matched first-declared-first, so a duplicate
 * or a mount that contains another makes the order of the file — not the policy
 * written in it — decide which `requires` guard runs and which `grants` bound the
 * host context. Both are configuration mistakes that behave like features until
 * someone reorders the array.
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
  const requires = asRecord(value, `${where} requires`);

  const session = requires.session;
  if (session !== undefined && typeof session !== 'boolean') {
    throw new Error(`${where}: requires.session must be a boolean.`);
  }
  const permissions = requireStringArray(requires.permissions, `${where}: requires.permissions`);

  // Requiring a permission without requiring a session is not a coherent state:
  // scopes only exist on a session. Rather than silently repairing it, say so,
  // because the manifest is the security policy and a policy that means something
  // other than what it says is the failure mode worth preventing.
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
 * The manifest is where least privilege for a remote is written down, so it is
 * validated as strictly as the rest of it. A grant that is a typo must fail at
 * startup, not become a silently wider or narrower capability later.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {RemoteGrants}
 */
function admitGrants(value, where) {
  if (value === undefined) {
    return Object.freeze({ api: Object.freeze([]), permissions: Object.freeze([]) });
  }
  const grants = asRecord(value, `${where} grants`);

  const api = requireStringArray(grants.api, `${where}: grants.api`).map((prefix) => {
    if (!prefix.startsWith('/')) {
      throw new Error(
        `${where}: grants.api entry "${prefix}" must be a root-relative path prefix. ` +
          `Cross-origin grants are not expressible here: another origin needs CORS and a ` +
          `token minted for its audience, neither of which the shell can confer.`,
      );
    }
    // Trailing slash enforced so that a grant for /api/analytics/ cannot also
    // match /api/analytics-admin/. Prefix matching without it is a classic
    // authorization bypass, and it reads as correct.
    if (!prefix.endsWith('/')) {
      throw new Error(
        `${where}: grants.api entry "${prefix}" must end with "/". Without it the prefix also ` +
          `matches sibling paths that merely start with the same characters.`,
      );
    }
    // Normalized, because the grant is compared against a request's resolved
    // pathname: a grant written as `/api/analytics/../` would otherwise be
    // compared as text and never match the `/api/` it actually confers.
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
  const auth = asRecord(value, `${policy.url} auth`);

  // One key, and it is a location rather than a protocol. An application's
  // authentication configuration — which store it constructs, what its endpoints
  // are called, what its token response looks like — is its own, and admitting it
  // here would put a backend contract in the library. ADR-0021.
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
  const i18n = asRecord(value, `${url} i18n`);
  const defaultLocale = admitLocale(i18n.defaultLocale, `${url}: i18n.defaultLocale`);

  const supported = i18n.supportedLocales;
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new Error(`${url}: i18n.supportedLocales must be a non-empty array.`);
  }
  const supportedLocales = /** @type {unknown[]} */ (supported).map((entry, index) =>
    admitLocale(entry, `${url}: i18n.supportedLocales[${String(index)}]`),
  );
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
  });
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
    // The pattern is admitted through every locale it will actually be used
    // with, rather than as a string containing a placeholder: what is fetched is
    // the substituted URL, and that is the one that has to be same-origin.
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
 * Index the page's integrity pins by the same normalized path admission produces
 * for a manifest URL, so the two are compared as destinations rather than as
 * strings. Read lazily: a page with no remotes needs no import map to boot.
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
      // A key that is not a URL cannot pin a manifest URL. The import map's own
      // validity is the page's problem, not this module's.
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
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function asRecord(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object.`);
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
