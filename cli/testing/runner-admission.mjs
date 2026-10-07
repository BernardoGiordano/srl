import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';

import { parse, serialize } from 'parse5';

const TEST_FILE = 'wtr-test-file';
const SESSION_ID = 'wtr-session-id';
const MANUAL_SESSION = 'wtr-manual-session';
const DELIMITERS = /[<>"'`&\\]/u;

/** @param {unknown} value */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

/** @param {string} value */
export function htmlAttribute(value) {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * A test selector names one canonical local path, with only the manual flag the
 * runner's debug menu adds. It never supplies a module origin or arbitrary query.
 *
 * @param {string} value
 * @returns {string | null}
 */
function testPath(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!value.startsWith('/') || value.startsWith('//') || DELIMITERS.test(decoded) ||
      [...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
    const url = new URL(value, 'http://localhost');
    const path = value.split('?')[0];
    if (url.hash || url.pathname !== path || encodeURI(decodeURI(url.pathname)) !== path) return null;
    if (url.search !== '' && url.search !== `?${MANUAL_SESSION}=true`) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

/**
 * The runner's public reporter hook supplies its resolved test registry and live
 * sessions. Requests fail closed until that registry is available.
 *
 * @param {string[]} policies
 */
export function runnerAdmission(policies) {
  for (const policy of policies) {
    if (!/^[\w#=\-/@.%]+$/u.test(policy)) throw new Error(`Invalid Trusted Types policy: ${policy}`);
  }
  const tests = new Set(/** @type {string[]} */ ([]));
  /** @type {import('@web/test-runner').TestSessionManager | undefined} */
  let sessions;

  return {
    /** @param {import('@web/test-runner').ReporterArgs} args */
    start({ config, testFiles, sessions: registeredSessions }) {
      tests.clear();
      sessions = undefined;
      for (const file of testFiles) {
        const path = encodeURI(`/${relative(config.rootDir, file).split(sep).join('/')}`);
        if (testPath(path) !== path) throw new Error(`Unsafe test file path: ${file}`);
        tests.add(path);
      }
      sessions = registeredSessions;
    },

    /** @param {URL} url */
    admits(url) {
      const selected = url.searchParams.getAll(TEST_FILE);
      const ids = url.searchParams.getAll(SESSION_ID);
      if (selected.length > 1 || ids.length > 1 || (selected.length > 0 && ids.length > 0)) return false;
      if (selected.length) {
        const path = testPath(selected[0] ?? '');
        return sessions !== undefined && path !== null && tests.has(path) &&
          (url.pathname === '/' || url.pathname === path);
      }
      if (ids.length) return !!(sessions?.get(ids[0] ?? '') ?? sessions?.getDebug(ids[0] ?? ''));
      return true;
    },

    /**
     * Serialize attributes and embedded configuration after all upstream transforms.
     * The response policy authorizes the final inline scripts by their exact bytes.
     *
     * @param {string} html
     * @returns {{ html: string, policy: string }}
     */
    protect(html) {
      const document = parse(html);
      const hashes = new Set(/** @type {string[]} */ ([]));
      /** @param {import('parse5').Node} node */
      const visit = (node) => {
        if ('tagName' in node && node.tagName === 'script' && !node.attrs.some(({ name }) => name === 'src')) {
          const text = node.childNodes.filter((child) => 'value' in child);
          let body = text.map((child) => child.value).join('');
          const prefix = 'window.__WTR_CONFIG__ = ';
          if (body.startsWith(prefix)) {
            body = `${prefix}${scriptJson(JSON.parse(body.slice(prefix.length)))}`;
            const first = text[0];
            if (first !== undefined) first.value = body;
          }
          hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
        }
        if ('childNodes' in node) for (const child of node.childNodes) visit(child);
      };
      visit(document);
      return {
        html: serialize(document),
        policy: `script-src 'self' ${[...hashes].join(' ')}; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; trusted-types ${policies.join(' ')}; require-trusted-types-for 'script'`,
      };
    },
  };
}
