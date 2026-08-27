import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildArtifact, buildRemoteArtifact, composeArtifact } from '../delivery/build.mjs';
import { minifyTemplate } from '../delivery/template-html.mjs';
import { prepareRemoteRelease } from '../delivery/remote-release.mjs';
import { REPO, apps, walk } from '../layout.mjs';

/** @import { ArtifactFile, RemoteArtifactReport } from '../delivery/artifact-report.mjs' */
/** @import { RemoteReleaseReport } from '../delivery/remote-release.mjs' */

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

/** @param {{ files: ArtifactFile[] }} report @returns {ReadonlyArray<ArtifactFile>} */
function filesOf(report) {
  return report.files;
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
    const billingTransport = billing.remote;
    const analyticsTransport = analytics.remote;
    assert.equal(billingTransport.name, 'billing');
    assert.equal(analyticsTransport.name, 'analytics');
    assert.match(billingTransport.url, /^\/remotes\/billing\/0+\/assets\/remote-entry-[A-Za-z0-9_-]{8}\.js$/u);
    assert.match(analyticsTransport.url, /^\/remotes\/analytics\/0+\/assets\/remote-entry-[A-Za-z0-9_-]{8}\.js$/u);
    assert.ok(billingTransport.assets.some((asset) => asset.type === 'style'));
    // Split delivery is the default, so a Remote's templates are files its own
    // components fetch and there is nothing for the shell to preload. ADR-0071.
    assert.ok(!billingTransport.assets.some((asset) => asset.type === 'template'));
    assert.ok(analyticsTransport.assets.some((asset) => asset.type === 'style'));
    assert.deepEqual(analyticsTransport.shared, []);
    assert.ok(billingTransport.shared.includes('@core/foundation/reactive.js'));
    assert.equal(billingTransport.templates, undefined);
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
    const composed = shell.remotes;
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
     * @param {RemoteArtifactReport} report
     * @param {string} label
     * @returns {Promise<RemoteReleaseReport & { root: string }>}
     */
    const retain = async (report, label) => {
      const prepared = join(temporary, `prepared-${label}`);
      await prepareRemoteRelease({
        artifactRoot: report.root,
        outDir: prepared,
        allowExperimental: true,
      });
      const root = join(prepared, 'release');
      const release = /** @type {RemoteReleaseReport} */ (
        /** @type {unknown} */ (JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
      );
      return { ...release, root };
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
    assert.match(
      recomposed.remotes.find((remote) => remote.name === 'billing')?.url ?? '',
      new RegExp(`/remotes/billing/${'1'.repeat(40)}/`, 'u'),
    );
    assert.equal(
      recomposed.remotes.find((remote) => remote.name === 'analytics')?.url,
      analyticsTransport.url,
    );
    const mutableCompositionPaths = new Set(['public/app.manifest.json', 'public/index.html']);
    /** @param {{ files: ArtifactFile[] }} report */
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
    await rm(join(newerBillingRelease.root, tamperedModule.path));
    await assert.rejects(
      composeArtifact({
        app,
        artifactRoot: shell.root,
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
      dir: join(REPO, 'cli/test/fixtures/artifact-broken'),
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
          dir: join(REPO, 'cli/test/fixtures/artifact-dynamic'),
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

void test('a template is one immutable file, and a bundle only when asked for', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-templates-'));
  try {
    const app = await example();
    const [split, bundled] = await Promise.all([
      buildRemoteArtifact({
        app,
        name: 'billing',
        outDir: join(temporary, 'split'),
        release: RELEASE,
      }),
      buildRemoteArtifact({
        app,
        name: 'billing',
        outDir: join(temporary, 'bundled'),
        release: RELEASE,
        templates: 'bundle',
      }),
    ]);

    /** @param {Readonly<Record<string, unknown>>} report */
    const templatesOf = (report) =>
      /** @type {{ delivery: string, bundle: string | null, url: string | null, count: number, files: string[] }} */ (
        report.templates
      );
    const splitTemplates = templatesOf(split);
    const bundledTemplates = templatesOf(bundled);

    assert.equal(splitTemplates.delivery, 'split');
    assert.equal(splitTemplates.bundle, null);
    assert.equal(splitTemplates.url, null);
    assert.ok(splitTemplates.count > 0);
    assert.deepEqual(splitTemplates.files, bundledTemplates.files);
    assert.ok(
      filesOf(split).every((file) => !/templates-[0-9a-f]{16}\.json$/u.test(file.path)),
      'split delivery emitted a bundle',
    );

    // Every template is a file of its own either way, hash-named after the bytes
    // served and so cacheable forever.
    for (const path of splitTemplates.files) {
      const file = filesOf(split).find((candidate) => candidate.path === `public/${path}`);
      assert.ok(file !== undefined, `${path} is not in the payload`);
      assert.equal(file.cache, 'immutable');
    }

    assert.equal(bundledTemplates.delivery, 'bundle');
    assert.match(String(bundledTemplates.bundle), /^assets\/templates-[0-9a-f]{16}\.json$/u);
    const bundle = JSON.parse(
      await readFile(join(String(bundled.root), 'public', String(bundledTemplates.bundle)), 'utf8'),
    );
    assert.equal(Object.keys(bundle).length, bundledTemplates.count);
    for (const [url, markup] of Object.entries(bundle)) {
      const path = url.slice(String(bundled.base).length);
      assert.equal(
        await readFile(join(String(bundled.root), 'public', path), 'utf8'),
        markup,
        `${url} disagrees with the file it keys`,
      );
    }

    // The bytes are minified, and the proof is that minifying them again changes
    // nothing: authored markup, with its indentation, is never its own output.
    for (const path of splitTemplates.files) {
      const markup = await readFile(join(String(split.root), 'public', path), 'utf8');
      assert.equal(minifyTemplate(markup), markup, `${path} was served unminified`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
