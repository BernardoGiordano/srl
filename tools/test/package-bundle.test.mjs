/**
 * The published bundles, checked against the bytes that would be uploaded.
 *
 * Every assertion here is about the emitted file rather than the configuration
 * that produced it. The failure this guards is one the repository's other suites
 * cannot see: they run the library from source through an import map, which is
 * exactly the resolution a registry consumer does not have, so a bundle could
 * resolve nothing and every other test would still pass.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { BUNDLES, MANIFEST, PACKAGE, SPECIFIER_DIRS } from '../package/interface.mjs';
import { BUNDLE_FILES, DIST, buildPackageBundles } from '../delivery/package-bundle.mjs';

// Built once for the whole file. The build is the expensive part and every
// assertion below reads the same output, so building per test would be four
// minutes of rebuilding bytes nothing changed.
await buildPackageBundles();

/** @type {Map<string, string>} */
const emitted = new Map();
for (const file of BUNDLE_FILES) emitted.set(file, await readFile(join(PACKAGE, file), 'utf8'));

/**
 * Every module specifier a file actually imports, parsed rather than matched: the
 * unminified bundle keeps the JSDoc it was built from, and `@import { X } from
 * '@core/…'` in a comment is documentation, not an import.
 *
 * @param {string} name
 * @param {string} text
 * @returns {string[]}
 */
function specifiersOf(name, text) {
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {Set<string>} */
  const found = new Set();

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...found];
}

/**
 * The two halves of the template contract, read out of the emitted file: the paths
 * `defineComponent` will resolve, and the paths the seeding registers.
 *
 * `isStringLiteralLike` rather than `isStringLiteral` on purpose — the minifier
 * rewrites quoted strings as untagged template literals, and a check that only knew
 * about quotes would pass the readable file and silently skip the minified one.
 *
 * @param {string} name
 * @param {string} text
 * @returns {{ declared: string[], seeded: string[] }}
 */
function templateKeys(name, text) {
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */
  const declared = [];
  /** @type {string[]} */
  const seeded = [];

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === 'template' &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      declared.push(node.initializer.text);
    }
    // `new URL('…', import.meta.url)`, whatever the minifier did to the second
    // argument: what matters is the literal the key is built from.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.endsWith('.html')
    ) {
      seeded.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { declared, seeded };
}

/** @param {string} file */
function textOf(file) {
  const text = emitted.get(file);
  assert.ok(text !== undefined, `${file} was not emitted`);
  return text;
}

void test('every bundle the manifest declares is emitted, readable and minified', () => {
  assert.deepEqual(BUNDLE_FILES.slice().sort(), [
    'dist/srl-components.js',
    'dist/srl-components.min.js',
    'dist/srl-core.js',
    'dist/srl-core.min.js',
  ]);
  for (const file of BUNDLE_FILES) {
    assert.ok(join(PACKAGE, file).startsWith(DIST), `${file} escapes the generated directory`);
    assert.ok(textOf(file).length > 1000, `${file} is empty or tiny`);
  }
});

void test('a bundle imports nothing the consumer has not installed', () => {
  const vendored = Object.keys(/** @type {Record<string, string>} */ (MANIFEST.srl.vendor));
  const declared = Object.keys(/** @type {Record<string, string>} */ (MANIFEST.dependencies ?? {}));

  for (const file of BUNDLE_FILES) {
    for (const specifier of specifiersOf(file, textOf(file))) {
      if (specifier.startsWith('./')) continue;
      assert.ok(
        vendored.includes(specifier),
        `${file} imports ${specifier}, which is not a vendored runtime dependency`,
      );
      // `lit/directives/repeat.js` is a subpath of the `lit` package: the install
      // that satisfies it is the one named in `dependencies`.
      const owner = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
      assert.ok(
        declared.includes(owner),
        `${file} imports ${specifier} but ${owner} is not in the package's dependencies`,
      );
    }
  }
});

void test('no bundle still names a prefix only an import map resolves', () => {
  for (const file of BUNDLE_FILES) {
    for (const specifier of specifiersOf(file, textOf(file))) {
      for (const prefix of Object.keys(SPECIFIER_DIRS)) {
        assert.ok(
          !specifier.startsWith(prefix),
          `${file} still imports ${specifier}; a registry consumer has no import map`,
        );
      }
    }
  }
});

void test('a bundle imports the one it extends, and minified imports minified', () => {
  const extending = BUNDLES.filter((bundle) => bundle.extends !== undefined);
  assert.ok(extending.length > 0, 'expected at least one bundle built on another');

  for (const bundle of extending) {
    assert.deepEqual(
      specifiersOf(bundle.file, textOf(bundle.file)).filter((one) => one.startsWith('./')),
      [`./${String(bundle.extends)}.js`],
    );
    assert.deepEqual(
      specifiersOf(bundle.minified, textOf(bundle.minified)).filter((one) => one.startsWith('./')),
      [`./${String(bundle.extends)}.min.js`],
      'the minified bundle must import the minified framework, not a second unminified copy',
    );
  }
});

void test('every declared template is seeded, in the minified file as well', () => {
  let inlined = 0;

  for (const bundle of BUNDLES) {
    for (const file of [bundle.file, bundle.minified]) {
      const { declared, seeded } = templateKeys(file, textOf(file));
      if (declared.length === 0) continue;
      inlined += 1;

      assert.equal(
        new Set(declared).size,
        declared.length,
        `${file} gives two components the same template path`,
      );
      for (const path of declared) {
        assert.ok(
          seeded.includes(path),
          `${file} declares template ${path} but seeds no source for it, so the component would ` +
            `fetch a file the package does not publish`,
        );
      }
    }
  }

  // Without this the test passes on a build that inlined nothing at all: every
  // `declared` list would be empty and every loop body would be skipped.
  assert.equal(inlined, 2, 'expected the collection inlined in both its readable and minified file');
});

void test('the collection carries its markup rather than leaving it to a request', () => {
  const collection = BUNDLES.find((bundle) => bundle.extends !== undefined);
  assert.ok(collection !== undefined);
  const { declared } = templateKeys(collection.file, textOf(collection.file));
  assert.ok(
    declared.length >= 10,
    `expected the collection's templates inlined, found ${String(declared.length)}`,
  );
});
