import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        const remote = report.remote;
        assert.ok(requests.includes(remote.url), `${report.name} entry was not requested`);
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

      // Split delivery, from the browser's side: every template arrives as its own
      // immutable file and no bundle is fetched (ADR-0071), and the manifest named
      // all of them so a chunk's markup starts as one batch rather than the browser
      // learning each URL from the component module that just arrived (ADR-0081).
      const shellTemplates = /** @type {{ count: number, files: string[] }} */ (shell.templates);
      const fetched = requests.filter((path) => path.startsWith('/assets/templates/'));
      assert.ok(
        requests.every((path) => !/\/assets\/templates-[0-9a-f]{16}\.json$/u.test(path)),
        'a template bundle was fetched',
      );
      assert.ok(
        fetched.every((path) => shellTemplates.files.includes(path.slice(1))),
        'a fetched template is not in the artifact report',
      );
      // Which templates the browser fetched is decided by which chunks it loaded,
      // and that is the whole of ADR-0087: startup starts the `entry` group, and
      // every other group starts on the first `attachTemplate` out of its own
      // chunk. So the set to expect is the entry group plus the group of every
      // chunk this session actually requested — a template outside it is one the
      // visitor paid for without ever loading the code that renders it, and a
      // template missing from it is a group that was dropped rather than deferred.
      const manifest = JSON.parse(
        await readFile(join(String(shell.root), String(shell.public), 'app.manifest.json'), 'utf8'),
      );
      const groups = /** @type {Record<string, string[]>} */ (manifest.templateGroups);
      const announced = Object.values(groups).flat();
      const loadedChunks = new Set(requests);
      const expected = new Set(groups.entry ?? []);
      for (const [name, urls] of Object.entries(groups)) {
        if (name === 'entry') continue;
        if (!loadedChunks.has(`/${name.slice('chunk:'.length)}`)) continue;
        for (const url of urls) expected.add(url);
      }
      // A group starts inside the module body that defines its first component, so
      // by the time the element it defines is on screen the requests are out. The
      // poll is for the request events, not for the decision. ADR-0087.
      const templatesRequested = () =>
        new Set(requests.filter((path) => path.startsWith('/assets/templates/')));
      for (let attempt = 0; attempt < 100 && templatesRequested().size < expected.size; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.deepEqual(
        [...announced].sort(),
        shellTemplates.files.map((path) => `/${path}`).sort(),
        'the manifest does not name every emitted template',
      );
      assert.deepEqual(
        [...templatesRequested()].sort(),
        [...expected].sort(),
        'the browser did not fetch exactly the templates of the chunks it loaded',
      );
      // And the narrowing is real rather than a tautology: this session opened the
      // shell and two Remotes, and the screens it never opened cost it nothing.
      assert.ok(
        expected.size < announced.length,
        `every announced template belonged to a loaded chunk (${String(announced.length)})`,
      );
      assert.ok(
        requests.every((path) => !/^\/remotes\/(?:billing|analytics)\/(?:remote-entry|.+-root)\.js$/u.test(path)),
        'built shell requested source Remote modules',
      );

      // Startup step 4 fetches the file the manifest maps its bundle URL to, never
      // the URL the pattern resolves to. That indirection is what lets a locale be
      // hash-named and served immutable rather than revalidated on every load, and
      // it is invisible above `load()`. ADR-0083.
      assert.equal(
        requests.filter((path) => path === manifest.i18n.bundleFiles['/i18n/en.json']).length,
        1,
        'the default locale was not fetched at the URL the manifest maps it to',
      );
      assert.ok(
        requests.every((path) => !/^\/i18n\//u.test(path)),
        'a locale was fetched at its declared URL, which the artifact does not serve',
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


void test('split-lazy announces nothing, so a visitor fetches only what they open', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'example-artifact-lazy-'));
  /** @type {Awaited<ReturnType<typeof startArtifactOrigin>> | undefined} */
  let origin;
  /** @type {import('puppeteer-core').Browser | undefined} */
  let browser;
  try {
    const app = (await apps()).find((candidate) => candidate.name === 'example');
    assert.ok(app !== undefined);
    const release = { commit: '0'.repeat(40), sourceDateEpoch: 0 };
    const remotes = await Promise.all(
      ['billing', 'analytics'].map((name) =>
        buildRemoteArtifact({ app, name, outDir: join(temporary, name), release }),
      ),
    );
    const shell = await buildArtifact({
      app,
      outDir: join(temporary, 'shell'),
      release,
      remotes,
      templates: 'split-lazy',
    });
    const publicDir = join(String(shell.root), String(shell.public));
    const manifest = JSON.parse(await readFile(join(publicDir, 'app.manifest.json'), 'utf8'));
    assert.deepEqual(manifest.templateFiles, [], 'split-lazy named a template');

    origin = await startArtifactOrigin({
      appDir: app.dir,
      artifactDir: publicDir,
      entry: String(shell.entry),
      csp: /** @type {{ csp: string }} */ (shell.security).csp,
      unavailable: null,
      tampered: null,
      session: { username: 'artifact-test', password: 'admin' },
      mounts: remotes.map((report) => ({
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
    page.on('pageerror', (error) => errors.push(String(error)));
    try {
      await page.goto(`${origin.url}/`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction(
        () =>
          /** @type {{ __artifactReady?: boolean }} */ (globalThis).__artifactReady === true &&
          document.querySelector('shell-layout') !== null,
        { timeout: 15_000 },
      );
      assert.deepEqual(errors, []);

      // The mode's whole purpose, and the property ADR-0071 decided: the shell
      // renders having fetched the markup it needed and none of the rest. Asserting
      // a strict subset rather than an exact count, because which templates the
      // landing route pulls in is the application's business and would make this a
      // test of `example`'s route table.
      const emitted = /** @type {{ count: number, files: string[] }} */ (
        /** @type {Record<string, unknown>} */ (shell).templates
      );
      const fetched = new Set(requests.filter((path) => path.startsWith('/assets/templates/')));
      assert.ok(fetched.size > 0, 'no template was fetched at all');
      assert.ok(
        fetched.size < emitted.count,
        `split-lazy fetched all ${String(emitted.count)} templates for one route`,
      );
      assert.ok(
        [...fetched].every((path) => emitted.files.includes(path.slice(1))),
        'a fetched template is not in the artifact report',
      );
      assert.ok(
        requests.every((path) => !/\/assets\/templates-[0-9a-f]{16}\.json$/u.test(path)),
        'a template bundle was fetched',
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
