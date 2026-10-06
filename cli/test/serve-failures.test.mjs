import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { serveApplication } from '../dev/serve.mjs';
import { IMPORT_MAP_FILE } from '../package/interface.mjs';

/**
 * A page that fails in a browser reaches the terminal that served it. ADR-0125.
 *
 * One real page in Chromium, because the part worth asserting is the browser's: a
 * rejected top-level await in the entry module has to be caught by the queue the head
 * script installs, posted by the client, and printed by the server with its code.
 */

void test('a startup failure in the page is printed by srl serve and shown in the page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-failures-'));
  const app = join(root, 'web');
  await mkdir(join(app, 'src'), { recursive: true });
  await writeFile(
    join(app, 'index.html'),
    `<!doctype html>\n<html>\n  <head>\n    <script type="importmap">\n${await readFile(IMPORT_MAP_FILE, 'utf8')}    </script>\n` +
      `    <script type="module" src="/src/main.js"></script>\n  </head>\n  <body></body>\n</html>\n`,
  );
  // No app.manifest.json, so the manifest step fails.
  await writeFile(
    join(app, 'src', 'main.js'),
    "import { startApplication } from '@srljs/core';\n\nawait startApplication({ root: { load: () => Promise.resolve(HTMLElement) } });\n",
  );

  /** @type {string[]} */
  const lines = [];
  const server = await serveApplication({
    app: { name: 'web', dir: app },
    port: 0,
    host: '127.0.0.1',
    watch: true,
    log: (format, ...values) => lines.push(values.length === 0 ? format : String(values[0])),
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/`);
    await page.waitForFunction(() => document.getElementById('srl-dev-overlay') !== null);

    const overlay = await page.evaluate(
      () => document.getElementById('srl-dev-overlay')?.shadowRoot?.textContent ?? '',
    );
    assert.match(overlay, /runtime\/startup/);
    assert.match(overlay, /step "manifest"/);

    const deadline = Date.now() + 5000;
    while (!lines.some((line) => line.includes('runtime/startup')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const printed = lines.find((line) => line.includes('runtime/startup'));
    assert.ok(printed !== undefined, lines.join('\n'));
    assert.match(printed, /^ {2}FAIL runtime\/startup {2}.*Application startup failed at step "manifest"/);
  } finally {
    await browser.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
