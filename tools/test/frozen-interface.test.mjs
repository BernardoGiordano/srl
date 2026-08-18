import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { REPO, apps } from '../layout.mjs';
import { projectIndex, readProject } from '../project-model/index.mjs';

/**
 * The public facts a refactor may not change, pinned so that changing one is a
 * decision with a diff rather than a side effect of a file move.
 *
 * Each assertion covers a fact with no compile-time protection: the custom-element
 * tags the library and the shared collection define, the host contract version
 * every deployed remote was built against, and the fields each application's
 * `app.manifest.json` carries.
 *
 * Storage keys and the preference migrations are frozen too, but their tripwires
 * are the browser suites that own them —
 * `source/lib/test/preferences/persistence.test.js`, `theme.test.js` and `i18n.test.js`
 * assert the schema version, the per-owner key shape and the one-time adoption of
 * each legacy key against the real storage adapter. Restating them here from a Node
 * process that cannot reach `localStorage` would be a second, weaker copy.
 */

/** Every tag the shared collection defines. Permanent names: pages are written against them. */
const COLLECTION_TAGS = [
  'ui-app-shell',
  'ui-avatar',
  'ui-breadcrumb',
  'ui-combobox',
  'ui-date-range',
  // Added with the modal: the discard prompt on the customer form was rendered
  // under the form it was asking about. ADR-0029.
  'ui-dialog',
  'ui-dynamic-filter',
  // Added with `@core/forms`: a field wrapper the collection did not have, because
  // the screen that needed one had not been written yet.
  'ui-field',
  'ui-menu',
  'ui-sidebar',
  'ui-sidebar-group',
  'ui-sidebar-item',
  'ui-sidebar-toggle',
  'ui-table',
  'ui-table-column',
  'ui-topbar',
];

/** Every tag the library itself defines. `x-content` is a dialect marker, not a definition. */
const LIBRARY_TAGS = ['x-outlet', 'x-route-outlet'];

/** The host contract version remotes are written against. */
const HOST_CONTRACT = 2;

/** Top-level keys of an application manifest. `$`-prefixed keys are documentation. */
const MANIFEST_FIELDS = ['auth', 'i18n', 'remotes'];

/** Keys a manifest entry for one remote may carry. Transport assets are optional in source delivery. */
const REMOTE_FIELDS = [
  'assets',
  'grants',
  'integrity',
  'locales',
  'mount',
  'name',
  'requires',
  'shared',
  'templates',
  'url',
];

/**
 * The tags one application's model declares from library or shared-collection source,
 * with test source excluded: a suite defines a dozen elements that exist for one file.
 *
 * @param {import('../project-model/types.d.ts').ProjectIndex} index
 * @returns {string[]}
 */
function frameworkTags(index) {
  return index.elements
    .filter((element) => /^source\/(lib|components)\//.test(element.module))
    .filter((element) => !element.module.includes('/test/'))
    .map((element) => element.tag)
    .sort();
}

void test('the library and the shared collection define exactly the frozen tags', async () => {
  const expected = [...COLLECTION_TAGS, ...LIBRARY_TAGS].sort();

  for (const app of await apps()) {
    const index = projectIndex(await readProject(app));
    assert.deepEqual(
      frameworkTags(index),
      expected,
      `${app.name} defines a different set of framework tags`,
    );
  }
});

void test('every frozen tag still resolves to a module and a template decision', async () => {
  const [first] = await apps();
  assert.ok(first !== undefined, 'the repository has at least one application');
  const index = projectIndex(await readProject(first));

  for (const tag of COLLECTION_TAGS) {
    const element = index.elements.find((candidate) => candidate.tag === tag);
    assert.ok(element !== undefined, `${tag} is no longer defined anywhere`);
    assert.ok(element.className !== '', `${tag} lost its exported class`);
    // `template` is a path or null; null means `template: false`, which is a
    // decision. Undefined would mean the model could not tell, which is not.
    assert.notEqual(element.template, undefined, `${tag} has an unreadable template decision`);
  }
});

void test('the host contract version is what every shipped remote was written against', async () => {
  const source = await readFile(join(REPO, 'source/lib/core/remotes/mfe.js'), 'utf8');
  const declared = /^export const HOST_CONTRACT = (\d+);$/m.exec(source);
  assert.ok(declared !== null, 'mfe.js no longer declares HOST_CONTRACT as a literal');
  assert.equal(
    Number(declared[1]),
    HOST_CONTRACT,
    'the host contract version moved: every deployed remote must be rebuilt against it',
  );

  const remotesDir = join(REPO, 'example/remotes');
  const remotes = (await readdir(remotesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(remotes.length > 0, 'example ships no remote to check the contract against');

  for (const remote of remotes) {
    const entry = await readFile(join(remotesDir, remote, 'remote-entry.js'), 'utf8');
    const version = /^export const contract = (\d+);$/m.exec(entry);
    assert.ok(version !== null, `remote ${remote} declares no contract version`);
    assert.equal(Number(version[1]), HOST_CONTRACT, `remote ${remote} is on a different contract`);
    assert.match(entry, /^export const rootTag = /m, `remote ${remote} exports no rootTag`);
    assert.match(entry, /^export (async )?function mount\(/m, `remote ${remote} exports no mount`);
  }
});

void test('application manifests carry the frozen fields and nothing unread', async () => {
  for (const app of await apps()) {
    const raw = await readFile(join(app.dir, 'app.manifest.json'), 'utf8');
    const manifest = /** @type {Record<string, unknown>} */ (JSON.parse(raw));

    const fields = Object.keys(manifest)
      .filter((key) => !key.startsWith('$'))
      .sort();
    assert.deepEqual(fields, MANIFEST_FIELDS, `${app.name}'s manifest carries different fields`);

    const remotes = /** @type {Record<string, unknown>[]} */ (manifest.remotes);
    assert.ok(Array.isArray(remotes), `${app.name}'s remotes is not a list`);
    for (const remote of remotes) {
      const keys = Object.keys(remote).filter((key) => !key.startsWith('$'));
      for (const key of keys) {
        assert.ok(
          REMOTE_FIELDS.includes(key),
          `${app.name} declares remote field "${key}", which the loader does not read`,
        );
      }
      for (const required of ['name', 'mount', 'url', 'integrity']) {
        assert.ok(keys.includes(required), `${app.name} has a remote with no ${required}`);
      }
    }
  }
});
