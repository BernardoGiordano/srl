/**
 * The registry half of the package: the files a consumer with a bundler installs.
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
 *
 * TYPES, AND WHY THEY ARE A TREE PLUS A BARREL
 *
 * The prefixes are a resolution problem for the type layer too: tsc ignores an
 * import map, and a declaration that still said `@core/…` would fail for a bundler
 * consumer one import down exactly as the JavaScript did. So the same answer is
 * applied twice. `emitDeclarations` writes one declaration per module into
 * `dist/types/`, mirroring the package's own layout, and rewrites every prefix it
 * emitted into a relative path — which is arithmetic rather than a second
 * resolution, because the tree mirrors the source and a relative path is the same
 * in both. Each bundle then gets a barrel over its members' declarations, and that
 * barrel is what `exports` points a `types` condition at. ADR-0108.
 *
 * The declarations are not rolled up into one file. A rollup has to rename every
 * colliding local type and reproduce tsc's own emit rules to do it, and nothing is
 * bought: a resolver reads the barrel, and the tree beside it is the same set of
 * facts a browser consumer already gets from the JSDoc in `lib/`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import { build as viteBuild } from 'vite';
import ts from 'typescript';

import { minifyTemplate } from '../../cli/delivery/template-html.mjs';
import { REPO, exists, walk } from '../../cli/layout.mjs';
import { barrelSource, declarationBarrelSource, moduleDoor } from '../../cli/package/door.mjs';
import { BUNDLES, MANIFEST, PACKAGE, SPECIFIER_DIRS } from '../../cli/package/interface.mjs';

/**
 * Where the four files land by default. Generated, so `dist/` is ignored and never
 * committed.
 *
 * A default rather than the only answer: the build empties its output directory
 * before writing, and `tools/test/package-bundle.test.mjs` reads the emitted bytes
 * rather than the location, so the suite builds into a directory of its own. The
 * dependency gate refuses a package whose `exports` names a file that is not there,
 * and a suite that deleted `dist/` while that gate was reading it failed on a rule
 * the repository satisfies.
 */
export const DIST = join(PACKAGE, 'dist');

/** Same target as the application build: the browsers the library supports. */
const TARGET = 'es2022';

/** Where the emitted declarations sit, relative to the bundles that are barrels over them. */
const TYPES = 'types';

/**
 * The type checker's copy of the specifier table, published with the package.
 *
 * Read rather than restated: the declarations are emitted with the options a
 * consumer type-checks the source path under, so the two paths cannot describe
 * different types of the same module.
 */
const BASE_TSCONFIG = join(PACKAGE, 'tsconfig.base.json');

/**
 * The library's own prefixes, longest first, so `@components/` cannot be shadowed by
 * a shorter prefix that happens to be a prefix of it.
 */
const PREFIXES = Object.entries(SPECIFIER_DIRS).sort(
  ([left], [right]) => right.length - left.length,
);

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
 * What each member offers, read out of the members rather than written.
 *
 * Still derived — the list of members is the walk above, and no name is typed
 * anywhere — but each member is now asked which of its exports are part of the
 * door, so a name the source documents as test-only or internal does not become a
 * promise to a registry consumer. `cli/package/door.mjs` owns the rule and the
 * marker; this reads the files for it. ADR-0077.
 *
 * Read once and used twice, by the JavaScript barrel and by the declaration barrel:
 * one answer, so the bundle's runtime surface and its type surface are the same set
 * of names by construction.
 *
 * @param {string[]} members
 * @returns {Promise<Array<{ file: string, door: import('../../cli/package/door.mjs').ModuleDoor }>>}
 */
async function doorsOf(members) {
  /** @type {Array<{ file: string, door: import('../../cli/package/door.mjs').ModuleDoor }>} */
  const doors = [];
  for (const file of members) {
    doors.push({ file, door: moduleDoor(await readFile(file, 'utf8'), file) });
  }
  return doors;
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
  return {
    name: 'srl-package-specifiers',
    enforce: 'pre',
    resolveId(source) {
      for (const [prefix, dir] of PREFIXES) {
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
 * @param {string} into The directory the pair is written to.
 * @returns {Promise<string>}
 */
async function emit(bundle, entrySource, minify, into) {
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
      outDir: into,
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

  const written = join(into, fileName);
  const text = await readFile(written, 'utf8');
  assertSelfContained(fileName, text, inherited);
  if (inherited !== '') {
    await assertInheritedNames(fileName, text, inherited, into);
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
 * @param {string} into The directory both files are written to.
 * @returns {Promise<void>}
 */
async function assertInheritedNames(fileName, text, inherited, into) {
  const sibling = join(into, inherited.replace(/^\.\//u, ''));
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

/* ── The type layer ───────────────────────────────────────────────────────── */

/**
 * The options the declarations are emitted under: the ones this package publishes
 * for a consumer of the source path, plus emit.
 *
 * `tsconfig.base.json` is the authority rather than a table copied here, so the
 * bundled declarations describe the same modules under the same `lib`, `target` and
 * `paths` a buildless consumer type-checks them under. Emit is the only override —
 * that file says `noEmit`, because a consumer never compiles this library and only
 * this build ever does.
 *
 * @param {string} out Where the tree is written.
 * @returns {ts.CompilerOptions}
 */
function declarationOptions(out) {
  const { config, error } = ts.readConfigFile(BASE_TSCONFIG, (file) => ts.sys.readFile(file));
  if (error !== undefined) {
    throw new Error(
      `${relative(REPO, BASE_TSCONFIG)}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`,
    );
  }

  // `fileNames` is ignored: the inputs are the walk below rather than this file's
  // include globs, which cover the whole package and are the source consumer's
  // question. What is wanted here is `options`, with `paths` already resolved
  // against the directory that declares them.
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, PACKAGE, undefined, BASE_TSCONFIG);
  refuseDiagnostics(parsed.errors, relative(REPO, BASE_TSCONFIG));

  return {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    noEmit: false,
    skipLibCheck: true,
    rootDir: PACKAGE,
    outDir: out,
  };
}

/**
 * Every module the declarations cover: the specifier prefixes' own trees, minus the
 * suites.
 *
 * The prefixes rather than the bundles' roots, and without the per-bundle
 * exclusions, because this is the tree the barrels resolve *through*. A component
 * excluded from the collection's door still appears in another component's declared
 * type, and a member of `srl-components` refers to types declared in `lib/`.
 *
 * Hand-written `.d.ts` files come along: a module's JSDoc names them, so a tree
 * without them declares types that resolve nowhere.
 *
 * @returns {Promise<string[]>}
 */
async function declarationInputs() {
  /** @type {string[]} */
  const files = [];
  for (const dir of Object.values(SPECIFIER_DIRS)) {
    files.push(...(await walk(dir, /\.(?:js|ts)$/u)));
  }
  return [...new Set(files)].filter((file) => !isTestSource(file)).sort();
}

/**
 * A package that declares a type, mapped to the dependency that re-exports it.
 *
 * TypeScript writes an inferred type as `import('…').Thing`, and the module it names
 * is the one that *declares* the thing rather than the one the source imported it
 * from: `nothing` comes into the library from `lit` and is declared in `lit-html`.
 * A consumer installs what `dependencies` says, so a declaration naming the second
 * resolves only where a flat `node_modules` happens to hoist it, and fails on the
 * install layout that does not.
 *
 * Sound only where the dependency really does re-export the name, which is the one
 * thing that cannot be assumed and does not have to be: the suite type-checks the
 * emitted tree against the declared dependencies alone, so a rewrite to a package
 * that does not offer the name fails there.
 */
const REDECLARED_BY = /** @type {Record<string, string>} */ ({ 'lit-html': 'lit' });

/**
 * A specifier as the emitted tree has to say it, or null for one already correct.
 *
 * Two rewrites, and the first is the reason this file exists. A library prefix
 * becomes a path relative to the file that names it, which is arithmetic rather than
 * resolution — sound because the emitted tree mirrors the package's own layout, so
 * the step from one file to another is the same in both trees. The `.js` extension
 * is kept as written: a resolver reading a declaration tries `.d.ts` for the `.js` it
 * was given, and that is what makes a hand-written `types.d.ts` reachable under the
 * name its importer typed.
 *
 * @param {string} specifier
 * @param {string} from The directory of the file the specifier is written in.
 * @returns {string | null}
 */
function rewrittenSpecifier(specifier, from) {
  for (const [prefix, dir] of PREFIXES) {
    if (!specifier.startsWith(prefix)) continue;
    const path = relative(from, join(dir, specifier.slice(prefix.length))).split(sep).join('/');
    return path.startsWith('.') ? path : `./${path}`;
  }

  for (const [declaring, dependency] of Object.entries(REDECLARED_BY)) {
    if (specifier === declaring) return dependency;
    if (specifier.startsWith(`${declaring}/`)) return `${dependency}/${specifier.slice(declaring.length + 1)}`;
  }

  return null;
}

/**
 * The string literal a node imports from, wherever a declaration can hold one.
 *
 * Three forms rather than the one the source's statements have. Declaration emit
 * writes an inferred type that came from another module as `import('…').Thing`,
 * which is a specifier in type position, and a `@type` tag can carry one of its own.
 *
 * @param {ts.Node} node
 * @returns {ts.StringLiteralLike | undefined}
 */
function importedFrom(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0];
  }
  return undefined;
}

/**
 * One declaration with the library's prefixes rewritten to paths.
 *
 * Spliced into the text rather than reprinted, so the emitted comments — which are
 * the library's own JSDoc, and half the reason a consumer wants these files — reach
 * the tarball as they were written.
 *
 * Which is also why the JSDoc is walked as syntax rather than searched as text. A
 * comment that *mentions* `@core/elements/mount.js` in a sentence is prose about the
 * library and stays that way; a `@type` tag that names an `import('…')` of it is a
 * specifier, and in a tree where nothing resolves an import map it has to become a
 * path.
 *
 * A source module's `@import` tags survive into the emitted declaration as comments
 * and are left as written: declaration emit has already turned each one into a real
 * `import type` statement, and a declaration file's JSDoc is not read for imports.
 * The suite type-checks the emitted tree with `skipLibCheck` off, so a TypeScript
 * that began reading them would fail there rather than in a consumer's install.
 *
 * @param {string} text
 * @param {string} fileName Used in the parse only.
 * @param {string} from The source directory this declaration was emitted from.
 * @returns {{ text: string, specifiers: Set<string> }} The specifiers are the rewritten ones.
 */
function rewriteSpecifiers(text, fileName, from) {
  const tree = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** Keyed by position: a tag is reachable from more than one node above it. */
  const edits = /** @type {Map<number, { end: number, text: string }>} */ (new Map());
  /** @type {Set<string>} */
  const specifiers = new Set();

  /** @param {ts.Node} node */
  const record = (node) => {
    const literal = importedFrom(node);
    if (literal === undefined) return;
    const rewritten = rewrittenSpecifier(literal.text, from);
    specifiers.add(rewritten ?? literal.text);
    if (rewritten !== null) {
      edits.set(literal.getStart(tree), { end: literal.getEnd(), text: JSON.stringify(rewritten) });
    }
  };

  /** A tag's own subtree, which is where a `@type {import('…')}` sits. */
  /** @param {ts.Node} node */
  const walkTag = (node) => {
    record(node);
    ts.forEachChild(node, walkTag);
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    record(node);
    for (const tag of ts.getJSDocTags(node)) walkTag(tag);
    ts.forEachChild(node, visit);
  };
  visit(tree);

  let rewritten = text;
  for (const [start, edit] of [...edits].sort(([left], [right]) => right - left)) {
    rewritten = rewritten.slice(0, start) + edit.text + rewritten.slice(edit.end);
  }
  return { text: rewritten, specifiers };
}

/**
 * Refuse a declaration that names a package this one does not depend on.
 *
 * The same rule `assertSelfContained` applies to the JavaScript, on the layer where
 * it is easier to break: a type can reach a package the runtime never imports, and
 * the resulting declaration resolves on a flat `node_modules` and fails on a strict
 * one. Read out of what was written rather than from the rewrite table, so a
 * specifier nothing rewrote is caught by the same check.
 *
 * @param {string} file
 * @param {Set<string>} specifiers
 */
function assertDeclaredDependencies(file, specifiers) {
  const declared = new Set(Object.keys(/** @type {Record<string, string>} */ (MANIFEST.dependencies ?? {})));
  const foreign = [...specifiers]
    .filter((specifier) => !specifier.startsWith('.'))
    // `lit/directives/repeat.js` is a subpath: the install that satisfies it is `lit`.
    .filter((specifier) => {
      const owner = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
      return !declared.has(owner);
    });

  if (foreign.length > 0) {
    throw new Error(
      `${relative(REPO, file)} declares a type from ${foreign.sort().join(', ')}, which this ` +
        `package does not depend on. A consumer installs what \`dependencies\` names, so the ` +
        `declaration resolves only where something else happened to hoist it.`,
    );
  }
}

/**
 * Write one declaration into the tree, with its specifiers resolved.
 *
 * @param {string} file Where it lands.
 * @param {string} out The root of the tree, which is what makes the source directory recoverable.
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeDeclaration(file, out, text) {
  const from = join(PACKAGE, relative(out, dirname(file)));
  const rewritten = rewriteSpecifiers(text, file, from);
  assertDeclaredDependencies(file, rewritten.specifiers);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rewritten.text, 'utf8');
}

/**
 * Emit the declaration tree both barrels resolve through.
 *
 * One program for the whole package rather than one per bundle: a component's
 * declared type names a type declared in `lib/`, and two trees would give a consumer
 * two declarations of it and a mismatch between the framework they imported and the
 * framework their components were built on.
 *
 * @param {string} into
 * @returns {Promise<string>}
 */
async function emitDeclarations(into) {
  const out = join(into, TYPES);
  const inputs = await declarationInputs();
  const program = ts.createProgram(inputs, declarationOptions(out));

  /** @type {Array<[string, string]>} */
  const emitted = [];
  const { diagnostics } = program.emit(undefined, (file, text) => emitted.push([file, text]));
  refuseDiagnostics(diagnostics, 'declaration emit');

  for (const [file, text] of emitted) await writeDeclaration(file, out, text);

  // The hand-written `.d.ts` files are inputs to that program rather than outputs of
  // it, so tsc emits nothing for them and a tree without them would resolve `./types.js`
  // to nothing. Copied through the same rewrite, because they name the prefixes too.
  const handWritten = inputs.filter((file) => file.endsWith('.d.ts'));
  for (const file of handWritten) {
    await writeDeclaration(join(out, relative(PACKAGE, file)), out, await readFile(file, 'utf8'));
  }

  const count = emitted.length + handWritten.length;
  return `  ok   ${`${TYPES}/`.padEnd(24)} ${String(count).padStart(8)} declaration(s)`;
}

/**
 * The declaration a bundle's `types` condition points at, and the one beside its
 * minified file.
 *
 * The minified declaration forwards rather than repeating: minification changes the
 * bytes a browser runs and nothing a type checker reads, and two barrels over one
 * tree would be two chances to disagree.
 *
 * @param {import('../../cli/package/interface.mjs').PackageBundle} bundle
 * @param {Array<{ file: string, door: import('../../cli/package/door.mjs').ModuleDoor }>} doors
 * @param {string} into
 * @returns {Promise<string>}
 */
async function emitDeclarationBarrel(bundle, doors, into) {
  const source = declarationBarrelSource(
    doors.map(({ file, door }) => ({
      file: `./${TYPES}/${relative(PACKAGE, file).split(sep).join('/')}`,
      door,
    })),
  );

  const name = basename(bundle.declaration);
  await writeFile(join(into, name), source, 'utf8');
  await writeFile(
    join(into, basename(bundle.minifiedDeclaration)),
    `export * from './${bundle.name}.js';\n`,
    'utf8',
  );
  return `  ok   ${name.padEnd(24)} ${String(source.length).padStart(8)} bytes`;
}

/**
 * Refuse a TypeScript step that reported anything.
 *
 * @param {readonly ts.Diagnostic[]} diagnostics
 * @param {string} what
 */
function refuseDiagnostics(diagnostics, what) {
  if (diagnostics.length === 0) return;
  const detail = diagnostics
    .map((diagnostic) => {
      const where =
        diagnostic.file === undefined ? '' : `${relative(REPO, diagnostic.file.fileName)}: `;
      return `  ${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    })
    .join('\n');
  throw new Error(`${what} refused the library:\n${detail}`);
}

/* ── The build ────────────────────────────────────────────────────────────── */

/**
 * Build every bundle the manifest declares.
 *
 * The output directory is emptied first, so a rename in `lib/` cannot leave a file
 * nothing builds any more sitting in the published set. That is also why `into`
 * exists: a caller that only wants the bytes — the suite — passes a directory of its
 * own rather than deleting the one the dependency gate is checking.
 *
 * @param {{ into?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function buildPackageBundles({ into = DIST } = {}) {
  await rm(into, { force: true, recursive: true });
  await mkdir(into, { recursive: true });

  /** @type {string[]} */
  const lines = [];
  /** @type {Array<[import('../../cli/package/interface.mjs').PackageBundle, Array<{ file: string, door: import('../../cli/package/door.mjs').ModuleDoor }>]>} */
  const built = [];

  for (const bundle of BUNDLES) {
    const members = await membersOf(bundle);
    if (members.length === 0) throw new Error(`${bundle.name} has no members; the roots are wrong.`);
    // Built once and reused for both minification settings: reading and parsing
    // every member is the cost, and it does not change with the minifier.
    const doors = await doorsOf(members);
    const entrySource = barrelSource(doors);
    lines.push(`  ok   ${bundle.name.padEnd(24)} ${String(members.length).padStart(8)} module(s)`);
    for (const minify of [false, true]) lines.push(await emit(bundle, entrySource, minify, into));
    built.push([bundle, doors]);
  }

  lines.push(await emitDeclarations(into));
  for (const [bundle, doors] of built) lines.push(await emitDeclarationBarrel(bundle, doors, into));

  // A directory of loose files is what a consumer's tooling sees, so say what is in
  // it there too rather than only here.
  await writeFile(
    join(into, 'README.md'),
    '# Generated\n\nBuilt by `npm run package` from the sources in `lib/` and `components/`.\n' +
      'Not committed, not edited: every change belongs in the source it was built from.\n',
    'utf8',
  );

  return lines;
}

/** Every emitted module, relative to the package: the pair `exports` names, minified and not. */
export const BUNDLE_FILES = BUNDLES.flatMap((bundle) => [bundle.file, bundle.minified]);

/** The declaration beside each of them, which is what a `types` condition resolves to. */
export const BUNDLE_DECLARATIONS = BUNDLES.flatMap((bundle) => [
  bundle.declaration,
  bundle.minifiedDeclaration,
]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');

  if (check) {
    const published = [...BUNDLE_FILES, ...BUNDLE_DECLARATIONS];
    const missing = [];
    for (const file of published) if (!(await exists(join(PACKAGE, file)))) missing.push(file);
    if (missing.length > 0) {
      console.error(`Missing: ${missing.join(', ')}. Run \`npm run package\`.`);
      process.exitCode = 1;
    } else {
      console.log(`  ok   all ${String(published.length)} published files are present`);
    }
  } else {
    console.log('');
    for (const line of await buildPackageBundles()) console.log(line);
    console.log(`\nWritten to ${relative(REPO, DIST)}/.`);
  }
}
