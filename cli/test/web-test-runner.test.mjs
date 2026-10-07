import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { startTestRunner } from '@web/test-runner';
import { parse } from 'parse5';
import { chromium } from 'playwright';

import { REPO, repoPath } from '../layout.mjs';
import { extractImportMap } from '../package/interface.mjs';
import { testRunnerConfig } from '../testing/web-test-runner.mjs';

/**
 * The preset's first middleware. The runner binds every interface and serves the
 * repository root, so this is what keeps `.git/` and a rebinding page out. ADR-0131.
 */

/**
 * What the first middleware does with one request, as the status it set or `next`.
 *
 * @param {{ peer?: string, host?: string, path?: string }} request
 * @returns {Promise<number | 'next'>}
 */
async function admit({ peer = '127.0.0.1', host = 'localhost:8000', path = '/example/src/main.js' }) {
  const [first] = testRunnerConfig({ app: 'example' }).middleware ?? [];
  assert.ok(first !== undefined);
  const ctx = {
    req: { socket: { remoteAddress: peer } },
    path,
    url: path,
    URL: new URL(path, `http://${host || 'localhost'}`),
    response: { is: () => false },
    status: 0,
    get: (/** @type {string} */ name) => (name === 'host' ? host : ''),
  };
  let passed = false;
  await first(/** @type {never} */ (ctx), () => {
    passed = true;
    return Promise.resolve();
  });
  return passed ? 'next' : ctx.status;
}

void test('the runner answers a loopback peer addressing a loopback name', async () => {
  assert.equal(await admit({}), 'next');
  assert.equal(await admit({ peer: '::1', host: '127.0.0.1:8000' }), 'next');
  assert.equal(await admit({ peer: '::ffff:127.0.0.1' }), 'next');
});

void test('a peer on the network and a rebound hostname are refused', async () => {
  assert.equal(await admit({ peer: '192.168.1.20' }), 403);
  assert.equal(await admit({ peer: '::ffff:10.0.0.2' }), 403);
  assert.equal(await admit({ host: 'rebound.example:8000' }), 403);
  assert.equal(await admit({ host: '' }), 403);
});

void test('a dotfile is a 404, however it is spelled', async () => {
  for (const path of ['/.git/config', '/.env', '/%2egit/HEAD', '/example/.env', '/%E0%A4%A']) {
    assert.equal(await admit({ path }), 404, path);
  }
  assert.equal(await admit({ path: '/.well-known/security.txt' }), 'next');
});

void test('test selectors fail closed before the runner registers its tests', async () => {
  assert.equal(await admit({ path: '/?wtr-test-file=/example/test/app.test.js' }), 403);
  assert.equal(await admit({ path: '/?wtr-session-id=unknown' }), 403);
});

void test('the shipped preset admits only registered debug tests and protects the final document', async (t) => {
  const app = await mkdtemp(join(REPO, '.srl-runner-test-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const map = extractImportMap(await readFile(join(REPO, 'example/index.html'), 'utf8'), 'example/index.html');
  const marker = 'marker</script><script>';
  map.imports[marker] = '/source/lib/test/foundation/paths.test.js';
  await writeFile(join(app, 'index.html'), `<script type="importmap">${JSON.stringify(map).replace(/</gu, '\\u003c')}</script>`);
  const preset = testRunnerConfig({ app: repoPath(app) });
  let origin = '';
  const runner = await startTestRunner({
    readCliArgs: false,
    readFileConfig: false,
    autoExitProcess: false,
    config: {
      ...preset,
      files: ['source/lib/test/foundation/paths.test.js'],
      port: 0,
      manual: true,
      plugins: [{
        name: 'test-address',
        serverStart({ server }) {
          const address = server?.address();
          assert.ok(address && typeof address !== 'string');
          origin = `http://localhost:${address.port}`;
        },
      }],
    },
  });
  assert.ok(runner !== undefined && !runner.stopped);
  t.after(() => runner.stop());
  const path = '/source/lib/test/foundation/paths.test.js';
  const debugUrl = (/** @type {string} */ selected) => `${origin}/?wtr-test-file=${encodeURIComponent(selected)}`;

  for (const selected of [
    'https://example.invalid/test.js', '//example.invalid/test.js',
    'data:text/javascript,0', '/example/src/main.js',
    '/source/lib/test/template/template.test.js',
    '', `${path}?extra=true`, `${path}#fragment`,
    `${path}"`, `${path}</script>`, `${path}&quot;`,
    path.replace('/foundation/', '/foundation/../foundation/'),
    path.replace('/foundation/', '/%66oundation/'),
    path.replace('/foundation/', '/foundation%2f'),
    `${path}%22`, `${path}%5c`, `${path}%0a`, `${path}%`,
  ]) {
    const response = await fetch(debugUrl(selected));
    assert.equal(response.status, 403, selected);
    assert.doesNotMatch(await response.text(), /__WTR_CONFIG__/u);
  }
  for (const query of [
    `wtr-test-file=${path}&wtr-test-file=${path}`,
    `wtr-test-file=${path}&wtr-session-id=unknown`,
    'wtr-session-id=unknown',
  ]) assert.equal((await fetch(`${origin}/?${query}`)).status, 403, query);

  const list = await fetch(`${origin}/`);
  assert.equal(list.status, 200);
  const menu = await list.text();
  assert.ok(menu.includes(encodeURIComponent(`${path}?wtr-manual-session=true`)));

  for (const selected of [path, `${path}?wtr-manual-session=true`]) {
    const response = await fetch(debugUrl(selected));
    assert.equal(response.status, 200);
    const html = await response.text();
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /script-src 'self' 'sha256-/u);
    assert.match(policy, /require-trusted-types-for 'script'/u);
    assert.doesNotMatch(policy, /'unsafe-inline'|'unsafe-eval'|https:|data:|blob:/u);
    assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/u);
    assert.ok(!html.includes(marker));
    /** @type {string[]} */
    const scripts = [];
    /** @param {import('parse5').Node} node */
    const visit = (node) => {
      if ('tagName' in node && node.tagName === 'script' && !node.attrs.some(({ name }) => name === 'src')) {
        const body = node.childNodes.map((child) => 'value' in child ? child.value : '').join('');
        scripts.push(body);
        if (node.attrs.some(({ name, value }) => name === 'type' && value === 'importmap')) {
          assert.equal(JSON.parse(body).imports[marker], map.imports[marker]);
        }
        assert.ok(policy.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`));
      }
      if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    };
    visit(parse(html));
    const config = scripts.find((body) => body.startsWith('window.__WTR_CONFIG__ = '));
    assert.ok(config !== undefined);
    assert.equal(JSON.parse(config.slice('window.__WTR_CONFIG__ = '.length)).testFile, selected);
  }

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(debugUrl(`${path}?wtr-manual-session=true`));
  await page.waitForFunction(() => {
    const runner = /** @type {Window & { __WTR_MOCHA_RUNNER__?: { stats?: { end?: unknown } } }} */ (window);
    return !!runner.__WTR_MOCHA_RUNNER__?.stats?.end;
  });
  const stats = await page.evaluate(() => {
    const runner = /** @type {Window & { __WTR_MOCHA_RUNNER__?: { stats?: { passes: number, failures: number } } }} */ (window);
    return runner.__WTR_MOCHA_RUNNER__?.stats;
  });
  assert.ok(stats !== undefined && stats.passes > 0);
  assert.equal(stats.failures, 0);
  assert.deepEqual(errors, []);

  /** @type {string[]} */
  const remoteRequests = [];
  await page.route('https://example.invalid/**', (route) => {
    remoteRequests.push(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: 'export default 1;' });
  });
  assert.equal(await page.evaluate(async (url) => {
    try { await import(url); return 'loaded'; }
    catch { return 'blocked'; }
  }, 'https://example.invalid/probe.js'), 'blocked');
  assert.deepEqual(remoteRequests, []);
});
