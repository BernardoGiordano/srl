/**
 * The page's pin table. ADR-0129.
 *
 * The integrity block of the page's import map pins the bytes the page may run or
 * render: modules, templates, template bundles, locale bundles and the stylesheet. The
 * document carries it, the production CSP admits it by hash, and `app.manifest.json`
 * can't change it. Every loader asks `pinFor` and passes the answer to `fetch`, so a
 * changed file fails its request instead of reaching the page.
 *
 * Browsers apply the block only to module scripts, and some engines ignore it.
 * `pinsEnforced` proves this one doesn't before a remote's code is imported.
 *
 * Reading the module has no side effects, so Node tools can import its constants.
 * Every export is internal, because applications don't load bytes through it.
 */

/**
 * The specifier of the deterministic module pinned wrong on purpose.
 *
 * @internal
 */
export const PROBE_SPECIFIER = '@core/foundation/pin-probe.js';

/**
 * The digest of zero bytes, shared by the empty control and the nonempty mismatch.
 *
 * @internal
 */
export const PROBE_PIN = 'sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb';

/** The probe URLs carry fixed JavaScript bytes without a network request. @internal */
export const PROBE_URL = 'data:text/javascript,export%20const%20probe%20%3D%20true%3B#srl-pin-probe';
/** @internal */
export const PROBE_CONTROL_URL = 'data:text/javascript,export%20const%20probe%20%3D%20true%3B#srl-pin-control';
/** @internal */
export const PROBE_EMPTY_URL = 'data:text/javascript,#srl-pin-empty';
/** The matching digest for the nonempty control. @internal */
export const PROBE_CONTROL_PIN = 'sha384-THhiqtbWX5OeF4HVBm/Zv1KwP1F/7VKSRBsO2utL7lYi95x/jfLVpbG0o0up8PT5';

/**
 * @typedef {{
 *   imports: Readonly<Record<string, unknown>>,
 *   integrity: Readonly<Record<string, unknown>>,
 * }} PageImportMap
 */

/**
 * The parsed import map and its pins by same-origin path, for the map text they came
 * from. A test that swaps the map gets a new table.
 *
 * @type {{ text: string, map: PageImportMap, pins: Map<string, string> } | undefined}
 */
let cached;

/**
 * The page's import map, or null for a page without one.
 *
 * @returns {PageImportMap | null}
 * @internal
 */
export function pageImportMap() {
  return read()?.map ?? null;
}

/**
 * The digest the page pins for a URL, or undefined when it pins none.
 *
 * Keys and the URL compare as same-origin paths with their query, so `/a/../b.js` and
 * `/b.js` are one file. A cross-origin URL has no pin.
 *
 * @param {string | URL} url
 * @returns {string | undefined}
 * @internal
 */
export function pinFor(url) {
  const table = read();
  if (table === undefined) return undefined;
  const target = new URL(url, document.baseURI);
  if (target.origin !== location.origin) return undefined;
  return table.pins.get(target.pathname + target.search);
}

/**
 * `init` with the URL's pin as `integrity`, or `init` unchanged for an unpinned URL.
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {RequestInit}
 * @internal
 */
export function pinned(url, init = {}) {
  const pin = pinFor(url);
  return pin === undefined ? init : { ...init, integrity: pin };
}

/**
 * The page's integrity block as written, for manifest admission. Throws when there is
 * no import map, because nothing then pins the bytes a remote names.
 *
 * @returns {Readonly<Record<string, unknown>>}
 * @internal
 */
export function pageIntegrity() {
  const map = pageImportMap();
  if (map === null) {
    throw new Error(
      'A remote cannot be verified: the page has no import map, so nothing pins the bytes the ' +
        'manifest names.',
    );
  }
  return map.integrity;
}

/** @type {Promise<void> | undefined} */
let enforcement;

/**
 * Resolve when this engine enforces import-map integrity, and reject when it doesn't.
 *
 * Two matching data-URL controls prove that both probe digests pass CSP and that the
 * fixed bytes evaluate. Only then can refusal of the same nonempty bytes under the
 * empty digest prove enforcement. None of these imports has a transport to fail.
 *
 * The verdict is kept for the page's lifetime. Inconclusive checks are retried by
 * the next caller.
 *
 * @returns {Promise<void>}
 * @internal
 */
export function pinsEnforced() {
  enforcement ??= probe().catch((/** @type {unknown} */ cause) => {
    if (!(cause instanceof PinsIgnored)) enforcement = undefined;
    throw cause;
  });
  return enforcement;
}

/** The engine imported the probe, so it ignores the page's pins. */
class PinsIgnored extends Error {}

async function probe() {
  const map = pageImportMap();
  const url = map === null ? undefined : resolveSpecifier(map.imports, PROBE_SPECIFIER);
  if (url !== PROBE_URL || map?.integrity[PROBE_URL] !== PROBE_PIN) {
    throw new Error(
      `Remotes cannot load: the page's import map must resolve ${PROBE_SPECIFIER} and pin its ` +
        `URL to ${PROBE_PIN}. Startup checks it to prove this browser enforces import-map ` +
        'integrity. Paste the import-map fragment `srl importmap` prints.',
    );
  }
  if (map.integrity[PROBE_CONTROL_URL] !== PROBE_CONTROL_PIN ||
    map.integrity[PROBE_EMPTY_URL] !== PROBE_PIN) {
    throw new Error(
      'Remotes cannot load: the import map must pin both matching integrity controls. ' +
        'Paste the import-map fragment `srl importmap` prints.',
    );
  }

  for (const target of [PROBE_CONTROL_URL, PROBE_EMPTY_URL, PROBE_URL]) {
    if (import.meta.resolve(target) !== target) {
      throw new Error('Remotes cannot load: an integrity probe URL is remapped, so its bytes are not known.');
    }
  }
  try {
    const control = await importProbe(PROBE_CONTROL_URL);
    const empty = await importProbe(PROBE_EMPTY_URL);
    if (control.probe !== true || Object.keys(empty).length !== 0) {
      throw new Error('An integrity control returned unexpected exports.');
    }
  } catch (cause) {
    throw new Error(
      'Remotes cannot load: matching integrity controls failed, so enforcement is inconclusive. ' +
        `script-src must allow '${PROBE_CONTROL_PIN}' and '${PROBE_PIN}'.`,
      { cause },
    );
  }

  try {
    await importProbe(PROBE_URL);
  } catch (cause) {
    if (!(cause instanceof TypeError)) {
      throw new Error('Remotes cannot load: the integrity mismatch failed unexpectedly.', { cause });
    }
    return;
  }
  throw new PinsIgnored(
    `Remotes are refused in this browser, because it ignores import-map integrity. It ran ` +
      `${url} against a pin that cannot match, so it would also run a remote's changed code. ` +
      `Engine: ${navigator.userAgent}`,
  );
}

/**
 * @param {string} url
 * @returns {Promise<Record<string, unknown>>}
 */
async function importProbe(url) {
  return asRecord(await import(url), 'an integrity probe');
}

/**
 * Resolve a bare specifier through an exact key or the longest matching prefix.
 *
 * @param {Readonly<Record<string, unknown>>} imports
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveSpecifier(imports, specifier) {
  const exact = imports[specifier];
  if (typeof exact === 'string') return new URL(exact, document.baseURI).href;

  let match = '';
  for (const key of Object.keys(imports)) {
    if (key.endsWith('/') && specifier.startsWith(key) && key.length > match.length) match = key;
  }
  const target = imports[match];
  if (match === '' || typeof target !== 'string') return undefined;
  return new URL(specifier.slice(match.length), new URL(target, document.baseURI)).href;
}

/** @returns {{ text: string, map: PageImportMap, pins: Map<string, string> } | undefined} */
function read() {
  const script = document.querySelector('script[type="importmap"]');
  if (script === null) return undefined;
  const text = script.textContent ?? '';
  if (cached?.text === text) return cached;

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The page's import map is invalid JSON, so it pins nothing.");
  }
  const root = asRecord(parsed, 'the page import map');
  const map = {
    imports: root.imports === undefined ? {} : asRecord(root.imports, 'the page import map imports'),
    integrity:
      root.integrity === undefined
        ? {}
        : asRecord(root.integrity, 'the page import map integrity block'),
  };

  /** @type {Map<string, string>} */
  const pins = new Map();
  for (const [key, digest] of Object.entries(map.integrity)) {
    if (typeof digest !== 'string') continue;
    try {
      const target = new URL(key, document.baseURI);
      if (target.origin === location.origin) pins.set(target.pathname + target.search, digest);
    } catch {
      // A key that isn't a URL pins nothing.
    }
  }
  cached = { text, map, pins };
  return cached;
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
