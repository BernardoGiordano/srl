/**
 * The JSON Schema for `app.manifest.json`, generated from the admission policy.
 *
 * Admission decides and the schema helps an editor complete and underline. The keys,
 * the patterns, the asset types and the default locale come from `manifest-policy.js`,
 * so the schema cannot offer a key admission refuses or miss one it reads. Generation
 * fails when a key has no entry here, or when an entry names a key admission does not
 * know.
 *
 * Some rules need the whole document or the page, so only admission applies them. Those
 * are the import map pin, two remotes on one mount or one name, a mount inside another
 * and a bundle file no pattern resolves to. ADR-0010, ADR-0123.
 *
 * `npm run docs:write` writes the file and `npm run docs:check` fails when it drifts.
 */

import {
  ASSET_TYPES,
  DEFAULT_LOCALE,
  MANIFEST_KEYS,
  MANIFEST_PATTERNS,
} from '@srljs/core/lib/core/remotes/manifest-policy.js';

/** @typedef {Record<string, unknown>} Schema */

/** A same-origin, root-relative path, as admission's path rule reads it. */
const PATH = '^/(?!/)[^\\\\#]*$';

/** @param {string} description @returns {Schema} */
function path(description) {
  return { type: 'string', pattern: PATH, description };
}

/** @param {Schema} items @param {string} description @returns {Schema} */
function list(items, description) {
  return { type: 'array', items, uniqueItems: true, description };
}

/** @param {string} text @returns {string} */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const placeholder = escapeRegExp(MANIFEST_PATTERNS.localePlaceholder);

/** @type {Schema} */
const BUNDLE_PATTERN = {
  type: 'string',
  pattern: `^/(?!/)[^\\\\#]*${placeholder}[^\\\\#]*$`,
  description: `A root-relative URL with a ${MANIFEST_PATTERNS.localePlaceholder} placeholder.`,
};

/** @type {Schema} */
const LOCALE = { type: 'string', pattern: MANIFEST_PATTERNS.locale };

/**
 * The schema for each key admission reads, grouped as `MANIFEST_KEYS` groups them.
 *
 * @type {Record<keyof typeof MANIFEST_KEYS, Record<string, Schema>>}
 */
const FIELDS = {
  manifest: {
    remotes: list(
      { $ref: '#/definitions/remote' },
      'Micro-frontends this application mounts. Absent means none.',
    ),
    auth: {
      $ref: '#/definitions/auth',
      description: 'Where the application API lives. Absent means the application calls no API through the manifest.',
    },
    i18n: {
      $ref: '#/definitions/i18n',
      description: `Locales and message bundles. Absent means one locale, "${DEFAULT_LOCALE}", with no bundles.`,
    },
    templateBundle: path('One JSON file holding every template. `srl build --templates bundle` writes it.'),
    templateGroups: {
      type: 'object',
      additionalProperties: list(path('A template URL.'), 'The templates one chunk names.'),
      description: 'Templates grouped by the chunk that names them. `srl build` writes it.',
    },
    templateFiles: list(path('A template URL.'), 'Every template, fetched at startup. Leave it to the build.'),
  },
  auth: {
    apiBaseUrl: path('The root-relative base URL of the application API.'),
  },
  i18n: {
    defaultLocale: {
      ...LOCALE,
      description: `The locale every translation falls back to. Absent means the first supported locale, or "${DEFAULT_LOCALE}".`,
    },
    supportedLocales: {
      type: 'array',
      items: LOCALE,
      minItems: 1,
      uniqueItems: true,
      description: 'Every locale the application offers. Absent means the default locale alone.',
    },
    bundles: list(BUNDLE_PATTERN, 'Message bundle URL patterns, resolved once per supported locale.'),
    bundleFiles: {
      type: 'object',
      additionalProperties: path('The emitted file.'),
      description: 'The emitted file for each resolved bundle URL. `srl build` writes it.',
    },
  },
  remote: {
    name: { type: 'string', minLength: 1, description: 'Unique per manifest. The import cache key and the nav message key.' },
    url: path('The remote entry module.'),
    integrity: { type: 'string', pattern: MANIFEST_PATTERNS.integrity, description: 'The sha384 digest the page import map pins for `url`.' },
    assets: list({ $ref: '#/definitions/asset' }, 'Every file the remote publishes, entry module included.'),
    shared: list(
      { type: 'string', minLength: 1, not: { pattern: MANIFEST_PATTERNS.notBare } },
      'Bare specifiers the shell supplies.',
    ),
    locales: list(BUNDLE_PATTERN, 'The remote message bundle URL patterns.'),
    templates: path('The remote template bundle, named again in `assets`.'),
    templateFiles: list(path('A template URL.'), 'The remote templates, started beside its entry module.'),
    mount: {
      type: 'string',
      pattern: '^/(?!/)[^\\\\#*:?]*[^\\\\#*:?/][^\\\\#*:?]*$',
      description: 'The path prefix the remote owns, such as "/billing". Not "/".',
    },
    requires: { $ref: '#/definitions/requires', description: 'Checked before the remote code is fetched.' },
    grants: { $ref: '#/definitions/grants', description: 'The most the remote host context may do.' },
  },
  asset: {
    type: { enum: [...ASSET_TYPES] },
    url: path('Where the asset is published.'),
    integrity: { type: 'string', pattern: MANIFEST_PATTERNS.integrity },
  },
  requires: {
    session: { type: 'boolean', description: 'Redirect to /login without a session.' },
    permissions: list({ type: 'string', minLength: 1 }, 'Redirect to /forbidden unless the session holds all of these.'),
  },
  grants: {
    api: list(
      { type: 'string', pattern: '^/.*/$' },
      'Root-relative path prefixes, each ending in "/", the remote may call.',
    ),
    permissions: list({ type: 'string', minLength: 1 }, 'Permissions the remote may ask about.'),
  },
};

/** Keys an object must hold. Every other key is optional. */
const REQUIRED = /** @type {Partial<Record<keyof typeof MANIFEST_KEYS, string[]>>} */ ({
  auth: ['apiBaseUrl'],
  remote: ['name', 'url', 'integrity', 'mount'],
  asset: ['type', 'url', 'integrity'],
});

/**
 * One object, closed to the keys admission knows and open to `$` annotations.
 *
 * @param {keyof typeof MANIFEST_KEYS} kind
 * @returns {Schema}
 */
function object(kind) {
  const keys = MANIFEST_KEYS[kind];
  const fields = FIELDS[kind];
  const missing = keys.filter((key) => !(key in fields));
  const unknown = Object.keys(fields).filter((key) => !keys.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `The ${kind} schema is out of step with admission. Missing: ${missing.join(', ') || 'none'}. ` +
        `Unknown: ${unknown.join(', ') || 'none'}.`,
    );
  }
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((key) => [key, fields[key]])),
    patternProperties: { '^\\$': {} },
    additionalProperties: false,
    ...(REQUIRED[kind] === undefined ? {} : { required: REQUIRED[kind] }),
  };
}

/**
 * The schema document.
 *
 * @returns {Schema}
 */
export function manifestSchema() {
  /** @type {Array<keyof typeof MANIFEST_KEYS>} */
  const kinds = ['auth', 'i18n', 'remote', 'asset', 'requires', 'grants'];
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'srl app.manifest.json',
    description:
      'Runtime configuration an srl application fetches at startup. Generated from the admission policy, which has the final word.',
    ...object('manifest'),
    definitions: Object.fromEntries(kinds.map((kind) => [kind, object(kind)])),
  };
}

/**
 * The file's bytes.
 *
 * @returns {string}
 */
export function manifestSchemaText() {
  return `${JSON.stringify(manifestSchema(), null, 2)}\n`;
}
