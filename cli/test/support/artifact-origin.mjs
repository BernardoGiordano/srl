/**
 * A static origin that serves one built artifact, and a Chrome to drive it.
 *
 * Shared because two suites need the same origin: the library's own, which builds the
 * example application, and whichever repository pilots the artifact pipeline on a real
 * application of its own.
 *
 * The serving itself is `cli/origin/index.mjs` — the mounts, the traversal refusal, the
 * directory index and the history fallback, the same rules the development server and the
 * benchmark origin answer with (ADR-0075). The whole point of driving the built bytes in a
 * browser is that nothing about the serving is approximate, and a private copy of a file
 * server is a second place for a MIME type or a fallback rule to be subtly wrong. What is
 * stated here is only what a test needs and production must never have: an entry document
 * whose module is swapped for a test starter, one deliberately unavailable path, and one
 * deliberately tampered byte.
 *
 * Not part of the published package: this is test support for repositories that consume
 * cli/, reached by path like the rest of cli/.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Launcher } from 'chrome-launcher';
import { parse, serialize } from 'parse5';
import puppeteer from 'puppeteer-core';

import { send, serveOrigin } from '../../origin/index.mjs';
import { MOUNTS } from '../../package/interface.mjs';

/** @param {string} path */
function artifactCache(path) {
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (path === '/app.manifest.json' || path.startsWith('/i18n/')) return 'private, no-cache';
  return 'no-cache';
}

/**
 * The module the test page runs instead of the production entry: install the
 * application's own HTTP fake, sign in against it, then import the real entry.
 *
 * The credential is the fake's, and the fake is the module the application's browser
 * suite already installs — so a caller that needs different values passes them rather
 * than this file knowing anybody's username.
 *
 * @param {string} entry
 * @param {{ username?: string, password?: string }} [session]
 */
function testStart(entry, session = {}) {
  const credential = { username: session.username ?? 'artifact-test', password: session.password ?? 'artifact-test' };
  return `import { installFakeServer } from '/__artifact-test/fake-server.js';
installFakeServer();
await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: ${JSON.stringify(JSON.stringify(credential))},
});
await import('/${entry}');
globalThis.__artifactReady = true;
`;
}

/**
 * Replace only the production module entry with a same-origin test starter. CSS, body,
 * metadata, and every other byte come from the emitted entry document.
 *
 * @param {string} source
 * @param {string} entry
 */
function testEntryHtml(source, entry) {
  const document = /** @type {{ childNodes?: unknown[] }} */ (parse(source));
  let replaced = 0;
  /** @type {string[]} */
  const inlineScripts = [];
  /** @param {unknown} value */
  const visit = (value) => {
    const node = /** @type {{ tagName?: string, attrs?: Array<{ name: string, value: string }>, childNodes?: unknown[] }} */ (
      value
    );
    if (node.tagName === 'script') {
      const type = node.attrs?.find((attribute) => attribute.name === 'type');
      const src = node.attrs?.find((attribute) => attribute.name === 'src');
      if (type?.value === 'module' && src?.value === `/${entry}`) {
        src.value = '/__artifact-test/start.js';
        replaced += 1;
      }
      if (src === undefined) {
        inlineScripts.push(
          (node.childNodes ?? [])
            .map((child) => /** @type {{ value?: string }} */ (child).value ?? '')
            .join(''),
        );
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  assert.equal(replaced, 1, 'production HTML must contain exactly one reported entry script');
  return { html: serialize(/** @type {never} */ (document)), inlineScripts };
}

/**
 * @param {string} origin
 */
export async function launchChrome(origin) {
  const executablePath = process.env.CHROME_PATH ?? Launcher.getInstallations()[0];
  if (executablePath === undefined || executablePath === '') {
    throw new Error('No Chrome installation found for production-artifact browser tests.');
  }
  const host = new URL(origin).hostname;
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`,
      '--proxy-server=http://127.0.0.1:1',
      `--proxy-bypass-list=${host}`,
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

/**
 * The two modules the test page loads that the artifact does not contain: the starter
 * that replaced the production entry, and the application's own HTTP fake behind it.
 *
 * @param {string} appDir
 * @param {string} start
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL) => Promise<boolean>}
 */
function testModules(appDir, start) {
  const fakeServer = join(appDir, 'test', 'fake-server.js');
  return async (_request, response, url) => {
    if (url.pathname === '/__artifact-test/start.js') {
      send(response, { type: 'text/javascript; charset=utf-8', body: Buffer.from(start) });
      return true;
    }
    if (url.pathname === '/__artifact-test/fake-server.js') {
      send(response, {
        type: 'text/javascript; charset=utf-8',
        body: await readFile(fakeServer),
      });
      return true;
    }
    return false;
  };
}

/**
 * @param {{ appDir: string, artifactDir: string, entry: string, csp: string, unavailable: string | null, tampered: string | null, session?: { username?: string, password?: string }, mounts?: Array<{ base: string, dir: string }> }} options
 */
export async function startArtifactOrigin(options) {
  const entryDocument = join(options.artifactDir, 'index.html');
  const { html } = testEntryHtml(await readFile(entryDocument, 'utf8'), options.entry);
  const entryBody = Buffer.from(html, 'utf8');
  const modules = testModules(options.appDir, testStart(options.entry, options.session));

  // Each Remote is published under its own base, so those mounts are declared before
  // the artifact's own `/` — which matches everything.
  const mounts = /** @type {Array<[string, string]>} */ ([
    ...(options.mounts ?? []).map(({ base, dir }) => [base, dir]),
    ['/', options.artifactDir],
  ]);

  return serveOrigin({
    mounts,
    fallback: entryDocument,

    headers: (pathname, file) => ({
      'Cache-Control': file === entryDocument ? 'private, no-cache' : artifactCache(pathname),
      ...(file === entryDocument ? { 'Content-Security-Policy': options.csp } : {}),
    }),

    transform: async (file, { pathname }) => {
      if (file === entryDocument) return { body: entryBody };
      // One byte more than the integrity pin covers, so the browser's own
      // subresource check is what fails rather than an assertion here.
      if (pathname === options.tampered) {
        return { body: Buffer.concat([await readFile(file), Buffer.from('\n')]) };
      }
      return null;
    },

    route: async (request, response, url) => {
      if (url.pathname === options.unavailable) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Deliberately unavailable');
        return true;
      }
      if (await modules(request, response, url)) return true;
      if (url.pathname === '/api/events') {
        // Held open and never written to: the application's live feed must connect
        // without the suite having to model a stream.
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        response.write('retry: 60000\n\n');
        return true;
      }
      return false;
    },
  });
}

/**
 * Source-delivery adapter used only as the visual oracle for the production artifact.
 *
 * The library's mounts come from the package rather than from two hardcoded prefixes:
 * they resolve inside the package wherever it sits, its own root in a standalone
 * checkout and a submodule in a repository that consumes one. Asking the package is what
 * lets a consuming repository run this suite at all.
 *
 * @param {{ appDir: string, entry: string, session?: { username?: string, password?: string } }} options
 */
export async function startSourceOrigin(options) {
  const entryDocument = join(options.appDir, 'index.html');
  const transformed = testEntryHtml(await readFile(entryDocument, 'utf8'), options.entry);
  const entryBody = Buffer.from(transformed.html, 'utf8');
  const hashes = transformed.inlineScripts.map(
    (source) => `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`,
  );
  const csp =
    `default-src 'self'; script-src 'self' ${hashes.join(' ')}; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; trusted-types lit-html ui-test ui-test-template; " +
    "require-trusted-types-for 'script'";
  const modules = testModules(options.appDir, testStart(options.entry, options.session));

  return serveOrigin({
    mounts: /** @type {Array<[string, string]>} */ ([...MOUNTS, ['/', options.appDir]]),
    fallback: entryDocument,

    headers: (_pathname, file) => ({
      'Cache-Control': 'no-cache',
      ...(file === entryDocument ? { 'Content-Security-Policy': csp } : {}),
    }),

    transform: (file) => (file === entryDocument ? { body: entryBody } : null),

    route: modules,
  });
}
