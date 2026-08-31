import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { admitManifest } from '../../source/lib/core/remotes/manifest-policy.js';
import { serveApplication } from '../dev/serve.mjs';
import { apps } from '../layout.mjs';
import { extractImportMap } from '../package/interface.mjs';

/**
 * What a development server announces about templates.
 *
 * The rule being pinned is a parity one, and it has no other guard: a built
 * artifact's manifest carries `templateFiles` and the source manifest a developer
 * is served did not, so `startApplication`'s templates step ran in production and
 * nowhere else. Nothing failed when that was true — the application worked, one
 * round trip per component per reload — which is why it lasted, and why the
 * assertions here are about the manifest a browser receives rather than about any
 * function that helps build it.
 *
 * Each case is one way the announcement can be wrong while still looking right:
 *
 *   an empty list          the model found nothing and the step is skipped again
 *   a Remote's markup      announced on the shell, which spends the request the
 *                          Remote's guard exists to refuse
 *   a shape the runtime    admitted by `admitManifest` here, or the page throws on
 *   refuses                a manifest that passed every check this repository has
 *   a bundle overridden    an application that configured `templateBundle` by hand
 *                          gets a list beside it, and the runtime prefers the
 *                          bundle, so the list is requests nothing ever reads
 *   a failure that is      a half-typed module must cost the announcement, never
 *   fatal                  the server
 */

/**
 * The example application, served on an ephemeral port with no watching: a suite
 * has nothing to reload and a recursive watch of the repository is the slowest
 * thing this file could do.
 *
 * @param {{ name: string, dir: string }} app
 * @param {(base: string) => Promise<void>} run
 */
async function withServer(app, run) {
  const server = await serveApplication({ app, port: 0, host: '127.0.0.1', watch: false });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

/** @returns {Promise<{ name: string, dir: string }>} */
async function example() {
  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'the example application is missing');
  return app;
}

void test('the served manifest names every template the application ships', async () => {
  const app = await example();
  await withServer(app, async (base) => {
    const manifest = /** @type {Record<string, string[]>} */ (
      await (await fetch(`${base}/app.manifest.json`)).json()
    );

    const files = manifest.templateFiles ?? [];
    assert.ok(files.length > 20, `only ${String(files.length)} templates announced`);

    // Both mounts, because a list built from the application directory alone would
    // miss the shared collection and look complete.
    assert.ok(files.includes('/src/app-root.html'), files.join(' '));
    assert.ok(files.includes('/components/data/ui-table.html'), files.join(' '));

    // Sorted and unique: the runtime rejects a repeat, and a stable order is what
    // makes two runs comparable.
    assert.deepEqual(files, [...files].sort((left, right) => left.localeCompare(right)));
    assert.equal(new Set(files).size, files.length);
  });
});

void test("a Remote's markup is announced on the Remote, not on the shell", async () => {
  const app = await example();
  await withServer(app, async (base) => {
    const manifest = /** @type {{ templateFiles: string[], remotes: Array<Record<string, unknown>> }} */ (
      await (await fetch(`${base}/app.manifest.json`)).json()
    );

    // The shell must not start these. The router runs a Remote's guard before
    // `prepareRemote`, and markup the shell already fetched is the request that
    // guard exists to refuse.
    assert.deepEqual(
      manifest.templateFiles.filter((url) => url.startsWith('/remotes/')),
      [],
    );

    const billing = manifest.remotes.find((remote) => remote.name === 'billing');
    assert.deepEqual(billing?.templateFiles, ['/remotes/billing/billing-root.html']);

    // A Remote with no markup of its own says so, rather than inheriting the shell's.
    const analytics = manifest.remotes.find((remote) => remote.name === 'analytics');
    assert.deepEqual(analytics?.templateFiles, []);
  });
});

void test('the announced manifest is one the runtime admits', async () => {
  const app = await example();
  // The digests the browser would actually enforce, read from the page's own import
  // map: admission refuses a remote this document does not pin, so a test that made
  // them up would be admitting a manifest no browser would.
  const { integrity } = extractImportMap(
    await readFile(join(app.dir, 'index.html'), 'utf8'),
    'example/index.html',
  );

  await withServer(app, async (base) => {
    const manifest = await (await fetch(`${base}/app.manifest.json`)).json();

    // The same admission the browser performs on every load, over the bytes the
    // browser is actually handed. Same-origin, normalised, no duplicate.
    const admitted = admitManifest(manifest, {
      url: '/app.manifest.json',
      base: `${base}/`,
      pins: () => integrity,
    });
    assert.ok(admitted.templateFiles.length > 20);
    assert.equal(admitted.templateBundle, undefined, 'the list is announced, not a bundle');
    assert.ok(
      admitted.remotes.some((remote) => remote.templateFiles.length === 1),
      "a Remote's markup survives admission",
    );
  });
});

void test('the manifest revalidates, and every other file carries the file validator', async () => {
  const app = await example();
  await withServer(app, async (base) => {
    // Generated, so its validator is of its own bytes rather than the file's — the
    // one document on the page that would otherwise be a whole body every reload.
    const manifest = await fetch(`${base}/app.manifest.json`);
    const generated = manifest.headers.get('etag') ?? '';
    assert.match(generated, /^".+"$/u);
    assert.equal(manifest.headers.get('cache-control'), 'no-cache');
    assert.equal(
      (await fetch(`${base}/app.manifest.json`, { headers: { 'If-None-Match': generated } }))
        .status,
      304,
    );

    // And a template, which is streamed: `no-cache` is what makes the browser ask
    // at all, and asking is what turns a reload into 304s.
    const template = await fetch(`${base}/components/data/ui-table.html`);
    const etag = template.headers.get('etag') ?? '';
    assert.match(etag, /^W\/".+"$/u);
    assert.equal(template.headers.get('cache-control'), 'no-cache');
    assert.equal(
      (await fetch(`${base}/components/data/ui-table.html`, { headers: { 'If-None-Match': etag } }))
        .status,
      304,
    );
  });
});

/**
 * A directory that is an application only as far as the server needs: an entry
 * document and a manifest. Nothing here is parsed by the project model, which is
 * the point of both cases below.
 *
 * @param {Record<string, unknown>} manifest
 * @param {(app: { name: string, dir: string }) => Promise<void>} run
 */
async function withFixtureApp(manifest, run) {
  const dir = await mkdtemp(join(tmpdir(), 'srl-announce-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><body>fixture</body>\n');
    await writeFile(join(dir, 'app.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await run({ name: 'fixture', dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test('an application that configured a bundle is left alone', async () => {
  await withFixtureApp({ templateBundle: '/templates.json' }, async (app) => {
    await withServer(app, async (base) => {
      const manifest = /** @type {Record<string, unknown>} */ (
        await (await fetch(`${base}/app.manifest.json`)).json()
      );
      // The runtime seeds from the bundle and never reads a list beside it, so a
      // list beside it is requests for markup nothing will fetch from the network.
      assert.equal(manifest.templateBundle, '/templates.json');
      assert.equal(manifest.templateFiles, undefined);
    });
  });
});

void test('a project the model cannot read costs the announcement, not the server', async () => {
  // No index.html for the model to read the import map out of, which is the same
  // shape of failure as a half-typed module: the announcement declines and the file
  // on disk is served unchanged.
  const dir = await mkdtemp(join(tmpdir(), 'srl-announce-'));
  try {
    await writeFile(join(dir, 'app.manifest.json'), '{ "apiBaseUrl": "/api" }\n');
    await withServer({ name: 'fixture', dir }, async (base) => {
      const response = await fetch(`${base}/app.manifest.json`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { apiBaseUrl: '/api' });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
