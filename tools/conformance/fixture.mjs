/**
 * The projects an installed editor is driven against. ADR-0097.
 *
 * Four roots, because what an editor does with a project is decided by what the project
 * is: two installed ones (a window may hold more than a single server), one that asks for
 * srl and has not installed it, one that never asked. The installed pair is built from
 * the tarballs this repository would publish, scaffolded by the published `srl new` and
 * `srl generate component`, and installed from the manifest the scaffold wrote, as the
 * packaged-install probe does. The fixture is the toolchain's own idea of an application
 * rather than a second one written here. ADR-0098, ADR-0122.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { install, launch, pack, srl, useComponent } from '../fixtures/installed-layout.mjs';

/** @import { Fixture } from './types.js' */

/** The application directory inside each installed root, as `srl new` names it. */
export const APP = 'web';

/** The component the home page uses, which gives the rename scenario a tag in two files. */
export const COMPONENT = 'user-card';

/**
 * A Lit component, for the one thing an srl adapter must not do, which is answer inside
 * somebody else's template dialect. ADR-0090.
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

  const tarballs = await pack(join(root, 'tarballs'));
  const launcher = join(root, 'launcher');
  await launch(launcher, tarballs);

  const scaffold = await srl(root, ['new', 'one'], { prefix: launcher });
  if (scaffold.code !== 0) throw new Error(`\`srl new one\` failed:\n${scaffold.output}`);
  await install(one, tarballs);

  const generated = await srl(one, ['generate', 'component', COMPONENT]);
  if (generated.code !== 0) {
    throw new Error(`\`srl generate component ${COMPONENT}\` failed:\n${generated.output}`);
  }
  await useComponent(one, APP, COMPONENT);
  await writeFile(join(one, APP, 'src', 'widget.js'), WIDGET);

  // The second project is a byte-for-byte install copy with its own manifest name. Both
  // editor sessions therefore start from real package directories, never checkout links.
  await cp(one, two, { recursive: true });
  const copied = join(two, 'package.json');
  await writeFile(copied, renamed(await readFile(copied, 'utf8'), 'two'));

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
 * @param {string} source a package manifest
 * @param {string} name
 * @returns {string}
 */
function renamed(source, name) {
  return `${JSON.stringify({ ...JSON.parse(source), name }, null, 2)}\n`;
}

/** @param {string} name @param {Record<string, string>} dependencies */
function manifest(name, dependencies) {
  return `${JSON.stringify({ name, private: true, type: 'module', version: '0.0.0', devDependencies: dependencies }, null, 2)}\n`;
}

/** @param {Fixture} fixture @returns {Promise<void>} */
export async function remove(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}
