/**
 * The Custom Elements Manifest the core package ships for the elements it defines.
 *
 *   node tools/delivery/package-elements.mjs            write source/custom-elements.json
 *   node tools/delivery/package-elements.mjs --check    fail if it is absent or stale
 *
 * Storybook, IDE plugins and documentation tools find it through the `customElements`
 * field of the package's package.json. It is written from the project model by
 * `cli/project-model/custom-elements.mjs`, so it says what the template checker and the
 * language server already know. Build output, like `dist/`, so it is not committed.
 * ADR-0127.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { apps } from '../../cli/layout.mjs';
import { MANIFEST, PACKAGE } from '../../cli/package/interface.mjs';
import { customElementsManifest } from '../../cli/project-model/custom-elements.mjs';
import { readProject } from '../../cli/project-model/index.mjs';

/** Where the manifest lands, named by the package's `customElements` field. */
export const ELEMENTS_FILE = join(PACKAGE, String(MANIFEST.customElements ?? 'custom-elements.json'));

/**
 * The manifest's bytes. Any application's model sees the library, because every model
 * reads the library's modules, and a suite's fixture elements are left out.
 *
 * @returns {Promise<string>}
 */
export async function elementsManifestText() {
  const [app] = await apps();
  if (app === undefined) throw new Error('No application to read the library through.');
  const model = await readProject(app);
  const manifest = customElementsManifest(model, {
    base: PACKAGE,
    include: (record) =>
      record.module.startsWith(PACKAGE + sep) && !relative(PACKAGE, record.module).split(sep).includes('test'),
  });
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await elementsManifestText();
  const name = relative(join(PACKAGE, '..'), ELEMENTS_FILE);
  const declarations = (/** @type {{ modules: Array<{ declarations: unknown[] }> }} */ (JSON.parse(text))).modules
    .reduce((total, module) => total + module.declarations.length, 0);

  if (process.argv.includes('--check')) {
    const current = await readFile(ELEMENTS_FILE, 'utf8').catch(() => null);
    if (current === text) {
      console.log(`  ok   ${name.padEnd(28)} ${String(declarations).padStart(4)} element(s) current`);
    } else {
      console.error(`Stale: ${name}. Run \`npm run package\`.`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(ELEMENTS_FILE, text);
    console.log(`  ok   ${name.padEnd(28)} ${String(declarations).padStart(4)} element(s)`);
  }
}
