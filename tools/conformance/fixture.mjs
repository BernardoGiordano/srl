/**
 * The projects an installed editor is driven against. ADR-0097.
 *
 * Four roots, because what an editor does with a project is decided by what the project
 * is: two installed ones (a window may hold more than a single server), one that asks for
 * srl and has not installed it, one that never asked. The installed pair is built from
 * the tarballs this repository would publish, installed from the same declared dependency
 * set as the packaged-install probe and scaffolded by the published `srl new`, so the
 * fixture is the toolchain's own idea of an application rather than a second one written
 * here. ADR-0098.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applicationManifest, install, srl } from '../fixtures/installed-layout.mjs';

/** @import { Fixture } from './types.js' */

/** The application directory inside each installed root. */
export const APP = 'app';

/**
 * A Lit component, for the one thing an srl adapter must not do: answer inside somebody
 * else's template dialect. ADR-0090.
 */
const WIDGET = `import { LitElement, html } from 'lit';

export class Widget extends LitElement {
  render() {
    return html\`<div class="card">\${this.id}</div>\`;
  }
}
`;

/** A minimal document, so a silent root still has something to open. */
const PAGE = '<!doctype html>\n<html lang="en">\n  <body></body>\n</html>\n';

/**
 * Build the four roots. The caller owns the returned directory and removes it.
 *
 * @returns {Promise<Fixture>}
 */
export async function build() {
  const root = await mkdtemp(join(tmpdir(), 'srl-conf-'));
  const one = join(root, 'one');
  const two = join(root, 'two');
  const declared = join(root, 'declared');
  const plain = join(root, 'plain');

  await mkdir(one, { recursive: true });
  await writeFile(join(one, 'package.json'), applicationManifest('conformance-one'));
  await install(one);

  const scaffold = await srl(one, ['new', APP]);
  if (scaffold.code !== 0) throw new Error(`\`srl new ${APP}\` failed:\n${scaffold.output}`);
  await useDetailFromMain(one);
  await writeFile(join(one, APP, 'src', 'widget.js'), WIDGET);

  // The second project is a byte-for-byte install copy with its own manifest name. Both
  // editor sessions therefore start from real package directories, never checkout links.
  await cp(one, two, { recursive: true });
  await writeFile(join(two, 'package.json'), applicationManifest('conformance-two'));

  for (const [directory, name, dependencies] of /** @type {Array<[string, string, Record<string, string>]>} */ ([
    [declared, 'conformance-declared', { '@srljs/cli': '0.0.0' }],
    [plain, 'conformance-plain', { lit: '3.3.3' }],
  ])) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), manifest(name, dependencies));
    await writeFile(join(directory, 'index.html'), PAGE);
  }

  return { root, roots: { one, two, declared, plain } };
}

/**
 * Make the main template use the other component, which is what gives the run a tag to
 * rename in two files rather than one.
 *
 * @param {string} root
 * @returns {Promise<void>}
 */
async function useDetailFromMain(root) {
  const template = join(root, APP, 'src', 'main.html');
  await writeFile(template, `${(await readFile(template, 'utf8')).trimEnd()}\n<app-detail></app-detail>\n`);

  const module = join(root, APP, 'src', 'main.js');
  const source = await readFile(module, 'utf8');
  await writeFile(
    module,
    source
      .replace(
        "import { signal } from '@core/foundation/reactive.js';",
        "import { signal } from '@core/foundation/reactive.js';\n\nimport { AppDetail } from './detail.js';",
      )
      .replace('  module: import.meta.url,\n});', '  module: import.meta.url,\n  uses: [AppDetail],\n});'),
  );
}

/** @param {string} name @param {Record<string, string>} dependencies */
function manifest(name, dependencies) {
  return `${JSON.stringify({ name, private: true, type: 'module', version: '0.0.0', devDependencies: dependencies }, null, 2)}\n`;
}

/** @param {Fixture} fixture @returns {Promise<void>} */
export async function remove(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}
