/**
 * The guard that keeps a buildless app honest.
 *
 * Fifteen failure modes are invisible without it, and each either breaks
 * production silently or opens a hole:
 *
 *  1. An unpinned or unhashed remote URL. The import maps currently point only at
 *     /lib/vendor, but this check stays because re-adding a CDN entry is one line
 *     and its bytes would have to be pinned, exact, and free of sub-imports the
 *     integrity map cannot cover. ADR-0032.
 *  2. A vendored file with no integrity hash. The hash is what makes
 *     source/lib/vendor a control rather than a copy. ADR-0032.
 *  3. Type drift. node_modules holds a different version than /lib/vendor serves,
 *     so tsc validates against an API the browser will not have. This is the
 *     sharpest edge of the whole architecture: the type checker and the runtime
 *     read from two different places, and nothing but this check ties them
 *     together.
 *  4. Undeclared runtime dependencies. A source file imports a bare specifier the
 *     import map does not declare. It resolves to nothing, and only on the route
 *     that happens to import it.
 *  5. A CSP that blocks the import map. An import map is an inline script, so
 *     `script-src 'self'` alone leaves every bare specifier unresolvable: a blank
 *     page whose error names module resolution rather than the header that caused
 *     it. The hash to allow is computed on every run, per application and as the
 *     whole set a deployment has to carry.
 *  6. A layering violation: something under source/lib importing @app/, or an
 *     import map whose library prefixes do not resolve to source/lib. Either one
 *     turns "the library is a package you build on" back into "the library is
 *     whatever the application happens to contain", which is the thing this
 *     directory structure exists to prevent.
 *  7. A missing template. A component's markup is the sibling `.html` of its
 *     module, resolved at runtime, so a renamed or deleted file is a 404 on one
 *     route and nothing anywhere else.
 *  8. A template no component definition claims. Always a leftover from a rename,
 *     and invisible: the old markup keeps being served and renders nowhere.
 *  9. A message key present in a translation but absent from the default locale.
 *     Always a typo or a leftover, and invisible because the key still renders in
 *     the locale that has it and nowhere else.
 * 10. A missing default-locale bundle. Every other locale falls back to it, so
 *     without it a partial translation shows raw keys.
 * 11. A remote with no navigation label. `ui-nav` builds its remote links from the
 *     manifest and asks for `nav.<name>`, so a mounted remote whose name has no
 *     message key puts a raw key in the header of every locale.
 * 12. A manifest the runtime would refuse: a cross-origin or unpinned remote, a
 *     cross-origin auth destination, two remotes claiming one mount, a locale
 *     bundle outside this origin. The document is admitted here by
 *     `@core/remotes/manifest-policy.js` — the same module the browser runs at
 *     startup — so a manifest that would fail in production fails in the build
 *     instead, and neither side can drift into a policy the other does not have.
 *     What stays local to this check is the part only a filesystem can see: every
 *     JS artifact in a remote's folder must be covered by the integrity map.
 * 13. A component declaration static analysis cannot read: a computed tag, an
 *     `element` that is not a class, a `uses` entry naming a class nothing defines,
 *     two modules claiming one tag. Such a declaration may work in the browser, and
 *     every tool here is blind to it — this one, the template checker and the
 *     template bundler alike. cli/project-model/ finds them; this fails on them.
 * 14. A library or shared-collection module reaching for `localStorage` or
 *     `sessionStorage` itself instead of going through @core/preferences/persistence.js.
 *     Invisible until an application configures its own store — a memory store under
 *     test, an encrypted wrapper, a synchronously hydrated backend cache — and gets it
 *     for the table and the filters but not for the theme, because that one kept its
 *     own slot. Theme and locale both did until the preference module took them.
 *     `source/lib/auth/` is exempt by path: credentials are a different seam.
 *
 * 15. A documentation surface under source/. The durable ones are README.md and docs/,
 *     and the contract tables in docs/reference/ are generated from the
 *     project model; a nested README goes stale in the directory somebody edits first.
 * 16. Four descriptions of one published interface disagreeing. source/package.json
 *     declares the library's surface; the generated import-map fragment, the `exports`
 *     map, the tsconfig paths and every application's inline map are supposed to
 *     restate it. Nothing at runtime notices when one of them stops: the browser
 *     follows the map, tsc follows the paths, npm follows exports, and each resolves a
 *     different set of files. This is the check that makes the manifest the source
 *     rather than the fourth opinion.
 *
 * Untranslated keys are counted and reported, not failed. Shipping a locale at
 * 60% is a normal state and the fallback handles it key by key.
 *
 * Every check runs for every application in the repository, because "it works in
 * example" says nothing about the one deployed next week.
 *
 * `verifyDependencies()` returns every finding as a `Diagnostic` and prints nothing:
 * cli/diagnostics/index.mjs owns the report, so `--json` is free, and this file has an
 * interface a suite can assert against instead of a process to run and a terminal to
 * scrape. ADR-0072.
 *
 * Run: npm run verify
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import { error, info, outputFormat, report, warning } from '../../cli/diagnostics/index.mjs';
import { REPO, apps, exists, readText, walk } from '../../cli/layout.mjs';
import {
  COMPONENTS,
  BUNDLES,
  IMPORT_MAP_FILE,
  LIB,
  MANIFEST,
  PACKAGE,
  SPECIFIER_DIRS,
  SPECIFIERS,
  VENDOR,
  extractImportMap,
  fileToUrl,
  importMapFragment,
  importMapText,
  packageExports,
  urlToFile,
} from '../../cli/package/interface.mjs';
import {
  missingTemplates,
  orphanTemplates,
  projectErrors,
  readProject,
  shippedTemplates,
} from '../../cli/project-model/index.mjs';
import { admitManifest } from '../../source/lib/core/remotes/manifest-policy.js';

/** @import { Diagnostic, Where } from '../../cli/diagnostics/types.js' */

/**
 * A manifest names root-relative paths, so admission needs an origin only to
 * resolve them against. Which one is irrelevant and deliberately not a real
 * deployment's: a check that had to know the production origin could not run
 * before there was one.
 */
const MANIFEST_ORIGIN = 'https://manifest.invalid/';

/**
 * The two declarations several checks below are *about* rather than merely reading:
 * the library's manifest, which is the one description of its published interface,
 * and this repository's tsconfig, which is supposed to be the package's own.
 */
const MANIFEST_FILE = join(PACKAGE, 'package.json');
const ROOT_TSCONFIG = join(REPO, 'tsconfig.json');

/**
 * A path as this file's *prose* spells it, for the sentences that name one. Where a
 * path is the location of a finding it goes on the diagnostic instead, and
 * cli/diagnostics spells it — once, for every check.
 *
 * @param {string} path
 */
function show(path) {
  return relative(REPO, path).split(/[\\/]/u).join('/');
}

/**
 * A suite or a fixture, decided on the path relative to the repository rather than the
 * absolute one. The project model learned this the hard way: matching `/test/` anywhere
 * in an absolute path makes every file test source for anyone whose checkout happens to
 * sit under a directory called `test`.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isTestSource(path) {
  const inside = relative(REPO, path);
  return inside.split(sep).includes('test') || inside.endsWith('.test.js');
}

/**
 * Every rule this file knows, checked, as findings.
 *
 * One list, in the order the checks run, because that order is what a reader follows:
 * the library first, then each application, then the two published packages. The
 * severities are the exit-code rule — an `error` refuses the run, a `warning` is a
 * locale at 60% or a coverage gap said out loud — and cli/diagnostics/index.mjs is
 * what turns any of it into output.
 *
 * @returns {Promise<Diagnostic[]>}
 */
export async function verifyDependencies() {
  /** @type {Diagnostic[]} */
  const found = [];

  /** A refusal. @param {string} code @param {string} message @param {Where} [at] */
  const refuse = (code, message, at) => void found.push(error(code, message, at));

  /** A check that ran and passed. @param {string} code @param {string} message @param {Where} [at] */
  const pass = (code, message, at) => void found.push(info(code, message, at));

  /** Reported, and not a refusal. @param {string} code @param {string} message @param {Where} [at] */
  const note = (code, message, at) => void found.push(warning(code, message, at));

  const applications = await apps();
  if (applications.length === 0) {
    refuse('deps/no-application', 'No application directory with an index.html was found.');
  }

  /**
   * The library's own prefixes, and the directory each must resolve into — read
   * from source/package.json rather than restated here. A layer the library adds
   * is a layer this check knows about the same day.
   */
  const LIBRARY_PREFIXES = SPECIFIER_DIRS;

  /* ── 0. The library does not depend on any application ─────────────────── */

  /**
   * The one rule that makes source/lib a library rather than a folder: everything
   * in it may be read by an application, and nothing in it may read one back. A
   * single `@app/` import here would make the framework undeployable without
   * example, and it would do it silently, because in this repository example is
   * always present.
   */
  const libFiles = await walk(LIB, /\.(js|d\.ts)$/u);
  const componentFiles = await walk(COMPONENTS, /\.(js|d\.ts)$/u);
  const appNames = applications.map((app) => app.name);

  for (const file of [...libFiles, ...componentFiles]) {
    const source = withoutComments(await readFile(file, 'utf8'));
    for (const match of source.matchAll(/(?:^|[\s{(,;])(?:import|from)\s*\(?\s*["']([^"']+)["']/gmu)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const reachesApp =
        specifier.startsWith('@app/') ||
        appNames.some((name) => specifier.includes(`/${name}/`) || specifier.startsWith(`${name}/`));
      if (reachesApp) {
        refuse(
          'deps/library-imports-application',
          `imports "${specifier}". Nothing under source/ may import from an application: the ` +
            `dependency runs application -> components -> {core, auth, host} and never back. A ` +
            `library that needs one application to run is not a library.`,
          { file },
        );
      }
    }
  }

  pass(
    'deps/no-application-imports',
    `${String(libFiles.length)} library and ${String(componentFiles.length)} component file(s) ` +
      `import no application code`,
  );

  /* ── 16. The package's published interface is one declaration ──────────── */

  /**
   * source/package.json declares the library's surface once, and three other files
   * are supposed to say the same thing: the generated import-map fragment a
   * consumer pastes or fetches, the `exports` map npm reads, and the tsconfig
   * paths tsc resolves. Nothing at runtime notices when they drift — the browser
   * follows the map, tsc follows the paths, and a registry consumer follows
   * exports, each happily resolving a different set of files.
   *
   * The fragment is compared as bytes because it is committed: a buildless
   * consumer reads it from the repository without running anything here, so
   * "regenerate it and it would change" is a stale artifact, not a warning.
   */
  const fragment = await importMapFragment();
  const fragmentOnDisk = await readText(IMPORT_MAP_FILE).catch(() => null);
  const fragmentText = await importMapText();

  if (fragmentOnDisk === null) {
    refuse(
      'deps/no-import-map-fragment',
      `does not exist. It is the library's published import map; run \`npm run importmap\`.`,
      { file: IMPORT_MAP_FILE },
    );
  } else if (fragmentOnDisk !== fragmentText) {
    refuse(
      'deps/stale-import-map-fragment',
      `is not what source/package.json and the vendored bytes imply. Run ` +
        `\`npm run importmap\`. Until then a consumer that fetches it gets a map the library no ` +
        `longer serves.`,
      { file: IMPORT_MAP_FILE },
    );
  } else {
    pass('deps/import-map-fragment', 'matches the manifest and the vendored bytes', {
      file: IMPORT_MAP_FILE,
    });
  }

  /**
   * Every specifier prefix belongs to exactly one bundle.
   *
   * This is what makes the two halves of the interface the same surface. A layer
   * added to `srl.imports` reaches a browser the moment the import map is
   * regenerated; it reaches a registry consumer only if some bundle is a barrel
   * over it, and a prefix in no bundle is a layer half the consumers cannot see.
   */
  const claimedBy = /** @type {Map<string, string[]>} */ (new Map());
  for (const bundle of BUNDLES) {
    for (const prefix of bundle.imports) claimedBy.set(prefix, [...(claimedBy.get(prefix) ?? []), bundle.name]);
  }
  for (const prefix of Object.keys(SPECIFIERS)) {
    const claims = claimedBy.get(prefix) ?? [];
    if (claims.length === 1) continue;
    refuse(
      claims.length === 0 ? 'deps/prefix-in-no-bundle' : 'deps/prefix-in-two-bundles',
      claims.length === 0
        ? `declares the specifier prefix "${prefix}" but no entry in \`srl.bundles\` is a barrel ` +
            `over it, so a consumer who resolves through a bundler cannot reach that layer at all.`
        : `puts "${prefix}" in ${String(claims.length)} bundles (${claims.join(', ')}). Two ` +
            `barrels over one directory means two copies of every module in it, and two custom ` +
            `element registries in one page.`,
      { file: MANIFEST_FILE },
    );
  }

  /**
   * An `exports` target as the paths it can resolve to.
   *
   * A target is a string or a conditional object, and both shapes are in use here:
   * the bundles and the tooling entry points are plain strings, the three
   * declaration-only subpaths are `{ "types": "./…d.ts" }` so that the type checker
   * resolves them and Node refuses to. Every branch of a conditional has to exist —
   * a condition nobody's resolver selects is still a promise this package made.
   *
   * @param {string | Record<string, unknown>} target
   * @returns {string[]}
   */
  function exportTargets(target) {
    if (typeof target === 'string') return [target];
    return Object.values(target).flatMap((nested) =>
      typeof nested === 'string' || (typeof nested === 'object' && nested !== null)
        ? exportTargets(/** @type {string | Record<string, unknown>} */ (nested))
        : [],
    );
  }

  const declaredExports = /** @type {Record<string, string | Record<string, unknown>>} */ (
    MANIFEST.exports ?? {}
  );
  for (const [subpath, target] of Object.entries(packageExports())) {
    if (declaredExports[subpath] !== target) {
      refuse(
        'deps/exports-disagree-with-bundles',
        `declares \`srl.bundles\` for "${subpath}" but its \`exports\` says ` +
          `${JSON.stringify(declaredExports[subpath]) ?? 'nothing'} rather than ${target}. A ` +
          `consumer installing the package cannot reach a layer the browser resolves.`,
        { file: MANIFEST_FILE },
      );
    }
  }
  for (const [subpath, target] of Object.entries(declaredExports).flatMap(([subpath, target]) =>
    exportTargets(target).map((resolved) => /** @type {[string, string]} */ ([subpath, resolved])),
  )) {
    const file = join(PACKAGE, target.replace(/\*.*$/u, ''));
    if (await exists(file)) continue;
    // `dist/` is generated, so its absence is "you have not built it yet" rather than
    // "the map is wrong". Saying which is the difference between a one-command fix and
    // a hunt through package.json.
    refuse(
      target.startsWith('./dist/') ? 'deps/exports-unbuilt' : 'deps/exports-missing-target',
      target.startsWith('./dist/')
        ? `exports "${subpath}" from ${target}, which is generated and not there. Run ` +
            `\`npm run package\`; \`npm publish\` without it ships an exports map pointing at ` +
            `files the tarball does not contain.`
        : `exports "${subpath}" from ${target}, which does not exist.`,
      { file: MANIFEST_FILE },
    );
  }
  pass(
    'deps/bundles-cover-prefixes',
    `${String(BUNDLES.length)} bundle(s) cover every browser prefix, and the exports map names them`,
  );

  /**
   * tsconfig paths are the type checker's copy of the same table, and they live in
   * the package — source/tsconfig.base.json — for the same reason the import-map
   * fragment does: a consumer extends one file instead of copying four mappings that
   * are then free to drift. ADR-0068. They stay a literal there because tsc reads
   * that file and not this one, so what this can do is refuse to let the copy differ.
   *
   * Package-relative, not repository-relative. Path targets in an extended config
   * resolve against the file that declares them, which is inside the package wherever
   * it was installed — the whole point of publishing it.
   */
  const baseTsconfigFile = join(PACKAGE, 'tsconfig.base.json');
  if (!(await exists(baseTsconfigFile))) {
    refuse(
      'deps/no-base-tsconfig',
      `does not exist. It is the type checker's half of the published interface, and without it a ` +
        `consumer has nothing to extend and this repository's own tsconfig.json resolves no ` +
        `library prefix at all.`,
      { file: baseTsconfigFile },
    );
  }

  const baseTsconfig = /** @type {{ compilerOptions?: { paths?: Record<string, string[]> } }} */ (
    parseJsonc(await readText(baseTsconfigFile))
  );
  const tsPaths = baseTsconfig.compilerOptions?.paths ?? {};
  for (const [prefix, dir] of Object.entries(SPECIFIER_DIRS)) {
    const pattern = `${prefix}*`;
    const expected = `./${relative(PACKAGE, dir).split(sep).join('/')}/*`;
    const declared = tsPaths[pattern]?.[0];
    if (declared !== expected) {
      refuse(
        'deps/tspath-disagrees',
        `maps "${pattern}" to ${declared ?? 'nothing'}, and the library's import map resolves it ` +
          `to ${expected}. The type checker would validate one set of files and the browser would ` +
          `load another.`,
        { file: baseTsconfigFile },
      );
    }
  }
  for (const pattern of Object.keys(tsPaths)) {
    const prefix = pattern.replace(/\*$/u, '');
    if (SPECIFIER_DIRS[prefix] === undefined) {
      refuse(
        'deps/tspath-unmapped',
        `declares the path "${pattern}", which no import map provides. It type-checks here and ` +
          `404s in the browser.`,
        { file: baseTsconfigFile },
      );
    }
  }

  /**
   * And this repository extends it rather than keeping its own copy, so the
   * arrangement it type-checks under is the arrangement a consumer gets.
   *
   * `paths` does not merge: a block here would replace the inherited one wholesale
   * and be free to drift, which is exactly what moving the table into the package
   * was meant to end.
   */
  const rootTsconfig =
    /** @type {{ extends?: string, compilerOptions?: { paths?: Record<string, string[]> } }} */ (
      parseJsonc(await readText(ROOT_TSCONFIG))
    );
  const wantedExtends = '@srljs/core/tsconfig.base.json';
  if (rootTsconfig.extends !== wantedExtends) {
    refuse(
      'deps/root-tsconfig-extends',
      `extends ${rootTsconfig.extends ?? 'nothing'} rather than "${wantedExtends}". This ` +
        `repository is supposed to type-check through the same file it publishes.`,
      { file: ROOT_TSCONFIG },
    );
  } else if (rootTsconfig.compilerOptions?.paths !== undefined) {
    refuse(
      'deps/root-tsconfig-paths',
      `declares its own \`paths\`, which replaces the inherited block rather than adding to it. ` +
        `Delete it: the mappings come from ${show(baseTsconfigFile)}.`,
      { file: ROOT_TSCONFIG },
    );
  } else {
    pass('deps/tspaths', 'tsconfig paths resolve where the import map does, from the package');
  }

  /* ── Per application ───────────────────────────────────────────────────── */

  /**
   * The script-src hash each application's import map needs allowed, filled in by
   * check 5b and reported after the loop. This repository ships no server config,
   * so nothing here compares the hashes against one: the deployment owns its CSP,
   * and what it needs from this check is the value to put in it.
   *
   * @type {Map<string, string>}
   */
  const importMapHashes = new Map();

  /**
   * Check 14's state, at this scope because the answer is about the library rather than
   * about one application: both models scan the same `source/lib` and `source/components`
   * files, and a violation there must be reported once, not once per application.
   */
  const PREFERENCE_OWNER = join(LIB, 'core', 'preferences', 'persistence.js');
  const AUTH_SOURCE = join(LIB, 'auth') + sep;
  /** @type {Set<string>} */
  const storageReported = new Set();
  let storageChecked = 0;

  for (const app of applications) {
    /** Every finding in this block belongs to one application, and says so. */
    const group = app.name;
    const index = { group, file: join(app.dir, 'index.html') };
    const manifestAt = { group, file: join(app.dir, 'app.manifest.json') };

    const indexHtml = await readText(join(app.dir, 'index.html'));
    const { imports, integrity, body: mapBody } = extractImportMap(
      indexHtml,
      `${app.name}/index.html`,
    );
    const manifest = JSON.parse(await readText(join(app.dir, 'app.manifest.json')));

    /* ── 1b. The manifest is admitted by the runtime's own policy ────────── */

    /** @type {import('../../source/lib/core/remotes/types.js').AppManifest | undefined} */
    let admitted;
    try {
      admitted = admitManifest(manifest, {
        url: `${app.name}/app.manifest.json`,
        base: MANIFEST_ORIGIN,
        pins: () => integrity,
      });
      pass(
        'deps/manifest-admitted',
        'admitted by the same policy the browser applies at startup',
        manifestAt,
      );
    } catch (cause) {
      refuse(
        'deps/manifest-refused',
        cause instanceof Error ? cause.message : String(cause),
        manifestAt,
      );
    }

    for (const remote of admitted?.remotes ?? []) {
      const name = remote.name;
      const url = remote.url;

      const entry = urlToFile(app.dir, url);
      if (!(await exists(entry))) {
        refuse('deps/remote-entry-missing', `remote "${name}" entry ${url} does not exist.`, index);
        continue;
      }

      const artifacts = await walk(dirname(entry), /\.js$/u);
      for (const artifact of artifacts) {
        const artifactUrl = fileToUrl(app.dir, artifact);
        if (artifactUrl === null) continue;
        const expected = integrity[artifactUrl];
        if (expected === undefined) {
          refuse(
            'deps/remote-artifact-unpinned',
            `remote "${name}" artifact ${artifactUrl} has no static import-map integrity pin. A ` +
              `relative sub-import must be pinned as well as its entry.`,
            index,
          );
          continue;
        }
        const actual = `sha384-${createHash('sha384')
          .update(await readFile(artifact))
          .digest('base64')}`;
        if (actual !== expected) {
          refuse(
            'deps/remote-artifact-hash',
            `integrity mismatch for remote artifact ${artifactUrl}\n` +
              `    in index.html: ${expected}\n    actual:        ${actual}`,
            index,
          );
        }
      }
      pass(
        'deps/remote-pinned',
        `${name} remote: same-origin, manifest pin matches, ${String(artifacts.length)} ` +
          `artifact(s) pinned`,
        { group },
      );
    }

    /* ── 1. Remote URLs, if any ──────────────────────────────────────────── */

    const remoteUrls = [
      ...new Set(Object.values(imports).filter((url) => url.startsWith('https://'))),
    ];

    if (remoteUrls.length === 0) {
      pass('deps/no-remote-host', 'import map targets no remote host: the bundle is self-contained', {
        group,
      });
    }

    for (const url of remoteUrls) {
      const expected = integrity[url];
      if (expected === undefined) {
        refuse(
          'deps/remote-unhashed',
          `no integrity hash for ${url}. Every remote module must be SRI-pinned, or a compromised ` +
            `CDN can serve arbitrary code into your origin.`,
          index,
        );
        continue;
      }

      if (!/@\d+\.\d+\.\d+[/@]/u.test(url)) {
        refuse(
          'deps/remote-unpinned-version',
          `${url} is not pinned to an exact version. A moving tag or a range means the bytes can ` +
            `change with no diff on our side, which breaks SRI at best and ships unreviewed code ` +
            `at worst.`,
          index,
        );
      }

      const response = await fetch(url);
      if (!response.ok) {
        refuse('deps/remote-unreachable', `${url} returned ${String(response.status)}.`, index);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = bytes.toString('utf8');
      const actual = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

      if (actual !== expected) {
        refuse(
          'deps/remote-hash-mismatch',
          `integrity mismatch for ${url}\n    in index.html: ${expected}\n` +
            `    actual:        ${actual}`,
          index,
        );
        continue;
      }

      if (text.includes('Do NOT use SRI')) {
        refuse(
          'deps/remote-generated-on-demand',
          `${url} is generated on demand by the CDN, which explicitly warns against SRI-pinning ` +
            `it. Use a static published file, or vendor it into this repository.`,
          index,
        );
        continue;
      }

      const subImports = [
        ...new Set(
          [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)]
            .map((match) => match[1])
            .filter((specifier) => specifier !== undefined),
        ),
      ];
      const uncovered = subImports.filter(
        (specifier) => !specifier.startsWith('data:') && imports[specifier] === undefined,
      );

      if (uncovered.length > 0) {
        refuse(
          'deps/remote-not-self-contained',
          `${url} is not self-contained. It loads ${String(uncovered.length)} module(s) that the ` +
            `integrity map does not cover:\n      ${uncovered.join('\n      ')}`,
          index,
        );
        continue;
      }

      pass('deps/remote-verified', `${url}  static, exact, self-contained, hash matches`, { group });
    }

    /* ── 2. Vendored files are present and hashed ────────────────────────── */

    const vendored = [
      ...new Set(Object.values(imports).filter((url) => url.startsWith('/lib/vendor/'))),
    ];

    for (const url of vendored) {
      if (!(await exists(urlToFile(app.dir, url)))) {
        refuse(
          'deps/vendored-missing',
          `import map points at ${url}, which does not exist. Run \`npm run vendor -- --fetch\`.`,
          index,
        );
        continue;
      }
      if (integrity[url] === undefined) {
        refuse(
          'deps/vendored-unhashed',
          `${url} has no integrity hash in index.html. Vendoring without a hash trades a CDN you ` +
            `do not control for a folder that can be edited silently; the hash is what makes the ` +
            `vendored copy a control. Add one to the \`integrity\` block.`,
          index,
        );
        continue;
      }
      pass('deps/vendored-pinned', `${url.padEnd(36)} present and integrity-pinned`, { group });
    }

    // The Tailwind development build is a classic script, so it is not in the import
    // map and carries its hash as an attribute instead.
    for (const tag of indexHtml.matchAll(/<script\b[^>]*\ssrc=["'](\/lib\/vendor\/[^"']+)["'][^>]*>/gu)) {
      const src = tag[1];
      if (src === undefined) continue;
      if (!/\sintegrity=/u.test(tag[0])) {
        refuse(
          'deps/script-unpinned',
          `<script src="${src}"> has no integrity attribute.`,
          index,
        );
      } else {
        pass('deps/vendored-pinned', `${src.padEnd(36)} present and integrity-pinned`, { group });
      }
    }

    /* ── 6. The import map agrees with the directory structure ───────────── */

    for (const [prefix, dir] of Object.entries(LIBRARY_PREFIXES)) {
      const target = imports[prefix];
      if (target === undefined) continue; // An application need not use every layer.
      if (urlToFile(app.dir, target) !== dir + '/' && urlToFile(app.dir, target) !== dir) {
        refuse(
          'deps/prefix-elsewhere',
          `the import map resolves "${prefix}" to ${target}, which is not ${show(dir)}. The ` +
            `library's prefixes must point at source/lib, or the application is silently running ` +
            `a copy of the framework.`,
          index,
        );
      }
    }
    pass('deps/prefixes', 'library prefixes resolve into source/lib', { group });

    /* ── 6b. The map carries the library's published fragment verbatim ───── */

    /**
     * Check 6 says each prefix an application declares points at the library.
     * This says the application declares what the library publishes, entry for
     * entry and hash for hash: the fragment is the interface, and an application
     * that hand-edits one line of it is running a map the library does not.
     *
     * The application's own entries — its remotes, its `/src/` — are untouched
     * here. What is compared is only what the fragment claims.
     */
    for (const [specifier, url] of Object.entries(fragment.imports)) {
      if (imports[specifier] === undefined) {
        refuse(
          'deps/missing-specifier',
          `the import map does not declare "${specifier}". The library publishes it in ` +
            `${show(IMPORT_MAP_FILE)}; an application that omits it 404s on the route that needs it.`,
          index,
        );
      } else if (imports[specifier] !== url) {
        refuse(
          'deps/edited-specifier',
          `the import map resolves "${specifier}" to ${imports[specifier]}, and the library ` +
            `publishes ${url}. Paste ${show(IMPORT_MAP_FILE)} rather than editing the copy.`,
          index,
        );
      }
    }
    for (const [url, hash] of Object.entries(fragment.integrity)) {
      if (integrity[url] !== hash) {
        refuse(
          'deps/edited-hash',
          `${url} is pinned to ${integrity[url] ?? 'nothing'}, and its bytes hash to ${hash}. Run ` +
            `\`npm run importmap\` and paste the result.`,
          index,
        );
      }
    }
    pass('deps/verbatim', 'import map carries the library fragment verbatim', { group });

    /* ── 4. Undeclared bare specifiers in source ─────────────────────────── */

    const prefixes = Object.keys(imports).filter((key) => key.endsWith('/'));
    const appFiles = [
      ...(await walk(join(app.dir, 'src'), /\.js$/u)),
      ...(await walk(join(app.dir, 'remotes'), /\.js$/u)),
    ];
    const checkedFiles = [
      ...appFiles,
      ...libFiles.filter((file) => file.endsWith('.js')),
      ...(await walk(COMPONENTS, /\.js$/u)),
      ...(await walk(join(app.dir, 'test'), /\.js$/u)),
    ];

    for (const file of checkedFiles) {
      // Comments stripped first. The specifier pattern is loose enough to match
      // ordinary English — a doc comment reading `differently ... from "a guard that
      // always allows"` was reported as an undeclared bare specifier — and a check
      // that fires on prose is a check people start ignoring. A commented-out import
      // is not a runtime problem, so nothing is lost.
      const source = withoutComments(await readFile(file, 'utf8'));
      const specifiers = [
        ...source.matchAll(/(?:^|[\s{(,;])(?:import|from)\s*\(?\s*["']([^"']+)["']/gmu),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (specifier === undefined) continue;
        if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
          continue;
        }
        const declared =
          imports[specifier] !== undefined || prefixes.some((p) => specifier.startsWith(p));
        if (!declared) {
          refuse(
            'deps/undeclared-specifier',
            `imports "${specifier}", which ${app.name}'s import map does not declare. It will ` +
              `fail to resolve in the browser.`,
            { group, file },
          );
        }
      }
    }

    pass(
      'deps/declared-specifiers',
      `${String(checkedFiles.length)} source file(s) import only declared specifiers`,
      { group },
    );

    /* ── 5. The CSP hash this application's import map needs ─────────────── */

    /**
     * An import map is an inline script, so a CSP of `script-src 'self'` blocks it.
     * The page then loads, fetches main.js and dies on "Failed to resolve module
     * specifier @core/foundation/reactive.js": a blank page whose error points at
     * module resolution rather than at the header that caused it, with no visible
     * violation in Chrome's console.
     *
     * The hash is of the map's exact text, so any edit to the map changes it. This
     * repository does not own the deployment's CSP and therefore cannot assert the
     * value is present anywhere; what it can do is compute it on every run, so the
     * number to put in `script-src` is never something anyone has to derive by hand.
     */
    const expected = `sha256-${createHash('sha256').update(mapBody, 'utf8').digest('base64')}`;
    importMapHashes.set(app.name, expected);
    pass('deps/csp-hash', `import map needs script-src '${expected}'`, { group });

    /* ── 7. Templates, and the declarations the model could not read ──────── */

    /**
     * One question, one answer. Which elements exist, which markup each renders and which
     * template files are claimed all come from cli/project-model/, which reads the same
     * `defineComponent` declaration the browser reads. This check used to match
     * `/^await defineComponent\(\{...\}\);$/gm` and therefore agreed with the template
     * checker only by luck: a definition indented inside a block, or a `template` key on a
     * continuation line, was invisible to it and visible to the checker.
     */
    const model = await readProject(app);

    for (const problem of projectErrors(model)) {
      refuse('deps/unreadable-declaration', problem.message, { group, file: problem.file });
    }

    const withTemplates = [...model.elements.values()].filter((record) => record.template !== null);
    for (const record of missingTemplates(model)) {
      refuse(
        'deps/missing-template',
        `defines <${record.tag}>, whose template is ${show(String(record.template))}, which does ` +
          `not exist. That is a 404 on one route and nothing anywhere else.\n` +
          `    A template is the module's sibling unless the definition names another with ` +
          `\`template\`, and a component with no markup declares \`template: false\`.`,
        { group, file: record.module },
      );
    }

    pass(
      'deps/templates-resolve',
      `${String(withTemplates.length - missingTemplates(model).length)} component template(s) ` +
        `resolve to a file`,
      { group },
    );

    /* ── 8. No orphaned template ─────────────────────────────────────────── */

    /**
     * A `.html` file beside a component module that no definition claims. Always a
     * leftover from a rename or a deletion, and invisible: the old markup keeps being
     * served, keeps passing every check that reads it, and renders nowhere.
     */
    for (const template of orphanTemplates(model)) {
      refuse(
        'deps/orphan-template',
        `is beside a component module but no component definition claims it. Either a definition ` +
          `lost its template in a rename, or the file is a leftover.`,
        { group, file: template.path },
      );
    }

    /* ── 14. UI preference storage has one owner ─────────────────────────── */

    /**
     * `source/lib/core/preferences/persistence.js` owns synchronous non-auth preference storage:
     * the keying, the schema versions, the migrations and one failure policy. ADR-0015.
     * A second module reaching for `localStorage` itself is what this check makes
     * impossible; theme and locale both used to do it.
     *
     * Exempt, deliberately and by path:
     *
     *  - the owning module, which is where the one `globalThis.localStorage` lives;
     *  - `source/lib/auth/`, because tokens are a different seam with a different threat
     *    model. Its stores hold nothing in web storage today — memory, an HttpOnly cookie,
     *    or a non-extractable IndexedDB key — and the day one needs to, it must not have to
     *    ask the preference module for permission. The exemption is enforced in both
     *    directions: auth may not import the preference store either, because an application
     *    supplies that adapter and a credential must never be handed to it;
     *  - test source, which legitimately asserts what did and did not reach the real
     *    browser store.
     *
     * The references come from the project model's AST rather than a text search, so a
     * module explaining why it does *not* use `localStorage` is not a violation, and
     * `globalThis.localStorage` is.
     */
    for (const record of model.modules.values()) {
      const inLibrary =
        record.path.startsWith(LIB + sep) || record.path.startsWith(COMPONENTS + sep);
      if (!inLibrary || storageReported.has(record.path)) continue;
      storageReported.add(record.path);
      storageChecked += 1;

      // The exemption runs both ways. Auth may keep its own storage decisions, and it may
      // not borrow this one: an application configures the preference store, so a token
      // written through it would be handed to whatever that application supplied. The auth
      // stores' whole interface exists to never expose a credential, and this keeps a
      // convenient import from going around it.
      if (record.path.startsWith(AUTH_SOURCE)) {
        if ([...record.imports.values()].includes(PREFERENCE_OWNER) && !isTestSource(record.path)) {
          refuse(
            'deps/auth-imports-preferences',
            `imports @core/preferences/persistence.js, which is the UI preference store an ` +
              `application may replace with any synchronous adapter.\n` +
              `    Auth state belongs to the @auth/ stores, whose interface authorises a Request ` +
              `and never hands out a credential. Keep the two seams apart.`,
            { file: record.path },
          );
        }
        continue;
      }

      if (
        record.storage.length === 0 ||
        record.path === PREFERENCE_OWNER ||
        isTestSource(record.path)
      ) {
        continue;
      }

      refuse(
        'deps/direct-storage',
        `reaches for browser storage directly: ` +
          `${record.storage.map((access) => `${access.name} at line ${String(access.line)}`).join(', ')}.\n` +
          `    Non-auth UI preferences belong to @core/preferences/persistence.js, which owns the keying, ` +
          `the schema version, the migration and one failure policy. An application that swaps ` +
          `the store must get that swap everywhere, not for some preferences.`,
        // The first access, because a module with three is one edit either way.
        { file: record.path, line: record.storage[0]?.line ?? null },
      );
    }

    /* ── 7b. The optional template bundle, if enabled ────────────────────── */

    if (typeof manifest.templateBundle === 'string') {
      const bundlePath = urlToFile(app.dir, manifest.templateBundle);

      if (!(await exists(bundlePath))) {
        refuse(
          'deps/template-bundle-missing',
          `sets templateBundle "${manifest.templateBundle}", which does not exist. Run ` +
            `\`npm run templates\`, or remove the setting to fetch templates individually.`,
          manifestAt,
        );
      } else {
        // Staleness is the whole risk of pre-bundling, and it is silent: the page
        // renders yesterday's markup and nothing reports it. Comparing bytes is
        // cheap and turns that into a failed build.
        //
        // The set compared is the one the bundler ships — `shippedTemplates`, from the
        // project model — and that is a fix, not a refactor. This check used to walk the
        // four template directories itself and included `source/lib/test/fixtures/*.html`,
        // which cli/delivery/bundle-templates.mjs deliberately leaves out of an application's
        // bundle. Any application that enabled templateBundle would have failed
        // verification with a fixture it was right not to ship.
        const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
        const templates = shippedTemplates(model);

        /** @type {string[]} */
        const stale = [];
        for (const template of templates) {
          const url = String(template.url);
          const bundled = bundle[url];
          if (bundled === undefined) stale.push(`${url} (missing from the bundle)`);
          else if (bundled !== (await readFile(template.path, 'utf8'))) {
            stale.push(`${url} (out of date)`);
          }
        }
        const urls = new Set(templates.map((template) => template.url));
        const orphaned = Object.keys(bundle).filter((url) => !urls.has(url));

        if (stale.length > 0 || orphaned.length > 0) {
          refuse(
            'deps/template-bundle-stale',
            `is out of date. Run \`npm run templates\`.\n      ` +
              [...stale, ...orphaned.map((url) => `${url} (no longer exists)`)].join('\n      '),
            { group, file: bundlePath },
          );
        } else {
          pass(
            'deps/template-bundle',
            `${manifest.templateBundle} matches all ${String(templates.length)} template file(s)`,
            { group },
          );
        }
      }
    } else {
      note(
        'deps/no-template-bundle',
        'templateBundle not enabled, templates are fetched individually',
        { group },
      );
    }

    /* ── 9/10. Message bundles ───────────────────────────────────────────── */

    const defaultLocale = String(manifest.i18n.defaultLocale);
    /** @type {string[]} */
    const supportedLocales = manifest.i18n.supportedLocales.map(String);

    // Every i18n directory this application ships: its own, plus one per remote.
    const bundleDirs = [
      ...new Set(
        (await walk(app.dir, /\.json$/u)).filter((f) => basename(dirname(f)) === 'i18n').map(dirname),
      ),
    ].sort();

    for (const dir of bundleDirs) {
      const label = show(dir);
      const defaultPath = join(dir, `${defaultLocale}.json`);

      if (!(await exists(defaultPath))) {
        refuse(
          'deps/no-default-locale',
          `has no ${defaultLocale}.json. Every locale falls back to the default one key by key, so ` +
            `without it a partial translation renders raw keys.`,
          { group, file: dir },
        );
        continue;
      }

      /** @type {Set<string>} */
      const baseKeys = new Set();
      collectKeys(JSON.parse(await readFile(defaultPath, 'utf8')), '', baseKeys);

      for (const locale of supportedLocales) {
        if (locale === defaultLocale) continue;
        const path = join(dir, `${locale}.json`);
        if (!(await exists(path))) {
          note(
            'deps/locale-absent',
            `${label}/${locale}.json absent, falls back to ${defaultLocale}`,
            { group },
          );
          continue;
        }

        /** @type {Set<string>} */
        const keys = new Set();
        collectKeys(JSON.parse(await readFile(path, 'utf8')), '', keys);

        // A key here but not in the default locale is a typo or a leftover, and it is
        // invisible: it renders correctly in this one language and as a raw key in
        // every other.
        const orphans = [...keys].filter(
          (key) => !baseKeys.has(key) && !isPluralVariant(key, baseKeys),
        );
        if (orphans.length > 0) {
          refuse(
            'deps/orphan-message-key',
            `has ${String(orphans.length)} key(s) absent from ${defaultLocale}.json:\n` +
              `      ${orphans.join('\n      ')}\n` +
              `    Either a typo, or a message renamed in the default locale only.`,
            { group, file: path },
          );
        }

        const missing = [...baseKeys].filter((key) => !keys.has(key));
        pass(
          'deps/locale',
          `${`${label}/${locale}.json`.padEnd(38)} ${String(keys.size).padStart(3)} key(s), ` +
            `${String(missing.length).padStart(3)} untranslated`,
          { group },
        );
      }
    }

    /* ── 11. Every remote has a navigation label ─────────────────────────── */

    /**
     * `ui-nav` derives its remote links from the manifest and asks for
     * `nav.<remote name>`, which is what removes the shell edit from mounting a
     * remote. The cost of that is a new silent failure: a remote whose name has no
     * message key renders the raw key `nav.whatever` in the header, in every locale,
     * and nothing else reports it.
     */
    const shellDefaultBundle = join(app.dir, 'i18n', `${defaultLocale}.json`);

    if (await exists(shellDefaultBundle)) {
      /** @type {Set<string>} */
      const shellKeys = new Set();
      collectKeys(JSON.parse(await readFile(shellDefaultBundle, 'utf8')), '', shellKeys);

      for (const remote of manifest.remotes) {
        const key = `nav.${String(remote.name)}`;
        if (!shellKeys.has(key)) {
          refuse(
            'deps/remote-without-nav-label',
            `remote "${String(remote.name)}" is mounted at ${String(remote.mount)} but ` +
              `i18n/${defaultLocale}.json has no "${key}". ui-nav builds its remote links from the ` +
              `manifest, so the header would show the raw key.`,
            { group, file: shellDefaultBundle },
          );
        }
      }
      pass(
        'deps/nav-labels',
        `${String(manifest.remotes.length)} remote(s) have a nav label`,
        { group },
      );
    }
  }

  /* ── 14. Preference storage, reported once (repository-wide) ───────────── */

  pass(
    'deps/preference-storage',
    `${String(storageChecked)} library and component module(s) leave UI preference storage to ` +
      `@core/preferences/persistence.js`,
    { group: 'preferences' },
  );

  /* ── 15. One documentation surface (repository-wide) ───────────────────── */

  /**
   * A README under source/ is how a manual starts disagreeing with itself: the one nobody
   * is reading goes stale, and it goes stale in the directory somebody edits first. The
   * root README and docs/ own durable documentation, and the contract tables under
   * docs/reference/ are generated from the project model rather than typed. Everything
   * else belongs in a type, a test, or a check like this one.
   */
  const strayDocs = [...(await walk(LIB, /README\.md$/u)), ...(await walk(COMPONENTS, /README\.md$/u))];

  if (strayDocs.length > 0) {
    refuse(
      'deps/stray-documentation',
      `${String(strayDocs.length)} documentation file(s) under source/ duplicate docs/:\n      ` +
        `${strayDocs.map((path) => show(path)).join('\n      ')}\n` +
        `    Move durable facts into the docs/ page that owns the subject and delete the file.`,
      { group: 'documentation' },
    );
  } else {
    pass(
      'deps/one-documentation-surface',
      'no documentation surface under source/ competes with docs/',
      { group: 'documentation' },
    );
  }

  /**
   * The two files a registry page is made of, per published package, which the rule
   * above deliberately does not forbid: they sit at a package root rather than inside
   * `lib/` or `components/`, and they address the consumer who is reading npm rather
   * than this repository. README.md is a package's landing page and has to exist or the
   * listing is blank; LICENSE has to be a copy rather than a link, because a tarball
   * carries no repository around it — so the copy is checked byte for byte instead of
   * trusted.
   *
   * Two packages, so two of each: source/ is @srljs/core and cli/ is @srljs/cli. The
   * second is spelled out rather than discovered, because `workspaces` in the root
   * manifest is a list of directories and this check is about which of them a stranger
   * installs.
   */
  const rootLicense = await readText(join(REPO, 'LICENSE'));
  let publishedPages = 0;

  for (const dir of [PACKAGE, join(REPO, 'cli')]) {
    const readme = join(dir, 'README.md');
    const license = join(dir, 'LICENSE');

    if (!(await exists(readme))) {
      refuse(
        'deps/no-package-readme',
        'is missing, so the package would publish with a blank npm page.',
        { group: 'documentation', file: readme },
      );
    } else if (!(await exists(license))) {
      refuse(
        'deps/no-package-license',
        'is missing: the tarball ships no copy of the MIT grant.',
        { group: 'documentation', file: license },
      );
    } else if ((await readText(license)) !== rootLicense) {
      refuse(
        'deps/package-license-differs',
        `differs from the repository's LICENSE. One project, one grant: copy the root file over it.`,
        { group: 'documentation', file: license },
      );
    } else {
      publishedPages += 1;
    }
  }

  if (publishedPages === 2) {
    pass(
      'deps/package-pages',
      'both packages carry their own README and a LICENSE identical to the root',
      { group: 'documentation' },
    );
  }

  /* ── 5b. The CSP hashes a deployment has to carry ──────────────────────── */

  /**
   * One hash per application, collected so a deployment configuring `script-src`
   * has the whole set in one place rather than one line per application scattered
   * through the run. A deployment that serves more than one of these applications
   * needs every hash listed here; one it omits is a blank page.
   */
  pass(
    'deps/csp-hashes',
    `script-src must allow ${String(importMapHashes.size)} import map hash(es):\n` +
      [...importMapHashes].map(([name, hash]) => `         ${name}  '${hash}'`).join('\n'),
    { group: 'deployment' },
  );

  /* ── 3. Types vs runtime (repository-wide) ─────────────────────────────── */

  const ROOT_MANIFEST = join(REPO, 'package.json');
  const pkg = JSON.parse(await readText(ROOT_MANIFEST));
  /** @type {Record<string, string>} */
  const devDeps = pkg.devDependencies ?? {};

  const provenance = JSON.parse(await readText(join(VENDOR, 'provenance.json')));
  /** @type {Map<string, string>} */
  const vendoredVersions = new Map(
    provenance.files.map((/** @type {Record<string, unknown>} */ entry) => [
      String(entry.package),
      String(entry.version),
    ]),
  );

  /**
   * Specifier in the import map -> npm package whose types must match it. A
   * vendored package absent here is not type-backed: @tailwindcss/browser is a
   * classic script no source file imports, so nothing asks tsc to type it. It is
   * still checked below, for the other two reasons every vendored package is.
   */
  const TYPE_BACKED = {
    lit: 'lit',
    '@preact/signals-core': '@preact/signals-core',
  };

  /** npm package -> the import-map specifier tsc has to type, when there is one. */
  const typedSpecifier = new Map(
    Object.entries(TYPE_BACKED).map(([specifier, packageName]) => [packageName, specifier]),
  );

  /*
   * Every vendored package is a devDependency pinned exactly at the version
   * source/lib/vendor serves. Three things need that, and each breaks on its own:
   *
   *   Types. node_modules is where tsc reads the API the browser will have, so a
   *   different version there validates source against an API that does not ship.
   *   Only the two type-backed specifiers care.
   *   Notices. `npm run vendor` copies each notice out of the LICENSE of the
   *   installed version. An undeclared package has no LICENSE to copy, so the
   *   notice this repository redistributes would be whatever was typed by hand.
   *   The version itself. A caret would let npm resolve something else, and both of
   *   the above would then be checked against bytes that are not the vendored ones.
   */
  for (const entry of provenance.files) {
    const packageName = String(entry.package);
    const vendoredVersion = String(entry.version);
    const specifier = typedSpecifier.get(packageName);
    const declared = devDeps[packageName];

    if (declared === undefined) {
      refuse(
        'deps/vendored-undeclared',
        `No devDependency on ${packageName}, which source/lib/vendor serves at ${vendoredVersion}. ` +
          (specifier === undefined
            ? `Its LICENSE is what \`npm run vendor\` copies the notice from, so without it the ` +
              `notice this repository ships cannot be verified against anything.`
            : `tsc cannot type "${specifier}", and its LICENSE is what \`npm run vendor\` copies ` +
              `the notice from.`),
        { group: 'library', file: ROOT_MANIFEST },
      );
      continue;
    }
    if (/^[\^~]/u.test(declared)) {
      refuse(
        'deps/vendored-range',
        `devDependency ${packageName}@${declared} uses a range. It must be pinned exactly, or ` +
          `npm can install types and a notice for a different version than source/lib/vendor serves.`,
        { group: 'library', file: ROOT_MANIFEST },
      );
      continue;
    }
    if (vendoredVersion !== declared) {
      refuse(
        'deps/vendored-drift',
        `Version drift for ${packageName}:\n    node_modules (package.json): ${declared}\n` +
          `    runtime (vendor/provenance): ${vendoredVersion}`,
        { group: 'library', file: ROOT_MANIFEST },
      );
      continue;
    }
    pass(
      'deps/vendored-version',
      `${packageName.padEnd(22)} ${declared.padEnd(8)} pinned, matches source/lib/vendor`,
      { group: 'library' },
    );
  }

  for (const [specifier, packageName] of Object.entries(TYPE_BACKED)) {
    if (vendoredVersions.has(packageName)) continue;
    refuse(
      'deps/no-provenance-entry',
      `has no entry for ${packageName}, so nothing ties the types tsc reads for "${specifier}" to ` +
        `the bytes the browser gets.`,
      { group: 'library', file: join(VENDOR, 'provenance.json') },
    );
  }

  note(
    'deps/vendor-hashes-elsewhere',
    'vendored byte hashes and notices are verified by `npm run vendor`',
    { group: 'library' },
  );

  /* ── 17. The two packages release together ─────────────────────────────── */

  /**
   * @srljs/cli reads the library's manifest and imports three of its modules, so the
   * pair is one interface split across two tarballs and is pinned to itself rather
   * than to a range. ADR-0067. Four ways that can go wrong, and none of them is
   * visible at runtime in this repository:
   *
   *   - the versions diverge, so a release publishes a toolchain and a library that
   *     were never a pair;
   *   - the peer range stops naming the library's actual version, which is an
   *     unsatisfiable install for everyone and an error for nobody here;
   *   - the toolchain's own pins drift from the ones this repository runs the build
   *     with, so what a consumer gets is a build nobody tested;
   *   - a pin becomes a range, which is the same thing arriving later.
   */
  const CLI_MANIFEST = join(REPO, 'cli', 'package.json');
  const cliManifest =
    /** @type {{ version?: string, peerDependencies?: Record<string, string>, dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} */ (
      JSON.parse(await readText(CLI_MANIFEST))
    );
  const libraryVersion = String(MANIFEST.version);
  const cliVersion = String(cliManifest.version);

  if (cliVersion !== libraryVersion) {
    refuse(
      'deps/version-split',
      `is ${cliVersion} and source/package.json is ${libraryVersion}. The two are released ` +
        `together at one version: the toolchain reads the library's manifest and imports three of ` +
        `its modules, so a pair that was never built together is a build the consumer gets and ` +
        `nobody ran.`,
      { group: 'toolchain', file: CLI_MANIFEST },
    );
  } else {
    pass('deps/one-version', `@srljs/core and @srljs/cli are both ${libraryVersion}`, {
      group: 'toolchain',
    });
  }

  const peer = cliManifest.peerDependencies?.['@srljs/core'];
  if (peer !== libraryVersion) {
    refuse(
      'deps/peer-range',
      `names @srljs/core@${peer ?? 'nothing'} as a peer, and the library is ${libraryVersion}. ` +
        `Exact, not a range: a range would let a consumer pair a template checker with a dialect ` +
        `it does not describe, and the build would pass what the browser then rejects.`,
      { group: 'toolchain', file: CLI_MANIFEST },
    );
  } else {
    pass('deps/peer-exact', `the peer range names the library's own version, exactly`, {
      group: 'toolchain',
    });
  }

  /**
   * And the toolchain's pins are the ones this repository runs. They are `dependencies`
   * there because that package ships them, and devDependencies here because nothing in
   * this repository is shipped; the versions have to be the same number either way.
   */
  for (const [field, declared] of /** @type {Array<[string, Record<string, string>]>} */ ([
    ['dependencies', cliManifest.dependencies ?? {}],
    ['devDependencies', cliManifest.devDependencies ?? {}],
  ])) {
    for (const [name, version] of Object.entries(declared)) {
      if (/^[\^~]/u.test(version)) {
        refuse(
          'deps/toolchain-range',
          `pins ${name}@${version} as a range. The point of publishing the toolchain is that a ` +
            `consumer gets the versions it was tested against; a range hands that decision back ` +
            `to their lockfile.`,
          { group: 'toolchain', file: CLI_MANIFEST },
        );
        continue;
      }
      if (devDeps[name] !== version) {
        refuse(
          'deps/toolchain-drift',
          `declares ${name}@${version} in \`${field}\` and the root devDependencies say ` +
            `${devDeps[name] ?? 'nothing'}. This repository would run the build against one ` +
            `version and publish another.`,
          { group: 'toolchain', file: CLI_MANIFEST },
        );
        continue;
      }
      pass(
        'deps/toolchain-pin',
        `${name.padEnd(22)} ${version.padEnd(8)} matches the root devDependency`,
        { group: 'toolchain' },
      );
    }
  }


  return found;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

/**
 * Strip comments before matching source patterns.
 *
 * Needed for two checks, for the same reason both times: this file's patterns
 * describe code and a doc comment is prose that can look like code.
 * component.js and signal-element.js both document what a definition looks like, so
 * without this the template check reports templates that were never meant to
 * exist — and the definition pattern is anchored to the start of a line for the
 * same reason, since an error message quotes the call too; remote-host.js contains
 * the words `from "a guard that always allows"`, which the specifier check read as
 * an undeclared dependency. Both were found by running it.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '');
}

/**
 * tsconfig.json is JSONC, and JSON.parse is not.
 *
 * Not `withoutComments` above: a glob is a string containing `/**`, so the
 * regex that is right for JavaScript eats `"source/**\/*.d.ts"` and leaves
 * invalid JSON behind. Tracking string state is the difference between the two,
 * and it is why this is a scanner rather than a third regex.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let comment = /** @type {'' | 'line' | 'block'} */ ('');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (comment === 'line') {
      if (char === '\n') {
        comment = '';
        out += char;
      }
      continue;
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = '';
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && (next === '/' || next === '*')) {
      comment = next === '/' ? 'line' : 'block';
      index += 1;
      continue;
    }
    out += char;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1'));
}

/**
 * Flatten nested message JSON exactly as the runtime does, so the two agree on
 * what a key is. Keys beginning with `$` are comments and never reach the table.
 *
 * @param {unknown} value
 * @param {string} prefix
 * @param {Set<string>} into
 */
function collectKeys(value, prefix, into) {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'string' || typeof child === 'number') into.add(path);
    else collectKeys(child, path, into);
  }
}

/**
 * Plural categories are per language: Arabic declares `zero`/`two`/`few`/`many`
 * for a key English only needs `one`/`other` for. Those are not orphans.
 *
 * @param {string} key
 * @param {Set<string>} baseKeys
 * @returns {boolean}
 */
function isPluralVariant(key, baseKeys) {
  const match = /^(.*)\.(zero|one|two|few|many|other)$/u.exec(key);
  if (match?.[1] === undefined) return false;
  const stem = match[1];
  return [...baseKeys].some((base) => base === stem || base.startsWith(`${stem}.`));
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, like every other check here, so importing this module stays free of
 * output and exit codes. It was not, and the cost was a suite that could not import
 * `verifyDependencies` without also running it: the sweep ran twice per test process,
 * printed its whole report into the TAP stream, and — because the run is a release
 * gate that refuses a `dist/` that has not been built — set a failing exit code on the
 * importing process before that process had run a line.
 */

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = report(await verifyDependencies(), {
    format: outputFormat(),
    summary: 'All dependency, layering, template and translation checks passed.',
  });
}
