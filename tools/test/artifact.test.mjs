import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildArtifact, buildRemoteArtifact, composeArtifact } from '../delivery/build.mjs';
import { prepareRemoteRelease } from '../delivery/remote-release.mjs';
import { REPO, apps, walk } from '../layout.mjs';

const RELEASE = {
  commit: '0000000000000000000000000000000000000000',
  sourceDateEpoch: 0,
};

/** @returns {Promise<{ name: string, dir: string }>} */
async function example() {
  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'example is the application with runtime Remotes');
  return app;
}

/** @param {Readonly<Record<string, unknown>>} report */
function filesOf(report) {
  return /** @type {ReadonlyArray<{ path: string, cache: string, bytes: number, gzip: number, brotli: number, sha256: string }>} */ (
    report.files
  );
}

void test('example composes independently verified Remote artifacts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'example-independent-remotes-'));
  try {
    const app = await example();
    const [billing, analytics] = await Promise.all([
      buildRemoteArtifact({
        app,
        name: 'billing',
        outDir: join(temporary, 'billing'),
        release: RELEASE,
      }),
      buildRemoteArtifact({
        app,
        name: 'analytics',
        outDir: join(temporary, 'analytics'),
        release: RELEASE,
      }),
    ]);
    assert.equal(billing.kind, 'remote');
    assert.equal(analytics.kind, 'remote');
    assert.notEqual(billing.root, analytics.root);
    const billingTransport = /** @type {{ name: string, url: string, integrity: string, assets: Array<{ type: string, url: string, integrity: string }>, shared: string[], locales: string[], templates: string }} */ (
      billing.remote
    );
    const analyticsTransport = /** @type {{ name: string, url: string, assets: Array<{ type: string, url: string, integrity: string }>, shared: string[], locales: string[] }} */ (
      analytics.remote
    );
    assert.equal(billingTransport.name, 'billing');
    assert.equal(analyticsTransport.name, 'analytics');
    assert.match(billingTransport.url, /^\/remotes\/billing\/0+\/assets\/remote-entry-[A-Za-z0-9_-]{8}\.js$/u);
    assert.match(analyticsTransport.url, /^\/remotes\/analytics\/0+\/assets\/remote-entry-[A-Za-z0-9_-]{8}\.js$/u);
    assert.ok(billingTransport.assets.some((asset) => asset.type === 'style'));
    assert.ok(billingTransport.assets.some((asset) => asset.type === 'template'));
    assert.ok(analyticsTransport.assets.some((asset) => asset.type === 'style'));
    assert.deepEqual(analyticsTransport.shared, []);
    assert.ok(billingTransport.shared.includes('@core/foundation/reactive.js'));
    assert.match(billingTransport.templates, /\/assets\/templates-[0-9a-f]{16}\.json$/u);
    assert.deepEqual(billingTransport.locales, [
      '/remotes/billing/0000000000000000000000000000000000000000/i18n/{locale}.json',
    ]);

    const billingCode = await readFile(
      join(String(billing.root), 'public', String(billing.entry)),
      'utf8',
    );
    assert.match(billingCode, /from"@core\/|from"@components\//u);
    assert.doesNotMatch(billingCode, /source\/lib|source\/components/u);
    const billingChunks = /** @type {Array<{ modules: string[] }>} */ (billing.chunks);
    assert.ok(
      billingChunks.flatMap((chunk) => chunk.modules).every(
        (module) => module.startsWith('example/remotes/billing/') || module.startsWith('\0'),
      ),
      'Billing artifact bundled shell-owned modules',
    );

    const shell = await buildArtifact({
      app,
      outDir: join(temporary, 'shell'),
      release: RELEASE,
      remotes: [billing, analytics],
    });
    const composed = /** @type {Array<{ name: string, url: string, mount: string, assets: Array<{ type: string, url: string, integrity: string }> }>} */ (
      shell.remotes
    );
    assert.deepEqual(composed.map((remote) => remote.name), ['billing', 'analytics']);
    assert.equal(composed[0]?.url, billingTransport.url);
    assert.equal(composed[0]?.mount, '/billing');
    assert.equal(composed[1]?.url, analyticsTransport.url);

    const shellChunks = /** @type {Array<{ modules: string[] }>} */ (shell.chunks);
    assert.ok(
      shellChunks
        .flatMap((chunk) => chunk.modules)
        .every((module) => !module.startsWith('example/remotes/')),
      'shell artifact bundled a Remote implementation',
    );
    const shared = /** @type {Record<string, string>} */ (shell.shared);
    assert.deepEqual(Object.keys(shared), [...billingTransport.shared].sort());
    assert.ok(Object.values(shared).every((url) => /^\/assets\/shared\//u.test(url)));

    const publicRoot = join(String(shell.root), 'public');
    const manifest = JSON.parse(await readFile(join(publicRoot, 'app.manifest.json'), 'utf8'));
    assert.deepEqual(manifest.remotes, composed);
    const html = await readFile(join(publicRoot, 'index.html'), 'utf8');
    const importMapSource = /<script type="importmap">([^<]+)<\/script>/u.exec(html)?.[1];
    assert.ok(importMapSource !== undefined);
    const importMap = JSON.parse(importMapSource);
    assert.deepEqual(importMap.imports, shared);
    for (const transport of [billingTransport, analyticsTransport]) {
      for (const asset of transport.assets.filter((candidate) => candidate.type === 'module')) {
        assert.equal(importMap.integrity[asset.url], asset.integrity);
      }
    }

    /**
     * @param {Readonly<Record<string, unknown>>} report
     * @param {string} label
     */
    const retain = async (report, label) => {
      const prepared = join(temporary, `prepared-${label}`);
      const publication = await prepareRemoteRelease({
        artifactRoot: String(report.root),
        outDir: prepared,
        allowExperimental: true,
      });
      const root = join(prepared, 'release');
      const release = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
      );
      return { ...release, root, publication };
    };
    const [billingRelease, analyticsRelease] = await Promise.all([
      retain(billing, 'billing'),
      retain(analytics, 'analytics'),
    ]);
    const newerBilling = await buildRemoteArtifact({
      app,
      name: 'billing',
      outDir: join(temporary, 'billing-new'),
      base: `/remotes/billing/${'1'.repeat(40)}/`,
      release: { commit: '1'.repeat(40), sourceDateEpoch: 1 },
    });
    const newerBillingRelease = await retain(newerBilling, 'billing-new');
    const recomposed = await composeArtifact({
      app,
      artifactRoot: String(shell.root),
      outDir: join(temporary, 'shell-new-billing'),
      remotes: [newerBillingRelease, analyticsRelease],
    });
    const recomposedRemotes = /** @type {Array<{ name: string, url: string }>} */ (
      recomposed.remotes
    );
    assert.match(
      recomposedRemotes.find((remote) => remote.name === 'billing')?.url ?? '',
      new RegExp(`/remotes/billing/${'1'.repeat(40)}/`, 'u'),
    );
    assert.equal(
      recomposedRemotes.find((remote) => remote.name === 'analytics')?.url,
      analyticsTransport.url,
    );
    const mutableCompositionPaths = new Set(['public/app.manifest.json', 'public/index.html']);
    /** @param {Readonly<Record<string, unknown>>} report */
    const implementationFiles = (report) =>
      filesOf(report).filter((file) => !mutableCompositionPaths.has(file.path));
    assert.deepEqual(
      implementationFiles(recomposed),
      implementationFiles(shell),
      'Remote-only composition changed shell implementation bytes',
    );
    const recomposedHtml = await readFile(
      join(String(recomposed.root), 'public', 'index.html'),
      'utf8',
    );
    const recomposedImportMapSource = /<script type="importmap">([^<]+)<\/script>/u.exec(
      recomposedHtml,
    )?.[1];
    const recomposedSecurity = /** @type {{ importMap: { source: string, sha256: string }, csp: string }} */ (
      recomposed.security
    );
    assert.equal(recomposedImportMapSource, recomposedSecurity.importMap.source);
    assert.ok(recomposedSecurity.csp.includes(`'${recomposedSecurity.importMap.sha256}'`));

    const rolledBack = await composeArtifact({
      app,
      artifactRoot: String(recomposed.root),
      outDir: join(temporary, 'shell-rolled-back'),
      remotes: [billingRelease, analyticsRelease],
    });
    assert.deepEqual(
      filesOf(rolledBack),
      filesOf(shell),
      'Remote-only rollback did not restore original shell payload bytes',
    );

    const tamperedRelease = /** @type {{ files: Array<{ target: string, path: string }> }} */ (
      /** @type {unknown} */ (newerBillingRelease)
    );
    const tamperedModule = tamperedRelease.files.find(
      (file) => file.target === 'release' && file.path.endsWith('.js'),
    );
    assert.ok(tamperedModule !== undefined);
    await rm(join(String(newerBillingRelease.root), tamperedModule.path));
    await assert.rejects(
      composeArtifact({
        app,
        artifactRoot: String(shell.root),
        outDir: join(temporary, 'shell-tampered'),
        remotes: [newerBillingRelease, analyticsRelease],
      }),
      /ENOENT|hash mismatch/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('example shell refuses an incomplete Remote composition', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'example-missing-remote-'));
  try {
    await assert.rejects(
      buildArtifact({ app: await example(), outDir: join(temporary, 'output'), release: RELEASE }),
      /artifact:example:remotes: missing independent artifact for remote billing/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('failed build leaves previous verified output untouched', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-atomic-'));
  const output = join(temporary, 'current');

  try {
    // The application has runtime Remotes, so a shell build needs their reports first;
    // what this test is about starts at the second build.
    const app = await example();
    const remotes = await Promise.all(
      ['billing', 'analytics'].map((name) =>
        buildRemoteArtifact({ app, name, outDir: join(temporary, name), release: RELEASE }),
      ),
    );
    await buildArtifact({ app, outDir: output, release: RELEASE, remotes });
    const before = await readFile(join(output, 'artifact.json'), 'utf8');
    const broken = {
      name: 'artifact-broken',
      dir: join(REPO, 'tools/test/fixtures/artifact-broken'),
    };

    await assert.rejects(
      buildArtifact({ app: broken, outDir: output, release: RELEASE }),
      /artifact:artifact-broken:/u,
    );
    assert.equal(await readFile(join(output, 'artifact.json'), 'utf8'), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('output cleanup cannot target repository source', async () => {
  await assert.rejects(
    buildArtifact({ app: await example(), outDir: join(REPO, 'example'), release: RELEASE }),
    /inside repository source/u,
  );
});

void test('dynamic component definition fails before an incomplete template artifact exists', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-dynamic-'));
  try {
    await assert.rejects(
      buildArtifact({
        app: {
          name: 'artifact-dynamic',
          dir: join(REPO, 'tools/test/fixtures/artifact-dynamic'),
        },
        outDir: join(temporary, 'output'),
        release: RELEASE,
      }),
      /something other than an object literal/u,
    );
    assert.equal((await walk(temporary, /./u)).length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
