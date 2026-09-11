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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import test, { after } from 'node:test';

import ts from 'typescript';

import { REPO, walk } from '../../cli/layout.mjs';
import { moduleDoor } from '../../cli/package/door.mjs';
import { BUNDLES, MANIFEST, PACKAGE, SPECIFIER_DIRS } from '../../cli/package/interface.mjs';
import {
  BUNDLE_DECLARATIONS,
  BUNDLE_FILES,
  DIST,
  buildPackageBundles,
} from '../delivery/package-bundle.mjs';

// Built once for the whole file, into a directory of this suite's own. Once,
// because the build is the expensive part and every assertion below reads the same
// output. Somewhere else, because the build empties its output first and
// `source/dist/` is what `tools/checks/verify-deps.mjs` reads to decide whether
// `exports` points at files that exist — the two files run in parallel, and a
// half-second window with no `dist/` failed that gate on a rule the repository
// satisfies. Nothing here is about where the bytes landed.
const OUT = await mkdtemp(join(tmpdir(), 'srl-bundles-'));
after(() => rm(OUT, { force: true, recursive: true }));

await buildPackageBundles({ into: OUT });

/** @type {Map<string, string>} */
const emitted = new Map();
for (const file of [...BUNDLE_FILES, ...BUNDLE_DECLARATIONS]) {
  emitted.set(file, await readFile(join(OUT, basename(file)), 'utf8'));
}

/**
 * The emitted declarations, as a program.
 *
 * Built once, from the barrels a `types` condition points at, under the options a
 * bundler consumer would use. No library prefix is mapped and no path leads back
 * into the checkout, so a declaration that still named `@core/` resolves to nothing
 * here exactly as it would there. Every question below about the published type
 * surface is asked of this program rather than of the files that produced it, for
 * the same reason every question about the JavaScript is asked of the emitted bytes.
 *
 * The two `dependencies` are the exception, and they are mapped rather than resolved
 * because of where the bytes are: the suite builds into a temporary directory with
 * no `node_modules` above it, while a consumer who installed this package has both
 * of them beside it. Only the names the manifest declares, so a bundle that reached
 * for a third package fails here.
 *
 * `skipLibCheck` is off on purpose. It is on almost everywhere else because a
 * dependency's declarations are not this repository's problem; here the tree is the
 * artifact under test, and skipping it would pass a tree whose every file was wrong.
 */
const declarations = ts.createProgram(
  BUNDLE_DECLARATIONS.map((file) => join(OUT, basename(file))),
  {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    paths: Object.fromEntries(
      Object.keys(/** @type {Record<string, string>} */ (MANIFEST.dependencies ?? {})).flatMap(
        (name) => [
          [name, [join(REPO, 'node_modules', name)]],
          [`${name}/*`, [join(REPO, 'node_modules', name, '*')]],
        ],
      ),
    ),
  },
);

/**
 * The names one emitted declaration offers, asked of the checker rather than read
 * out of the text: a barrel is `export *` statements, and what those forward is a
 * question only resolution answers.
 *
 * @param {string} file
 * @returns {string[]}
 */
function declaredExports(file) {
  const source = declarations.getSourceFile(join(OUT, basename(file)));
  assert.ok(source !== undefined, `${file} is not in the declaration program`);
  const module = declarations.getTypeChecker().getSymbolAtLocation(source);
  assert.ok(module !== undefined, `${file} is not a module`);
  return declarations
    .getTypeChecker()
    .getExportsOfModule(module)
    .map((symbol) => symbol.name);
}

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

/**
 * The names an emitted file exports and the names it imports from a sibling: the
 * two halves of the door, read out of the bytes rather than from the tables that
 * produced them.
 *
 * @param {string} name
 * @param {string} text
 * @returns {{ exported: string[], imported: Map<string, string[]> }}
 */
function surfaceOf(name, text) {
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */
  const exported = [];
  /** @type {Map<string, string[]>} */
  const imported = new Map();

  for (const statement of tree.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) exported.push(element.name.text);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const names = bindings.elements.map((element) => (element.propertyName ?? element.name).text);
    imported.set(statement.moduleSpecifier.text, names);
  }

  return { exported, imported };
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

void test('no bundle offers a name its source marks internal', async () => {
  /** @type {string[]} */
  const kept = [];
  for (const bundle of BUNDLES) {
    for (const root of bundle.roots) {
      for (const file of await walk(root, /\.js$/u)) {
        if (file.split(sep).includes('test') || file.endsWith('.test.js')) continue;
        if (bundle.excluded.some((dir) => file.startsWith(dir + sep))) continue;
        kept.push(...moduleDoor(await readFile(file, 'utf8'), file).internal);
      }
    }
  }

  // Without this the test passes on a library that marks nothing at all.
  assert.ok(kept.length >= 15, `expected the library to keep names back, found ${String(kept.length)}`);

  for (const file of BUNDLE_FILES) {
    const { exported } = surfaceOf(file, textOf(file));
    for (const name of kept) {
      assert.ok(
        !exported.includes(name),
        `${file} exports ${name}, which its source marks \`@internal\``,
      );
    }
  }
});

void test('a bundle built on another reaches every name it imports from it', () => {
  for (const bundle of BUNDLES.filter((one) => one.extends !== undefined)) {
    for (const minified of [false, true]) {
      const suffix = minified ? '.min' : '';
      const file = minified ? bundle.minified : bundle.file;
      const sibling = `./${String(bundle.extends)}${suffix}.js`;
      const offered = surfaceOf(sibling, textOf(`dist/${String(bundle.extends)}${suffix}.js`)).exported;

      for (const name of surfaceOf(file, textOf(file)).imported.get(sibling) ?? []) {
        assert.ok(
          offered.includes(name),
          `${file} imports ${name} from ${sibling}, whose door does not offer it`,
        );
      }
    }
  }
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

void test('every bundle carries a declaration, for the minified file as well', () => {
  assert.deepEqual(BUNDLE_DECLARATIONS.slice().sort(), [
    'dist/srl-components.d.ts',
    'dist/srl-components.min.d.ts',
    'dist/srl-core.d.ts',
    'dist/srl-core.min.d.ts',
  ]);
  for (const file of BUNDLE_DECLARATIONS) {
    assert.ok(textOf(file).trim().length > 0, `${file} is empty`);
  }
});

void test('the published declarations resolve with no import map and no aliases', () => {
  const refused = ts.getPreEmitDiagnostics(declarations).map((diagnostic) => {
    const where =
      diagnostic.file === undefined ? '' : `${basename(diagnostic.file.fileName)}: `;
    return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  assert.deepEqual(
    refused,
    [],
    'a declaration that still names a prefix, or a tree missing a file it imports, is a ' +
      'package that type-checks here and fails on the consumer that installs it',
  );

  // Without this the test passes on a tree of empty files: every diagnostic list would
  // be empty and nothing would have been resolved at all.
  for (const bundle of BUNDLES) {
    assert.ok(
      declaredExports(bundle.declaration).length >= 20,
      `${bundle.declaration} offers almost nothing; the barrel resolved to nothing`,
    );
  }
});

void test('a declaration offers every name its bundle exports and none it marks internal', async () => {
  /** @type {string[]} */
  const kept = [];
  for (const bundle of BUNDLES) {
    for (const root of bundle.roots) {
      for (const file of await walk(root, /\.js$/u)) {
        if (file.split(sep).includes('test') || file.endsWith('.test.js')) continue;
        if (bundle.excluded.some((dir) => file.startsWith(dir + sep))) continue;
        kept.push(...moduleDoor(await readFile(file, 'utf8'), file).internal);
      }
    }
  }

  for (const bundle of BUNDLES) {
    const offered = new Set(declaredExports(bundle.declaration));

    // A superset rather than the same list: a JSDoc `@typedef` is a name the type
    // layer offers and the runtime has nowhere to put, and a consumer wanting to
    // annotate a variable needs it. The other direction is the failure — a value a
    // consumer can import and cannot type.
    for (const name of surfaceOf(bundle.file, textOf(bundle.file)).exported) {
      assert.ok(offered.has(name), `${bundle.declaration} does not declare ${name}`);
    }
    for (const name of kept) {
      assert.ok(!offered.has(name), `${bundle.declaration} declares ${name}, marked \`@internal\``);
    }
  }
});

void test('the minified declaration is the readable one, not a second opinion', () => {
  for (const bundle of BUNDLES) {
    assert.deepEqual(
      declaredExports(bundle.minifiedDeclaration).sort(),
      declaredExports(bundle.declaration).sort(),
      `${bundle.minifiedDeclaration} and ${bundle.declaration} describe different surfaces`,
    );
  }
});
