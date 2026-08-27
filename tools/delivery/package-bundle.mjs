/**
 * The registry half of the package: four files a consumer with a bundler installs.
 *
 *   node tools/delivery/package-bundle.mjs            build source/dist/
 *   node tools/delivery/package-bundle.mjs --check    fail if it is absent or stale
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE PREMISE
 *
 * The library is written against bare prefixes — `@core/`, `@auth/`, `@host/`,
 * `@components/` — that a browser resolves through the import map the package
 * publishes. That is the whole delivery story for the consumer this framework is
 * for, and nothing here changes it: `lib/` and `components/` still ship as source,
 * still carry `importmap.json`, and an application that pastes the fragment gets
 * the library's own bytes with no build.
 *
 * A consumer who resolves through Node or a bundler has no import map. For them
 * those same prefixes are unresolvable specifiers, so the `exports` map used to
 * advertise a surface that threw on first import. This module is the answer:
 * every internal prefix is resolved at build time, so the emitted file imports
 * nothing but its declared dependencies. ADR-0066.
 *
 * TWO FILES, NOT ONE, AND WHY THE SECOND IMPORTS THE FIRST
 *
 * `srl-components.js` treats the framework as external and imports it from
 * `./srl-core.js`. Inlining core into both would put two copies of the custom
 * element registry, the injector and the template cache in one page, and the
 * second `defineComponent` for a tag would throw against a registry the first
 * one filled. One copy is a correctness requirement, not a size optimisation.
 *
 * WHAT THE BARREL SAYS
 *
 * The members are walked, never listed, so a layer added once reaches this consumer
 * too — that is ADR-0033's guarantee and nothing here weakens it. What each member
 * contributes is now the member's own answer: an export marked `@internal` stays
 * importable by path and leaves the bundle's flat namespace. `cli/package/door.mjs`
 * owns that rule; ADR-0077 is why.
 *
 * TEMPLATES
 *
 * A component is a `.js` and a sibling `.html`, and `defineComponent` derives the
 * second from `import.meta.url`. Inside a bundle every module shares one
 * `import.meta.url`, so the derivation collapses onto one file name and fifteen
 * components would fight over it. The transform below gives each declaration an
 * explicit `template` path and seeds the compiler with that file's bytes under
 * the URL the same expression produces at runtime, so the seeded key and the
 * looked-up key are computed identically and cannot drift.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { build as viteBuild } from 'vite';
import ts from 'typescript';

import { minifyTemplate } from '../../cli/delivery/template-html.mjs';
import { REPO, exists, walk } from '../../cli/layout.mjs';
import { barrelSource, moduleDoor } from '../../cli/package/door.mjs';
import { BUNDLES, MANIFEST, PACKAGE, SPECIFIER_DIRS } from '../../cli/package/interface.mjs';

/** Where the four files land. Generated, so `dist/` is ignored and never committed. */
export const DIST = join(PACKAGE, 'dist');

/** Same target as the application build: the browsers the library supports. */
const TARGET = 'es2022';

/**
 * The runtime dependencies, left external in both bundles.
 *
 * Read from the manifest rather than listed, so vendoring a fourth dependency
 * cannot silently inline it here. The specifiers are the ones source imports
 * under, which is what a bundler matches on.
 */
const EXTERNAL = Object.keys(/** @type {Record<string, string>} */ (MANIFEST.srl.vendor)).filter(
  // Development-only, imported by nothing: it is a <script> in an index.html.
  (specifier) => specifier !== '@tailwindcss/browser',
);

/**
 * Test source, decided on the path relative to the package rather than the
 * absolute one — the same rule the project model learned, for the same reason: a
 * checkout that happens to sit under a directory called `test` is not a suite.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isTestSource(path) {
  const inside = relative(PACKAGE, path);
  return inside.split(sep).includes('test') || inside.endsWith('.test.js');
}

/**
 * The modules one bundle is a barrel over, sorted so the emitted entry is stable
 * byte for byte across machines.
 *
 * @param {import('../../cli/package/interface.mjs').PackageBundle} bundle
 * @returns {Promise<string[]>}
 */
async function membersOf(bundle) {
  /** @type {string[]} */
  const files = [];
  for (const root of bundle.roots) files.push(...(await walk(root, /\.js$/u)));
  return [...new Set(files)]
    .filter((file) => !isTestSource(file))
    .filter((file) => !bundle.excluded.some((dir) => file.startsWith(dir + sep)))
    .sort();
}

/**
 * The barrel itself, read out of the members rather than written.
 *
 * Still derived — the list of members is the walk above, and no name is typed
 * anywhere — but each member is now asked which of its exports are part of the
 * door, so a name the source documents as test-only or internal does not become a
 * promise to a registry consumer. `cli/package/door.mjs` owns the rule and the
 * marker; this reads the files for it. ADR-0077.
 *
 * @param {string[]} members
 * @returns {Promise<string>}
 */
async function barrel(members) {
  /** @type {Array<{ file: string, door: import('../../cli/package/door.mjs').ModuleDoor }>} */
  const doors = [];
  for (const file of members) {
    doors.push({ file, door: moduleDoor(await readFile(file, 'utf8'), file) });
  }
  return barrelSource(doors);
}

/**
 * Resolve the library's own prefixes to files on disk.
 *
 * The table is the manifest's, through interface.mjs, so this cannot disagree with
 * what the browser resolves: one authority, two resolvers.
 *
 * @param {string[]} external Specifier prefixes another bundle owns.
 * @param {string} inherited The sibling file those prefixes resolve to.
 * @returns {import('vite').Plugin}
 */
function resolvePackageSpecifiers(external, inherited) {
  /** Longest prefix first, so `@components/` cannot be shadowed by a shorter one. */
  const prefixes = Object.entries(SPECIFIER_DIRS).sort(
    ([left], [right]) => right.length - left.length,
  );

  return {
    name: 'srl-package-specifiers',
    enforce: 'pre',
    resolveId(source) {
      for (const [prefix, dir] of prefixes) {
        if (!source.startsWith(prefix)) continue;
        // A prefix the extended bundle owns leaves this one as a single import of
        // that file. Minified pairs with minified: a consumer who loaded
        // srl-components.min.js and got the unminified framework beside it would be
        // shipping both copies of every comment in the library.
        if (external.includes(prefix)) return { id: inherited, external: true };
        return join(dir, source.slice(prefix.length));
      }
      return null;
    },
  };
}

/**
 * Give every `defineComponent` in the bundle an explicit template path, and seed
 * the compiler with that template's bytes.
 *
 * The rewrite is an AST edit rather than a regular expression for the same reason
 * the production build's is: `defineComponent` is a call whose argument is an
 * object literal, and finding the `template` key in text means reimplementing a
 * parser that is already in the toolchain.
 *
 * @param {string} bundleName
 * @param {string[]} roots Directories this bundle is a barrel over.
 * @returns {{ plugin: import('vite').Plugin, count: () => number }}
 */
function inlineTemplates(bundleName, roots) {
  let inlined = 0;

  return {
    count: () => inlined,
    plugin: {
      name: 'srl-inline-templates',
      enforce: 'pre',
      async transform(code, id) {
        const module = id.split('?')[0] ?? id;
        if (!module.endsWith('.js')) return null;
        if (!roots.some((root) => module.startsWith(root + sep))) return null;

        const tree = ts.createSourceFile(module, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

        /** @type {ts.ObjectLiteralExpression[]} */
        const declarations = [];
        /** @param {ts.Node} node */
        const visit = (node) => {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'defineComponent'
          ) {
            const [object] = node.arguments;
            if (object !== undefined && ts.isObjectLiteralExpression(object)) declarations.push(object);
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
        if (declarations.length === 0) return null;

        /** @type {Array<{ start: number, end: number, text: string }>} */
        const edits = [];
        /** @type {Array<[string, string]>} */
        const seeds = [];

        for (const declaration of declarations) {
          const existing = declaration.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'template',
          );
          // `template: false` is a component that builds its markup in render().
          // There is no file to inline and nothing to rewrite.
          if (
            existing !== undefined &&
            ts.isPropertyAssignment(existing) &&
            existing.initializer.kind === ts.SyntaxKind.FalseKeyword
          ) {
            continue;
          }

          const authored = await siblingTemplate(module, existing);
          if (authored === null) continue;

          // Minified, for the same reason the artifact build minifies: comments and
          // indentation are bytes the runtime compiler discards on arrival, and here
          // they would sit inside a published bundle's string literals forever.
          // `minifyTemplate` proves the result parses to the same tree first
          // (ADR-0070).
          const source = minifyTemplate(authored);

          // Content-addressed, so two components whose markup happens to be
          // identical share one seeded entry and a renamed file changes nothing.
          const hash = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16);
          const path = `./${bundleName}-templates/${basename(module, '.js')}-${hash}.html`;
          seeds.push([path, source]);
          inlined += 1;

          if (existing !== undefined && ts.isPropertyAssignment(existing)) {
            edits.push({
              start: existing.initializer.getStart(tree),
              end: existing.initializer.getEnd(),
              text: JSON.stringify(path),
            });
          } else {
            const at = declaration.getStart(tree) + 1;
            edits.push({ start: at, end: at, text: ` template: ${JSON.stringify(path)},` });
          }
        }

        if (seeds.length === 0) return null;

        let transformed = code;
        for (const edit of edits.sort((left, right) => right.start - left.start)) {
          transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
        }

        // The seed key is `new URL(path, import.meta.url).href`, which is character
        // for character what `defineComponent` computes from the same `path` and the
        // same module. Anything else — a root-relative URL, a literal string — would
        // resolve against document.baseURI in one place and the bundle's own URL in
        // the other, and match only when the page happens to sit at the root.
        const seeding = seeds
          .map(
            ([path, source]) =>
              `  [new URL(${JSON.stringify(path)}, import.meta.url).href]: ${JSON.stringify(source)},`,
          )
          .join('\n');

        return {
          code:
            `import { seedTemplates as __srlSeedTemplates } from '@core/template/template.js';\n` +
            `__srlSeedTemplates({\n${seeding}\n});\n` +
            transformed,
          map: null,
        };
      },
    },
  };
}

/**
 * The markup a declaration renders: its module's sibling `.html`, or the path the
 * declaration named instead.
 *
 * A declared template that does not exist is an error rather than a skip — it is a
 * component that renders nothing, and finding that out in a consumer's browser is
 * the outcome this whole file exists to prevent.
 *
 * @param {string} module
 * @param {ts.ObjectLiteralElementLike | undefined} declared
 * @returns {Promise<string | null>}
 */
async function siblingTemplate(module, declared) {
  let file = module.replace(/\.js$/u, '.html');
  if (declared !== undefined && ts.isPropertyAssignment(declared)) {
    if (!ts.isStringLiteralLike(declared.initializer)) {
      throw new Error(
        `${relative(REPO, module)} declares a \`template\` this build cannot read statically. It ` +
          `has to be a string literal or \`false\`, because the bundle inlines the bytes.`,
      );
    }
    file = join(module, '..', declared.initializer.text);
  }

  if (!(await exists(file))) {
    if (declared === undefined) return null;
    throw new Error(`${relative(REPO, module)} names template ${relative(REPO, file)}, which does not exist.`);
  }
  return readFile(file, 'utf8');
}

/**
 * One bundle, one minification setting, one file.
 *
 * @param {import('../../cli/package/interface.mjs').PackageBundle} bundle
 * @param {string} entrySource The barrel, built once for both minification settings.
 * @param {boolean} minify
 * @returns {Promise<string>}
 */
async function emit(bundle, entrySource, minify) {
  const entry = `\0srl-entry:${bundle.name}`;
  const suffix = minify ? '.min' : '';
  const fileName = `${bundle.name}${suffix}.js`;
  const inherited = bundle.extends === undefined ? '' : `./${bundle.extends}${suffix}.js`;
  const templates = inlineTemplates(bundle.name, bundle.roots);

  await viteBuild({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    mode: 'production',
    publicDir: false,
    root: PACKAGE,
    plugins: [
      {
        name: 'srl-bundle-entry',
        resolveId: (source) => (source === entry ? source : null),
        load: (id) => (id === entry ? entrySource : null),
      },
      resolvePackageSpecifiers(bundle.external, inherited),
      templates.plugin,
    ],
    build: {
      emptyOutDir: false,
      minify: minify ? 'oxc' : false,
      modulePreload: false,
      outDir: DIST,
      sourcemap: false,
      target: TARGET,
      rolldownOptions: {
        input: entry,
        external: EXTERNAL,
        preserveEntrySignatures: 'strict',
        output: { format: 'es', entryFileNames: fileName },
      },
    },
  });

  const written = join(DIST, fileName);
  const text = await readFile(written, 'utf8');
  assertSelfContained(fileName, text, inherited);
  if (inherited !== '') {
    await assertInheritedNames(fileName, text, inherited);
  }
  return `  ok   ${fileName.padEnd(24)} ${String(text.length).padStart(8)} bytes${
    templates.count() === 0 ? '' : `, ${String(templates.count())} template(s) inlined`
  }`;
}

/**
 * Refuse a bundle that still names a prefix only an import map resolves.
 *
 * The failure this catches is the one the whole module exists for, so it is
 * checked against the emitted bytes rather than trusted from the configuration:
 * a plugin that stopped matching would otherwise ship a file that throws on the
 * consumer's first import and passes every test here.
 *
 * @param {string} fileName
 * @param {string} text
 * @param {string} inherited The one sibling import this bundle is allowed, if any.
 */
function assertSelfContained(fileName, text, inherited) {
  const allowed = new Set([...EXTERNAL, ...(inherited === '' ? [] : [inherited])]);
  /** @type {Set<string>} */
  const leaked = new Set();

  // Parsed rather than matched. The unminified bundle keeps the JSDoc it was built
  // from, and `@import { X } from '@core/…'` in a comment is documentation, not an
  // import: a text search reports every one of them and the real leak drowns.
  const tree = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @param {ts.Node} node */
  const visit = (node) => {
    /** @type {string | undefined} */
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }

    if (specifier !== undefined && !allowed.has(specifier)) leaked.add(specifier);
    ts.forEachChild(node, visit);
  };
  visit(tree);

  if (leaked.size > 0) {
    throw new Error(
      `${fileName} still imports ${[...leaked].sort().join(', ')}. A registry consumer has no ` +
        `import map, so every specifier in a published bundle must be a declared dependency or a ` +
        `sibling file.`,
    );
  }
}

/**
 * Refuse a bundle whose sibling no longer offers a name it imports.
 *
 * This is the failure the curated door introduces. `@internal` on a name in `lib/`
 * is invisible to a component that imports it: inside `srl-components` that import
 * resolves to `./srl-core.js`, and a core bundle that no longer exports the name
 * ships a pair of files that throws on the consumer's first import, in a file they
 * never wrote. Nothing else here would see it — the browser suites resolve the same
 * import through the import map, where every export is still reachable by path.
 *
 * Read out of the sibling's emitted bytes rather than from the door tables, so a
 * barrel that narrowed for any other reason is caught by the same check.
 *
 * @param {string} fileName
 * @param {string} text
 * @param {string} inherited The sibling this bundle imports, as it is written.
 * @returns {Promise<void>}
 */
async function assertInheritedNames(fileName, text, inherited) {
  const sibling = join(DIST, inherited.replace(/^\.\//u, ''));
  if (!(await exists(sibling))) {
    throw new Error(
      `${fileName} extends ${inherited}, which has not been built yet. A bundle must be emitted ` +
        `after the one it extends.`,
    );
  }

  const offered = new Set(bundleExports(await readFile(sibling, 'utf8'), inherited));
  /** @type {Set<string>} */
  const missing = new Set();

  const tree = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== inherited
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (!offered.has(name)) missing.add(name);
    }
  }

  if (missing.size > 0) {
    throw new Error(
      `${fileName} imports ${[...missing].sort().join(', ')} from ${inherited}, which does not ` +
        `export ${missing.size === 1 ? 'it' : 'them'}. A name marked \`@internal\` is still ` +
        `importable by path, but it leaves the bundle's door, and a bundle built on another can ` +
        `only reach what that door offers.`,
    );
  }
}

/**
 * The names an emitted bundle exports. One `export { … }` statement, which is what
 * rolldown writes for an entry chunk, and the exported half of each pair.
 *
 * @param {string} text
 * @param {string} fileName
 * @returns {string[]}
 */
function bundleExports(text, fileName) {
  const tree = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */
  const names = [];
  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.push(element.name.text);
  }
  return names;
}

/**
 * @returns {Promise<string[]>}
 */
export async function buildPackageBundles() {
  await rm(DIST, { force: true, recursive: true });
  await mkdir(DIST, { recursive: true });

  /** @type {string[]} */
  const lines = [];
  for (const bundle of BUNDLES) {
    const members = await membersOf(bundle);
    if (members.length === 0) throw new Error(`${bundle.name} has no members; the roots are wrong.`);
    // Built once and reused for both minification settings: reading and parsing
    // every member is the cost, and it does not change with the minifier.
    const entrySource = await barrel(members);
    lines.push(`  ok   ${bundle.name.padEnd(24)} ${String(members.length).padStart(8)} module(s)`);
    for (const minify of [false, true]) lines.push(await emit(bundle, entrySource, minify));
  }

  // A directory of loose files is what a consumer's tooling sees, so say what is in
  // it there too rather than only here.
  await writeFile(
    join(DIST, 'README.md'),
    '# Generated\n\nBuilt by `npm run package` from the sources in `lib/` and `components/`.\n' +
      'Not committed, not edited: every change belongs in the source it was built from.\n',
    'utf8',
  );

  return lines;
}

/** Every emitted file, relative to the package: the pair `exports` names, minified and not. */
export const BUNDLE_FILES = BUNDLES.flatMap((bundle) => [bundle.file, bundle.minified]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');

  if (check) {
    const missing = [];
    for (const file of BUNDLE_FILES) if (!(await exists(join(PACKAGE, file)))) missing.push(file);
    if (missing.length > 0) {
      console.error(`Missing: ${missing.join(', ')}. Run \`npm run package\`.`);
      process.exitCode = 1;
    } else {
      console.log('  ok   all four bundles are present');
    }
  } else {
    console.log('');
    for (const line of await buildPackageBundles()) console.log(line);
    console.log(`\nWritten to ${relative(REPO, DIST)}/.`);
  }
}
