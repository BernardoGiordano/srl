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

      // Split delivery, from the browser's side. Every template arrives as its own
      // immutable file and no bundle is fetched, and the manifest names all of them
      // so a chunk's markup starts as one batch rather than the browser learning
      // each URL from the component module that just arrived. ADR-0081.
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
      // which is the whole of ADR-0081. Startup starts the `entry` group, and every
      // other group starts on the first `attachTemplate` out of its own chunk. The
      // set to expect is therefore the entry group plus the group of every chunk
      // this session actually requested. A template outside it is one the visitor
      // paid for without ever loading the code that renders it, and a template
      // missing from it is a group that was dropped rather than deferred.
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
      // poll is for the request events, not for the decision. ADR-0081.
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
      // The narrowing is real rather than a tautology. This session opened the
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

      // The mode's purpose, and the property ADR-0081 decided. The shell renders
      // having fetched the markup it needed and none of the rest. A strict subset
      // rather than an exact count, because which templates the landing route pulls
      // in is the application's business and would make this a test of `example`'s
      // route table.
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


void test('an activation retires the shell’s own old cache and leaves the origin’s others alone', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'example-artifact-worker-'));
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
    });
    const publicDir = join(String(shell.root), String(shell.public));

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
    try {
      await page.goto(`${origin.url}/`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction(
        () => /** @type {{ __artifactReady?: boolean }} */ (globalThis).__artifactReady === true,
        { timeout: 15_000 },
      );

      // The name the emitted worker will claim, read from the file the build wrote.
      // `previous` is the same application one release ago, with the same prefix and
      // a digest of a precache list this build does not carry.
      const current = /const CACHE = "([^"]+)"/u.exec(await readFile(join(publicDir, 'sw.js'), 'utf8'))?.[1];
      assert.ok(current !== undefined, 'the emitted worker names its cache');
      const previous = `${current.slice(0, current.lastIndexOf(':') + 1)}0123456789abcdef`;
      assert.notEqual(previous, current);

      // What else an origin holds. Another Application deployed here, a Remote that
      // caches its own bytes, and a cache the page opened itself. None of them was
      // written by this artifact, so none is this worker's to delete.
      const foreign = ['srl:another-app:0123456789abcdef', 'remote-billing:v1', 'user-owned-cache'];
      await page.evaluate(async (names) => {
        for (const name of names) {
          const cache = await caches.open(name);
          await cache.put('/__seeded', new Response(name));
        }
      }, [previous, ...foreign]);

      // `register()` is a Trusted Types sink and the artifact ships
      // `require-trusted-types-for 'script'`, so the registration a page makes is the
      // registration `registerServiceWorker()` makes, through the `srl-worker`
      // policy the build's CSP names. The library's own call is bundled into a chunk
      // and unreachable by URL from here, so the policy is opened in the page. What
      // this asserts is that the emitted CSP permits it, which is what silently
      // stops a registration when the name is missing.
      assert.match(
        /** @type {{ csp: string }} */ (shell.security).csp,
        /trusted-types [^;]*\bsrl-worker\b/u,
      );

      // No worker controls this origin yet, so this registration installs and
      // activates without waiting for a predecessor to be released. Waiting on
      // `activated` rather than on `ready` is what makes the assertion about
      // deletion: the state moves only once the activate handler's work settles.
      await page.evaluate(() => {
        const factory = /** @type {{ trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): unknown } } }} */ (
          /** @type {unknown} */ (globalThis)
        ).trustedTypes;
        const url = factory?.createPolicy('srl-worker', { createScriptURL: (value) => value }).createScriptURL('/sw.js') ?? '/sw.js';
        return navigator.serviceWorker.register(/** @type {string} */ (url));
      });
      await page.waitForFunction(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated',
        { timeout: 30_000 },
      );

      const surviving = await page.evaluate(() => caches.keys());
      assert.ok(surviving.includes(current), 'the worker deleted the cache it just installed');
      assert.ok(!surviving.includes(previous), 'the previous release was left behind');
      assert.deepEqual(
        foreign.filter((name) => !surviving.includes(name)),
        [],
        'the activation deleted caches this artifact never wrote',
      );

      // The bytes are the claim rather than the surviving names. A cache the worker
      // kept but emptied would pass every assertion above.
      const intact = await page.evaluate(
        async (names) =>
          Promise.all(
            names.map(async (name) => {
              const response = await (await caches.open(name)).match('/__seeded');
              return response === undefined ? null : await response.text();
            }),
          ),
        foreign,
      );
      assert.deepEqual(intact, foreign);

      // The install half of the same lifecycle. The offline shell is in the cache
      // the activation kept.
      const precached = await page.evaluate(
        async (name) => (await (await caches.open(name)).match('/index.html')) !== undefined,
        current,
      );
      assert.ok(precached, 'the current cache holds no document, so the install did not run');
    } finally {
      await page.close();
    }
  } finally {
    await browser?.close();
    await origin?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
