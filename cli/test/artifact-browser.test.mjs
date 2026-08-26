import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildArtifact, buildRemoteArtifact } from '../delivery/build.mjs';
import { apps } from '../layout.mjs';
import { launchChrome, startArtifactOrigin } from './support/artifact-origin.mjs';

void test('built example mounts independent Billing and Analytics artifacts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'example-artifact-browser-'));
  /** @type {Awaited<ReturnType<typeof startArtifactOrigin>> | undefined} */
  let origin;
  /** @type {import('puppeteer-core').Browser | undefined} */
  let browser;
  try {
    const app = (await apps()).find((candidate) => candidate.name === 'example');
    assert.ok(app !== undefined);
    const release = {
      commit: '0000000000000000000000000000000000000000',
      sourceDateEpoch: 0,
    };
    const [billing, analytics] = await Promise.all([
      buildRemoteArtifact({
        app,
        name: 'billing',
        outDir: join(temporary, 'billing'),
        release,
      }),
      buildRemoteArtifact({
        app,
        name: 'analytics',
        outDir: join(temporary, 'analytics'),
        release,
      }),
    ]);
    const shell = await buildArtifact({
      app,
      outDir: join(temporary, 'shell'),
      release,
      remotes: [billing, analytics],
    });
    const security = /** @type {{ csp: string }} */ (shell.security);
    origin = await startArtifactOrigin({
      appDir: app.dir,
      artifactDir: join(String(shell.root), String(shell.public)),
      entry: String(shell.entry),
      csp: security.csp,
      unavailable: null,
      tampered: null,
      // The example's fixture backend takes any username; the password picks the role.
      session: { username: 'artifact-test', password: 'admin' },
      mounts: [billing, analytics].map((report) => ({
        base: String(report.base),
        dir: join(String(report.root), String(report.public)),
      })),
    });
    browser = await launchChrome(origin.url);
    const page = await browser.newPage();
    /** @type {string[]} */
    const requests = [];
    /** @type {string[]} */
    const errors = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('requestfailed', (request) => {
      errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? 'failed'}`);
    });
    try {
      await page.goto(`${origin.url}/`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction(
        () =>
          /** @type {{ __artifactReady?: boolean }} */ (globalThis).__artifactReady === true &&
          document.querySelector('shell-layout') !== null,
        { timeout: 15_000 },
      );
      await page.evaluate(() => {
        history.pushState(null, '', '/billing');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      try {
        await page.waitForSelector('billing-root', { timeout: 15_000 });
      } catch (cause) {
        const state = await page.evaluate(() => ({
          path: location.pathname,
          text: document.body.textContent?.replace(/\s+/gu, ' ').trim().slice(0, 300) ?? '',
        }));
        throw new Error(
          `Billing artifact did not mount; path=${state.path}, errors=${errors.join(' | ')}, ` +
            `requests=${requests.slice(-30).join(', ')}, body=${state.text}`,
          { cause },
        );
      }
      assert.equal(
        await page.evaluate(async () => {
          const importMap = JSON.parse(
            document.querySelector('script[type="importmap"]')?.textContent ?? '{}',
          );
          const signalElementUrl = importMap.imports?.['@core/elements/signal-element.js'];
          const { SignalElement } = await import(signalElementUrl);
          return document.querySelector('billing-root') instanceof SignalElement;
        }),
        true,
        'Billing did not receive shell shared-module identity',
      );
      assert.match(
        await page.$eval('billing-root', (element) => element.textContent ?? ''),
        /Billing|Fatturazione/u,
      );

      await page.evaluate(() => {
        history.pushState(null, '', '/analytics');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForSelector('analytics-root', { timeout: 15_000 });
      assert.match(
        await page.$eval('analytics-root', (element) => element.textContent ?? ''),
        /Analytics|Analisi/u,
      );
      assert.deepEqual(errors, []);

      for (const report of [billing, analytics]) {
        const remote = /** @type {{ url: string, locales: string[], templates?: string, assets: Array<{ type: string, url: string }> }} */ (
          report.remote
        );
        assert.ok(requests.includes(remote.url), `${String(report.name)} entry was not requested`);
        assert.ok(
          remote.assets
            .filter((asset) => asset.type === 'style')
            .every((asset) => requests.includes(asset.url)),
          `${String(report.name)} stylesheet was not requested`,
        );
        assert.ok(
          remote.locales.every((pattern) => requests.includes(pattern.replace('{locale}', 'en'))),
          `${String(report.name)} locale was not requested`,
        );
        if (remote.templates !== undefined) assert.ok(requests.includes(remote.templates));
      }

      // Split delivery, from the browser's side: templates arrive as their own
      // immutable files, no bundle is fetched, and the pages the visitor never
      // opened cost nothing. ADR-0071.
      const shellTemplates = /** @type {{ count: number, files: string[] }} */ (shell.templates);
      const fetched = requests.filter((path) => path.startsWith('/assets/templates/'));
      assert.ok(fetched.length > 0, 'no template was fetched');
      assert.ok(
        requests.every((path) => !/\/assets\/templates-[0-9a-f]{16}\.json$/u.test(path)),
        'a template bundle was fetched',
      );
      assert.ok(
        new Set(fetched).size < shellTemplates.count,
        `every one of the ${String(shellTemplates.count)} templates was fetched for three routes`,
      );
      assert.ok(
        fetched.every((path) => shellTemplates.files.includes(path.slice(1))),
        'a fetched template is not in the artifact report',
      );
      assert.ok(
        requests.every((path) => !/^\/remotes\/(?:billing|analytics)\/(?:remote-entry|.+-root)\.js$/u.test(path)),
        'built shell requested source Remote modules',
      );
    } finally {
      await page.close();
    }
  } finally {
    await browser?.close();
    await origin?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

