import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { REPO, apps } from '../layout.mjs';
import {
  describeElement,
  missingTemplates,
  orphanTemplates,
  projectErrors,
  projectIndex,
  readProject,
  shippedTemplates,
} from '../project-model/index.mjs';
import { clearParseCache, parseModule } from '../project-model/parse.mjs';

/**
 * The project model's invariants, over a fixture project rather than this repository.
 *
 * Every case here is one the three tools that used to answer these questions separately
 * could get wrong: a definition whose template is declared rather than a sibling, a `uses`
 * entry naming a class nothing defines, two modules claiming one tag, markup left behind
 * by a rename, a computed tag no static tool can read. The fixture project states each of
 * them once, so a change to discovery has one place to be verified against.
 *
 * The fixtures are deliberately not compiled or linted — see the exclusions in
 * tsconfig.json and eslint.config.js. A declaration that no static tool can read cannot
 * also be a file that satisfies every static tool.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/project-model', import.meta.url));
const APP_A = { name: 'app-a', dir: join(FIXTURES, 'app-a') };
const APP_B = { name: 'app-b', dir: join(FIXTURES, 'app-b') };

/** @param {{ name: string, dir: string }} app */
function fixtureProject(app) {
  return readProject(app, { roots: [app.dir] });
}

void test('a template is the module sibling, a declared path, or nothing', async () => {
  const model = await fixtureProject(APP_A);

  const sibling = model.elements.get('fx-child');
  assert.equal(sibling?.template, join(APP_A.dir, 'src', 'child.html'));
  assert.equal(sibling?.templateDeclared, false);
  assert.equal(sibling?.templateExists, true);

  const explicit = model.elements.get('fx-explicit');
  assert.equal(explicit?.template, join(APP_A.dir, 'src', 'markup', 'explicit-view.html'));
  assert.equal(explicit?.templateDeclared, true);
  assert.equal(explicit?.templateExists, true);

  const headless = model.elements.get('fx-headless');
  assert.equal(headless?.template, null, '`template: false` renders in JavaScript');
  assert.equal(headless?.templateExists, null);
});

void test('a definition naming a template that does not exist is reported', async () => {
  const model = await fixtureProject(APP_A);
  const missing = missingTemplates(model).map((record) => record.tag);
  assert.deepEqual(missing, ['fx-gone']);
});

void test('markup no definition claims is an orphan, and a fixture template is not', async () => {
  const model = await fixtureProject(APP_A);
  const orphans = orphanTemplates(model).map((template) => template.path);

  // headless.html sits beside a module that declares `template: false`: the leftover of a
  // rename, which is exactly the invisible case.
  assert.deepEqual(orphans, [join(APP_A.dir, 'src', 'headless.html')]);

  // A suite's own fixture markup is claimed by nothing either, but it is not beside a
  // module the application ships, so it is not an orphan — and it never ships.
  const shipped = shippedTemplates(model).map((template) => template.url);
  assert.ok(!shipped.includes('/src/test/fixture-element.html'), shipped.join(' '));
  assert.ok(shipped.includes('/src/child.html'));
});

void test('`uses` resolves through the import that brought the class in', async () => {
  const model = await fixtureProject(APP_A);

  const host = model.elements.get('fx-host');
  assert.deepEqual(
    host?.uses.map((use) => [use.className, use.tag]),
    [['Child', 'fx-child']],
  );
  assert.deepEqual(host?.usesTags, ['fx-child', 'fx-host'], 'its own tag is always available');

  // The same module reached by a longer route is the same module. A model that compared
  // specifier text instead of resolved paths would report this one unresolved.
  const spelled = model.elements.get('fx-spelled');
  assert.deepEqual(
    spelled?.uses.map((use) => use.tag),
    ['fx-child'],
  );
});

void test('a `uses` entry naming a class nothing defines fails verification', async () => {
  const model = await fixtureProject(APP_A);
  const unresolved = projectErrors(model).filter(
    (diagnostic) => diagnostic.kind === 'unresolved-uses',
  );

  assert.equal(unresolved.length, 1);
  assert.match(String(unresolved[0]?.message), /fx-unmet.*NotAnElement/u);
  assert.equal(model.elements.get('fx-unmet')?.uses[0]?.tag, null);
});

void test('two modules claiming one tag is an error, and the first one wins', async () => {
  const model = await fixtureProject(APP_A);
  const duplicates = projectErrors(model).filter(
    (diagnostic) => diagnostic.kind === 'duplicate-tag',
  );

  assert.equal(duplicates.length, 1);
  assert.match(String(duplicates[0]?.message), /fx-duplicate/u);
  assert.equal(model.elements.get('fx-duplicate')?.className, 'First');
});

void test('a declaration static analysis cannot read is an error, not a silent skip', async () => {
  const model = await fixtureProject(APP_A);
  const dynamic = model.diagnostics.filter((diagnostic) => diagnostic.kind === 'dynamic');

  const errors = dynamic.filter((diagnostic) => diagnostic.severity === 'error');
  assert.equal(errors.length, 2, dynamic.map((one) => one.message).join('\n'));
  assert.match(errors.map((one) => one.message).join('\n'), /computed `tag`/u);
  assert.match(
    errors.map((one) => one.message).join('\n'),
    /something other than an object literal/u,
  );

  // The bare registration is the mechanism, not a declaration: a note, and no tag.
  const notes = dynamic.filter((diagnostic) => diagnostic.severity === 'note');
  assert.ok(notes.length >= 1);
  assert.equal(model.elements.get('fx-computed'), undefined);

  // Test source declares invalid things on purpose. That may never fail a build — and the
  // check that decides it is relative to the project root, because this fixture project
  // itself lives under a directory called `test`.
  const fromTests = model.diagnostics.filter((diagnostic) =>
    diagnostic.file.includes(join('src', 'test')),
  );
  assert.ok(fromTests.length > 0);
  assert.ok(fromTests.every((diagnostic) => diagnostic.severity === 'note'));
});

void test('two applications get two models, from their own import maps', async () => {
  const a = await fixtureProject(APP_A);
  const b = await fixtureProject(APP_B);

  assert.deepEqual(Object.keys(a.prefixes).sort(), ['@app/', '@components/', '@core/']);
  assert.deepEqual(Object.keys(b.prefixes).sort(), ['@app/', '@core/']);
  assert.equal(a.prefixes['@app/'], join(APP_A.dir, 'src'));
  assert.equal(b.prefixes['@app/'], join(APP_B.dir, 'source'));

  assert.equal(a.entry, join(APP_A.dir, 'src', 'host.js'));
  assert.equal(b.entry, join(APP_B.dir, 'source', 'start.js'));
  assert.ok(!b.elements.has('fx-host'), "app-b does not contain app-a's elements");
});

void test('public reactive properties and template globals come from the declarations', async () => {
  const model = await fixtureProject(APP_A);

  assert.deepEqual(model.elements.get('fx-child')?.properties, ['label', 'rows']);
  assert.deepEqual(model.elements.get('fx-host')?.properties, []);

  assert.deepEqual(
    [...model.globals.entries()].map(([name, global]) => [name, global.exportName]),
    [
      ['formatDate', 'formatDate'],
      ['currency', 'money'],
    ],
  );
});

void test('what an element observes is read from either declaration, or reported unknown', async () => {
  const model = await fixtureProject(APP_A);

  // Lit's rule, three ways: the default attribute is the property name lowercased, an
  // explicit `attribute` replaces it, and `attribute: false` or `state: true` means the
  // property cannot be reached from markup at all.
  assert.deepEqual(model.elements.get('fx-surface')?.observedAttributes, [
    'data-collapsed',
    'empty-label',
    'label',
  ]);
  assert.deepEqual(model.elements.get('fx-child')?.observedAttributes, ['label']);

  // `static observedAttributes` names attributes directly, and an element may use it
  // instead: `<ui-table-column>` does.
  assert.deepEqual(model.elements.get('fx-metadata')?.observedAttributes, ['key', 'sort-key']);

  // Nothing declared is an empty set. An options object nothing can read is null, and the
  // difference decides whether a tool may call an attribute in markup dead.
  assert.deepEqual(model.elements.get('fx-headless')?.observedAttributes, []);
  assert.equal(model.elements.get('fx-opaque')?.observedAttributes, null);

  assert.match(describeElement(model, 'fx-surface'), /attributes data-collapsed, empty-label, label/u);
  assert.match(describeElement(model, 'fx-opaque'), /attributes unknown/u);
});

void test('the JSON projection is stable, relative and free of absolute paths', async () => {
  const model = await fixtureProject(APP_A);
  const first = JSON.stringify(projectIndex(model));
  const second = JSON.stringify(projectIndex(await fixtureProject(APP_A)));

  assert.equal(first, second, 'two reads of one project must produce identical bytes');
  assert.ok(!first.includes(REPO), 'no absolute path may reach the projection');

  const index = projectIndex(model);
  assert.deepEqual(
    index.elements.map((element) => element.tag),
    [...index.elements.map((element) => element.tag)].sort(),
    'elements are sorted by tag',
  );
  assert.equal(index.root, 'tools/test/fixtures/project-model/app-a');
  const child = index.elements.find((element) => element.tag === 'fx-child');
  assert.equal(child?.module, 'tools/test/fixtures/project-model/app-a/src/child.js');
});

void test('describing one element answers what a caller has to know', async () => {
  const model = await fixtureProject(APP_A);
  const description = describeElement(model, 'fx-child');

  assert.match(description, /<fx-child>\s+Child/u);
  assert.match(description, /src\/child\.js/u);
  assert.match(description, /src\/child\.html/u);
  assert.match(description, /properties label, rows/u);
  assert.match(description, /used by\s+<fx-host> <fx-spelled>/u);
  assert.match(describeElement(model, 'fx-gone'), /MISSING/u);
  assert.match(describeElement(model, 'no-such-element'), /No element <no-such-element>/u);
});

void test('a module is parsed once until it changes on disk', async () => {
  clearParseCache();
  const file = join(APP_A.dir, 'src', 'child.js');
  const first = await parseModule(file, {});
  const second = await parseModule(file, {});
  assert.equal(first, second, 'the same parse is returned, not an equal one');

  // The key includes the prefixes, because `@app/` resolves to a different directory per
  // application and an import target is part of what was parsed.
  const other = await parseModule(file, { '@app/': join(APP_B.dir, 'source') });
  assert.notEqual(first, other);
  assert.deepEqual(other.definitions, first.definitions);
});

void test('this repository has no unreadable declaration and no orphan template', async () => {
  // The model over the real applications, which is what the verifier fails on. Here so
  // that a definition written in a way static discovery cannot read is caught by the tool
  // suite too, and not only by `npm run verify`.
  for (const app of await apps()) {
    const model = await readProject(app);
    assert.deepEqual(
      projectErrors(model).map((diagnostic) => diagnostic.message),
      [],
      `${app.name} has unreadable declarations`,
    );
    assert.deepEqual(orphanTemplates(model).map((template) => template.path), []);
    assert.deepEqual(missingTemplates(model).map((record) => record.tag), []);
    assert.ok(model.elements.size > 20, `${app.name} discovered ${String(model.elements.size)}`);
    assert.ok(model.entry !== null);
  }
});
