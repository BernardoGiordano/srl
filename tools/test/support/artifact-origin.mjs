/**
 * A static origin that serves one built artifact, and a Chrome to drive it.
 *
 * Shared because two suites need the same origin: the library's own, which builds the
 * example application, and whichever repository pilots the artifact pipeline on a real
 * application of its own. A second private copy of a file server is a second place for
 * a MIME type or a fallback rule to be subtly wrong, and the whole point of driving the
 * built bytes in a browser is that nothing about the serving is approximate.
 *
 * Not part of the published package: this is test support for repositories that consume
 * tools/, reached by path like the rest of tools/.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';

import { Launcher } from 'chrome-launcher';
import { parse, serialize } from 'parse5';
import puppeteer from 'puppeteer-core';

import { PACKAGE, contentType } from '../../package/interface.mjs';

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
 * @param {{ appDir: string, artifactDir: string, entry: string, csp: string, unavailable: string | null, tampered: string | null, session?: { username?: string, password?: string }, mounts?: Array<{ base: string, dir: string }> }} options
 */
export async function startArtifactOrigin(options) {
  const { html } = testEntryHtml(
    await readFile(join(options.artifactDir, 'index.html'), 'utf8'),
    options.entry,
  );
  const start = testStart(options.entry, options.session);
  const fakeServer = join(options.appDir, 'test', 'fake-server.js');

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === options.unavailable) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Deliberately unavailable');
        return;
      }
      if (url.pathname === '/__artifact-test/start.js') {
        send(response, 'text/javascript; charset=utf-8', Buffer.from(start));
        return;
      }
      if (url.pathname === '/__artifact-test/fake-server.js') {
        send(response, 'text/javascript; charset=utf-8', await readFile(fakeServer));
        return;
      }
      if (url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        response.write('retry: 60000\n\n');
        return;
      }
      if (url.pathname === '/' || (!url.pathname.includes('.') && url.pathname !== '/')) {
        send(response, 'text/html; charset=utf-8', Buffer.from(html), {
          'Content-Security-Policy': options.csp,
          'Cache-Control': 'private, no-cache',
        });
        return;
      }

      const mount = options.mounts?.find((candidate) => url.pathname.startsWith(candidate.base));
      const file =
        mount === undefined
          ? safeFile(options.artifactDir, url.pathname)
          : safeFile(mount.dir, `/${url.pathname.slice(mount.base.length)}`);
      if (file === null || !(await isFile(file))) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const body = await readFile(file);
      send(
        response,
        contentType(file),
        url.pathname === options.tampered ? Buffer.concat([body, Buffer.from('\n')]) : body,
        { 'Cache-Control': artifactCache(url.pathname) },
      );
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(String(error));
    });
  });

  return listen(server);
}

/** @param {import('node:http').Server} server */
export async function listen(server) {
  await new Promise((done, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => done(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Production-artifact test origin did not bind a TCP port.');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done(undefined));
      }),
  };
}

/**
 * @param {string} root
 * @param {string} pathname
 */
export function safeFile(root, pathname) {
  const base = resolve(root);
  const file = resolve(join(base, normalize(decodeURIComponent(pathname))));
  return file === base || file.startsWith(base + sep) ? file : null;
}

/** @param {string} path */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {string} type
 * @param {Buffer} body
 */
export function send(response, type, body, headers = {}) {
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Content-Length': String(body.byteLength),
    ...headers,
  });
  response.end(body);
}

/**
 * Source-delivery adapter used only as the visual oracle for the production artifact.
 *
 * @param {{ appDir: string, entry: string, session?: { username?: string, password?: string } }} options
 */
export async function startSourceOrigin(options) {
  const transformed = testEntryHtml(
    await readFile(join(options.appDir, 'index.html'), 'utf8'),
    options.entry,
  );
  const hashes = transformed.inlineScripts.map(
    (source) => `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`,
  );
  const start = testStart(options.entry, options.session);
  const fakeServer = join(options.appDir, 'test', 'fake-server.js');

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__artifact-test/start.js') {
        send(response, 'text/javascript; charset=utf-8', Buffer.from(start));
        return;
      }
      if (url.pathname === '/__artifact-test/fake-server.js') {
        send(response, 'text/javascript; charset=utf-8', await readFile(fakeServer));
        return;
      }
      if (url.pathname === '/' || (!url.pathname.includes('.') && url.pathname !== '/')) {
        send(response, 'text/html; charset=utf-8', Buffer.from(transformed.html), {
          'Content-Security-Policy':
            `default-src 'self'; script-src 'self' ${hashes.join(' ')}; ` +
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
            "object-src 'none'; base-uri 'none'; trusted-types lit-html ui-test ui-test-template; " +
            "require-trusted-types-for 'script'",
        });
        return;
      }

      // The library's mounts resolve inside the package, wherever the package sits:
      // its own root in a standalone checkout, a submodule in a repository that
      // consumes one. Asking the package rather than assuming `<repo>/source` is what
      // lets a consuming repository run this suite at all.
      const root =
        url.pathname.startsWith('/lib/') || url.pathname.startsWith('/components/')
          ? PACKAGE
          : options.appDir;
      const file = safeFile(root, url.pathname);
      if (file === null || !(await isFile(file))) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      send(response, contentType(file), await readFile(file));
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(String(error));
    });
  });

  return listen(server);
}
