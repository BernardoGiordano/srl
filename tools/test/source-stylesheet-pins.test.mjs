import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { chromium, webkit } from 'playwright';

import { REPO } from '../../cli/layout.mjs';
import { send, serveOrigin } from '../../cli/origin/index.mjs';
import { MOUNTS, PROBE_CSP, importMapFragment } from '../../cli/package/interface.mjs';

const execute = promisify(execFile);
const ENTRY = '/remotes/styled/remote-entry.js';
const CSS = '/remotes/styled/remote-entry.css';
const RULES = ':host { display: block } .title { color: rgb(0, 128, 0) }';
const MARKUP = '<p class="title">Pinned stylesheet</p>';
const MODULE = `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
export class StyledRemote extends SignalElement {}
await defineComponent({ tag: 'styled-remote', element: StyledRemote, module: import.meta.url, styles: true });
export const rootTag = 'styled-remote';
export const contract = 2;
export function mount() { return document.createElement(rootTag); }
`;

/** @param {string} source */
const digest = (source) => `sha384-${createHash('sha384').update(source).digest('base64')}`;

/** @param {string} module */
const manifest = (module) => ({
  remotes: [{
    name: 'styled', url: ENTRY, integrity: digest(module), mount: '/styled',
    shared: ['@core/elements/component.js', '@core/elements/signal-element.js'],
    templateFiles: ['/remotes/styled/remote-entry.html'],
  }],
  i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: [] },
  auth: { apiBaseUrl: '/api' },
});

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  void test(`${name} checks source Element CSS before defining and mounting a remote`, async (t) => {
    const fragment = await importMapFragment();
    const map = { ...fragment, integrity: {
      ...fragment.integrity,
      [ENTRY]: digest(MODULE),
      [CSS]: digest(RULES),
      '/remotes/styled/remote-entry.html': digest(MARKUP),
    } };
    let stylesheet = RULES;
    const origin = await serveOrigin({
      mounts: MOUNTS,
      route: (_request, response, url) => {
        if (url.pathname === '/') {
          const text = JSON.stringify(map);
          const hash = createHash('sha256').update(text).digest('base64');
          response.setHeader('Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'sha256-${hash}' ${PROBE_CSP}; object-src 'none'; base-uri 'none'`);
          send(response, { type: 'text/html', body: Buffer.from(`<script type="importmap">${text}</script>`) });
          return true;
        }
        /** @type {Record<string, { type: string, body: string }>} */
        const files = {
          [ENTRY]: { type: 'text/javascript', body: MODULE },
          [CSS]: { type: 'text/css', body: stylesheet },
          '/remotes/styled/remote-entry.html': { type: 'text/html', body: MARKUP },
          '/app.manifest.json': { type: 'application/json', body: JSON.stringify(manifest(MODULE)) },
        };
        const file = files[url.pathname];
        if (file === undefined) return false;
        send(response, { type: file.type, body: Buffer.from(file.body) });
        return true;
      },
    });
    t.after(origin.close);
    const browser = await engine.launch();
    t.after(() => browser.close());

    for (const changed of [false, true]) {
      await t.test(changed ? 'changed CSS refuses the remote without adopting rules or defining its tag' :
        'matching CSS allows the remote definition, mount, and scoped styles', async () => {
        stylesheet = changed ? RULES.replace('0, 128, 0', '0, 0, 255') : RULES;
        const page = await browser.newPage();
        try {
          await page.goto(origin.url);
          const result = await page.evaluate(async () => {
            const remoteUrl = '/lib/core/remotes/mfe.js';
            const injectUrl = '/lib/core/foundation/inject.js';
            const { REMOTE_HOST, loadManifest, remoteRoutes, useManifest } =
              /** @type {typeof import('../../source/lib/core/remotes/mfe.js')} */ (await import(remoteUrl));
            const { provide } = /** @type {typeof import('../../source/lib/core/foundation/inject.js')} */ (await import(injectUrl));
            provide(REMOTE_HOST, () => ({
              guard: () => undefined,
              connect: (remote) => ({
                context: /** @type {import('../../source/lib/core/remotes/types.js').HostContext} */ ({
                  contract: 2, name: remote.name, mount: remote.mount,
                }),
                revoke: () => undefined,
              }),
            }));
            useManifest(await loadManifest());
            const route = remoteRoutes()[0];
            if (route?.mount === undefined) throw new Error('No styled remote route.');
            const before = document.adoptedStyleSheets.length;
            try {
              const element = await route.mount();
              document.body.append(element);
              await /** @type {import('../../source/lib/core/elements/signal-element.js').SignalElement} */ (element).updateComplete;
              const title = element.querySelector('.title');
              if (title === null) throw new Error('Remote template did not render.');
              return {
                error: '', defined: customElements.get('styled-remote') !== undefined,
                sheets: document.adoptedStyleSheets.length - before,
                color: getComputedStyle(title).color,
                owner: title.getAttribute('data-ui-owner'),
              };
            } catch (cause) {
              return {
                error: cause instanceof Error ? cause.name : String(cause),
                defined: customElements.get('styled-remote') !== undefined,
                sheets: document.adoptedStyleSheets.length - before,
                color: '', owner: null,
              };
            }
          });
          assert.deepEqual(result, changed ? {
            error: 'TypeError', defined: false, sheets: 0, color: '', owner: null,
          } : {
            error: '', defined: true, sheets: 1, color: 'rgb(0, 128, 0)', owner: 'styled-remote',
          });
        } finally {
          await page.close();
        }
      });
    }
  });
}

void test('remote verification inventories Element CSS from the import graph and sibling modules', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'srl-source-stylesheet-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE']) {
    await copyFile(join(REPO, file), join(root, file));
  }
  for (const dir of ['cli', 'source', 'node_modules']) {
    await symlink(join(REPO, dir), join(root, dir), 'dir');
  }
  const app = join(root, 'app');
  const module = `import '../../extra/child.js';\n${MODULE}`;
  /** @param {string} tag @param {string} name */
  const styled = (tag, name) => `import { defineComponent } from '@core/elements/component.js';
export class ${name} extends HTMLElement {}
await defineComponent({ tag: '${tag}', element: ${name}, module: import.meta.url, styles: true });
`;
  const files = {
    [ENTRY]: module, [CSS]: RULES, '/remotes/styled/remote-entry.html': MARKUP,
    '/extra/child.js': styled('styled-child', 'StyledChild'),
    '/extra/child.css': RULES, '/extra/child.html': MARKUP,
    '/remotes/styled/deferred.mjs': styled('styled-deferred', 'StyledDeferred'),
    '/remotes/styled/deferred.css': RULES, '/remotes/styled/deferred.html': MARKUP,
    '/src/local.js': styled('styled-local', 'StyledLocal'),
    '/src/local.css': RULES, '/src/local.html': MARKUP,
  };
  for (const [url, body] of Object.entries(files)) {
    const file = join(app, url);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  await writeFile(join(app, 'app.manifest.json'), JSON.stringify(manifest(module)));
  const fragment = await importMapFragment();
  const integrity = Object.fromEntries(Object.entries(files)
    .filter(([url]) => !url.startsWith('/src/')).map(([url, body]) => [url, digest(body)]));
  const verifier = new URL('../checks/verify-deps.mjs', import.meta.url).href;

  /**
   * @param {Record<string, string>} pins
   * @returns {Promise<import('../../cli/diagnostics/types.js').Diagnostic[]>}
   */
  async function verify(pins) {
    const map = { ...fragment, integrity: { ...fragment.integrity, ...pins } };
    await writeFile(join(app, 'index.html'), `<script type="importmap">${JSON.stringify(map)}</script>`);
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      `import { verifyDependencies } from ${JSON.stringify(verifier)}; console.log(JSON.stringify(await verifyDependencies()));`],
    { env: { ...process.env, SRL_ROOT: root }, maxBuffer: 4 * 1024 * 1024 });
    /** @type {unknown} */
    const parsed = JSON.parse(stdout);
    return /** @type {import('../../cli/diagnostics/types.js').Diagnostic[]} */ (parsed);
  }

  await t.test('matching pins cover remote CSS while local shell CSS stays unpinned', async () => {
    const found = await verify(integrity);

    // `source/` is the checkout's own, so whether its `dist/` exists depends on whether
    // `npm run package` ran first. `npm run check` runs this suite before it does.

    const refused = found.filter((finding) =>
      finding.severity === 'error' && finding.code !== 'deps/exports-unbuilt');
    assert.deepEqual(refused.map((finding) => `${finding.code} ${finding.message}`), []);
    assert.match(found.find((finding) => finding.code === 'deps/remote-pinned')?.message ?? '', /3 stylesheet\(s\)/u);
  });

  for (const url of [CSS, '/extra/child.css', '/remotes/styled/deferred.css']) {
    await t.test(`missing pin refuses ${url}`, async () => {
      const pins = { ...integrity };
      delete pins[url];
      const found = await verify(pins);
      const refused = found.filter((finding) => finding.code === 'deps/remote-artifact-unpinned');
      assert.equal(refused.length, 1);
      assert.match(refused[0]?.message ?? '', /stylesheet/u);
      assert.ok(refused[0]?.message.includes(url));
    });
    await t.test(`mismatched pin refuses ${url}`, async () => {
      const found = await verify({ ...integrity, [url]: digest('changed CSS') });
      const refused = found.filter((finding) => finding.code === 'deps/remote-artifact-hash');
      assert.equal(refused.length, 1);
      assert.match(refused[0]?.message ?? '', /stylesheet/u);
      assert.ok(refused[0]?.message.includes(url));
    });
  }

  await t.test('missing CSS reports the existing stylesheet diagnostic without aborting verification', async () => {
    await rm(join(app, CSS));
    const found = await verify(integrity);
    assert.ok(found.some((finding) => finding.code === 'deps/missing-stylesheet'));
  });
});
