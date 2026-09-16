/**
 * Both tarballs, installed the way a stranger installs them, driven end to end.
 *
 *   node tools/checks/pack-check.mjs [--keep]
 *
 * Every other check in this repository runs against the checkout, where `cli/` is a
 * sibling of `source/` and both are inside the repository the tools operate on. A
 * consumer has none of that. The two packages are real directories under
 * `node_modules`, the repository is the working directory, and `@srljs/core/lib/...` is
 * a resolver question rather than a relative path.
 *
 * That difference has already broken the build once. An import-map resolver that skips
 * every importer under `node_modules` is right while the library is a sibling directory
 * and wrong the moment it is installed, because it hands every `@core/` import in the
 * framework to a resolver that cannot see an import map. Nothing in the checkout can
 * notice, because in the checkout the condition is false. ADR-0067, ADR-0068.
 *
 * So this builds the layout instead of assuming it. tools/fixtures/installed-layout.mjs
 * declares every dependency a first application needs, packs both workspaces and gives
 * their tarballs to a real offline `npm install`. The probe then does four things.
 *
 *   1. Scaffolds the application with the published `srl new`, through the same
 *      local-bin command the install guide gives an adopter, so the fixture is not
 *      written here at all. The shape lives in cli/scaffold/application.mjs, the one
 *      module `srl new` and this probe both cross, and a consumer's first command is
 *      the thing under test. ADR-0073.
 *   2. Runs the toolchain against it through the published `srl` bin, covering the
 *      import-map check, the template checker and the build.
 *   3. Typechecks a consumer of the other audience, a bundler user with no import map,
 *      against nothing but the package's `exports`. ADR-0066.
 *   4. Typechecks a strict consumer of the import-map audience as one whole program,
 *      importing every library module through the published tsconfig base. It allows
 *      no diagnostic anywhere, the package's own included, and no library JavaScript
 *      in the program where a declaration belongs. ADR-0066.
 *
 * It does not cover remotes, i18n or the release transport. Those are checked in the
 * checkout, and none of them is where the installed shape differs.
 *
 * Every step's verdict is a `Diagnostic`, and cli/diagnostics/index.mjs prints them.
 * The probe is expensive enough that a caller wanting to know which step failed should
 * not have to scrape a terminal for it. ADR-0072, ADR-0098.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { error, hasErrors, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { exists, walk } from '../../cli/layout.mjs';
import { applicationManifest, install, localBin, srl } from '../fixtures/installed-layout.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */

const run = promisify(execFile);
const APP = 'app';

/** The heading every finding here sits under: there is one subject, the probe. */
const GROUP = 'packaged install';

/** @param {string} code @param {string} message @returns {Diagnostic} */
function refuse(code, message) {
  return error(code, message, { group: GROUP });
}

/**
 * The application, scaffolded by the published toolchain.
 *
 * As a fixture written here it would be a hundred and eighty lines, an index.html with
 * the import map pasted and a hash computed, two components with their templates, the
 * stylesheet, the manifest, a locale bundle and a tsconfig. That is the shape of a
 * correct srl application, written down in the one place no consumer could reach, which
 * would make it a fifth description of a contract the toolchain enforces. It lives in
 * cli/scaffold/application.mjs, and this runs it as a consumer does. ADR-0073.
 *
 * Through the local bin rather than by import, for the same reason everything else here
 * is. Imported, the scaffold would find the library beside `cli/` in this checkout and
 * paste that import map. Run inside the probe, it resolves the installed package, and
 * the fixture is made of the bytes actually under test.
 *
 * @param {string} probe
 * @returns {Promise<Diagnostic[]>}
 */
async function create(probe) {
  const scaffold = await srl(probe, ['new', APP]);
  if (scaffold.code !== 0) {
    return [
      refuse(
        'pack/scaffold-failed',
        `\`srl new ${APP}\` failed in an installed layout:\n\n${indent(scaffold.output)}`,
      ),
    ];
  }

  // The artifact stamps the commit it was built from, so the probe has to be one.
  await run('git', ['init', '-q', '.'], { cwd: probe });
  await run('git', ['add', 'package.json', 'tsconfig.json', APP], { cwd: probe });
  await run(
    'git',
    ['-c', 'user.email=pack@check', '-c', 'user.name=pack-check', 'commit', '-qm', 'probe'],
    { cwd: probe },
  );

  return [info('pack/scaffold', `\`srl new ${APP}\` wrote the application`, { group: GROUP })];
}

/** Where the typed consumer lives: its own directory, so its tsconfig is nobody else's. */
const TYPED = 'typed-consumer';

/**
 * A TypeScript consumer of the installed package, resolving through `exports` alone.
 *
 * Not an srl application. This one is the second audience, somebody with a bundler and
 * no import map, and the question is whether `import { … } from '@srljs/core'` carries
 * types when the only thing pointing at them is the package's own map. The tsconfig
 * therefore extends nothing, declares no `paths`, and names no directory in this
 * checkout, because an alias here would answer the question with the arrangement it is
 * asking about. ADR-0066.
 *
 * The two `@ts-expect-error` lines are the assertion, and they are stronger than a
 * passing typecheck. tsc fails an unused directive, so a declaration that resolved to
 * `any`, or did not resolve at all, refuses the run rather than sailing through it.
 *
 * @param {string} probe
 * @returns {Promise<void>}
 */
async function writeTypedConsumer(probe) {
  const dir = join(probe, TYPED);
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          strict: true,
          target: 'es2022',
          lib: ['es2023', 'dom', 'dom.iterable'],
          module: 'esnext',
          moduleResolution: 'bundler',
          types: [],
          skipLibCheck: true,
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    join(dir, 'consumer.ts'),
    [
      "import { defineComponent, tagOf } from '@srljs/core';",
      "import { UiTable } from '@srljs/core/components';",
      '',
      'export const tag: string = tagOf(UiTable);',
      '',
      '// @ts-expect-error `tagOf` takes a component reference, and a number is not one.',
      'tagOf(42);',
      '',
      '// @ts-expect-error a spec with no tag, element or module is not a component.',
      'void defineComponent({});',
      '',
    ].join('\n'),
  );
}

/** Where the strict consumer lives, for the same reason the typed one has a directory. */
const STRICT = 'strict-consumer';

/** The one JavaScript subpath the strict consumer imports, and the reason the base keeps depth 1. */
const HARNESS = './testing/harness.js';

/**
 * A strict consumer of the import-map audience, typechecked as one whole program.
 *
 * `srl new` writes a tsconfig with `strict` off, which is not what an application runs.
 * This one extends the same published base with `strict` on, `skipLibCheck` off and
 * `@types/node` loaded. Whatever the program reads from this package is then checked
 * under the consumer's options, and the typecheck passes only with no diagnostics at all.
 *
 * Its module re-exports every module under every prefix the installed manifest declares,
 * by the specifier an application writes, plus the test harness by its subpath. A module
 * the scaffold happens not to import is covered all the same, so a missing declaration or
 * a type that fails under `strict` refuses the run. ADR-0066.
 *
 * Importing every module directly also puts each one a single import from the consumer,
 * where `maxNodeModuleJsDepth` never elides anything. A clean typecheck therefore cannot
 * tell a declaration from a module tsc read as JavaScript, so the caller lists the
 * program's files too, and `javascript` names the library files it may find there.
 *
 * The two `@ts-expect-error` lines prove the imports are typed rather than `any`, for the
 * reason given on the typed consumer above.
 *
 * @param {string} probe
 * @returns {Promise<{ modules: number, javascript: string[] }>} How many library modules
 *   the consumer imports, and the package files behind the JavaScript subpaths among them.
 */
async function writeStrictConsumer(probe) {
  const dir = join(probe, STRICT);
  await mkdir(dir, { recursive: true });

  const installed = join(probe, 'node_modules', '@srljs', 'core');
  const manifest =
    /** @type {{ exports?: Record<string, unknown>, srl?: { imports?: Record<string, string> } }} */ (
      JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    );

  /** @type {string[]} */
  const specifiers = [];
  for (const [prefix, tree] of Object.entries(manifest.srl?.imports ?? {})) {
    const root = join(installed, tree);
    for (const file of await walk(root, /\.js$/u)) {
      specifiers.push(`${prefix}${relative(root, file).split(sep).join('/')}`);
    }
  }
  specifiers.sort();

  await writeFile(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '@srljs/core/tsconfig.base.json',
        compilerOptions: { strict: true, noUncheckedIndexedAccess: true, types: ['node'] },
        include: ['consumer.js'],
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    join(dir, 'consumer.js'),
    [
      ...specifiers.map((specifier, index) => `export * as module${String(index)} from '${specifier}';`),
      `export * as harness from '@srljs/core/${HARNESS.slice(2)}';`,
      '',
      "import { defineComponent } from '@core/elements/component.js';",
      `import { settled } from '@srljs/core/${HARNESS.slice(2)}';`,
      '',
      '// @ts-expect-error a spec with no tag, element or module is not a component.',
      'void defineComponent({});',
      '',
      '// @ts-expect-error `settled` waits on an element, and a number is not one.',
      'void settled(42);',
      '',
    ].join('\n'),
  );

  const harness = manifest.exports?.[HARNESS];
  return {
    modules: specifiers.length,
    javascript: typeof harness === 'string' ? [`@srljs/core/${harness.replace(/^\.\//u, '')}`] : [],
  };
}

/**
 * Drive the probe, and say what each step found.
 *
 * @param {string} probe
 * @returns {Promise<Diagnostic[]>}
 */
async function check(probe) {
  /* ── The two facts that have to be found rather than written down ─────── */

  const resolved = await srl(probe, ['layout', '--apps']);
  if (resolved.code !== 0 || resolved.output.trim() !== APP) {
    // Nothing below can mean anything if the repository was not located.
    return [
      refuse(
        'pack/layout-not-found',
        `\`srl layout --apps\` found ${JSON.stringify(resolved.output.trim())} rather than ` +
          `"${APP}". Installed, the repository is the working directory; a default that pointed ` +
          `at the package's own parent would find no application at all.\n${resolved.output}`,
      ),
    ];
  }

  /** @type {Diagnostic[]} */
  const found = [];

  /* ── Each tool, through the published bin ─────────────────────────────── */

  for (const [label, args] of /** @type {Array<[string, string[]]>} */ ([
    ['srl check importmap', ['check', 'importmap']],
    ['srl check templates', ['check', 'templates']],
    ['srl build', ['build', '--app', APP]],
  ])) {
    const result = await srl(probe, args);
    if (result.code === 0) {
      found.push(info('pack/tool', label, { group: GROUP }));
      continue;
    }
    found.push(
      refuse(
        'pack/tool-failed',
        `\`${label}\` failed in an installed layout:\n\n${indent(result.output)}`,
      ),
    );
  }

  /* ── The bundled path carries its types ───────────────────────────────── */

  await writeTypedConsumer(probe);
  const typed = await localBin(probe, 'tsc', ['-p', join(TYPED, 'tsconfig.json')]);
  if (typed.code === 0) {
    found.push(
      info('pack/typed', 'a TypeScript consumer resolves the bundles and their declarations', {
        group: GROUP,
      }),
    );
  } else {
    found.push(
      refuse(
        'pack/untyped',
        `a TypeScript consumer of the installed package did not typecheck. Either \`exports\` ` +
          `resolves no declaration for a bundle, or the declaration it resolves is not the one ` +
          `the JavaScript describes:\n\n${indent(typed.output)}`,
      ),
    );
  }

  /* ── The buildless path carries its types, under strict ───────────────── */

  const consumer = await writeStrictConsumer(probe);
  const project = join(STRICT, 'tsconfig.json');
  const strict = await localBin(probe, 'tsc', ['-p', project]);
  const listed = await localBin(probe, 'tsc', ['-p', project, '--listFilesOnly']);
  const javascript = listed.output
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file.includes('/node_modules/@srljs/core/') && file.endsWith('.js'))
    .filter((file) => !consumer.javascript.some((allowed) => file.endsWith(`/node_modules/${allowed}`)));

  if (consumer.modules === 0) {
    found.push(
      refuse(
        'pack/strict-empty',
        `the installed manifest's \`srl.imports\` led to no module, so the strict consumer ` +
          `imported nothing and its typecheck proves nothing.`,
      ),
    );
  } else if (strict.code !== 0 || listed.code !== 0) {
    found.push(
      refuse(
        'pack/strict-failed',
        `a strict program extending the published tsconfig base did not typecheck. Either a ` +
          `module has no declaration under dist/types/, or a type the library publishes fails ` +
          `under a consumer's options:\n\n${indent(`${strict.output}${listed.code === 0 ? '' : listed.output}`)}`,
      ),
    );
  } else if (javascript.length > 0) {
    found.push(
      refuse(
        'pack/strict-read-javascript',
        `the strict consumer's program read ${String(javascript.length)} of the library's ` +
          `JavaScript module(s) where a declaration belongs. A consumer that imports less than ` +
          `everything then gets TS7016 inside the package for whatever lies past ` +
          `\`maxNodeModuleJsDepth\`. The published tsconfig base has to resolve every prefix ` +
          `into dist/types/:\n\n${indent(javascript.join('\n'))}`,
      ),
    );
  } else {
    found.push(
      info(
        'pack/strict',
        `a strict consumer of all ${String(consumer.modules)} library module(s) typechecks with ` +
          `no diagnostics, reading declarations only`,
        { group: GROUP },
      ),
    );
  }

  /* ── The artifact is real, and is the installed library's ─────────────── */

  const reportPath = join(probe, 'dist', APP, 'artifact.json');
  if (!(await exists(reportPath))) {
    found.push(
      refuse('pack/no-artifact', `the build wrote no ${join('dist', APP, 'artifact.json')}.`),
    );
    return found;
  }

  const artifact = /** @type {{ chunks?: Array<{ modules?: string[] }> }} */ (
    JSON.parse(await readFile(reportPath, 'utf8'))
  );
  const modules = (artifact.chunks ?? []).flatMap((chunk) => chunk.modules ?? []);
  const fromPackage = modules.filter((module) => module.includes('node_modules/@srljs/core/'));

  if (fromPackage.length === 0) {
    found.push(
      refuse(
        'pack/foreign-framework',
        `the artifact names ${String(modules.length)} source module(s) and none of them is in ` +
          `the installed package. The build resolved the framework from somewhere else, which ` +
          `is the two-copies problem this arrangement exists to end.`,
      ),
    );
  } else {
    found.push(
      info(
        'pack/from-package',
        `${String(fromPackage.length)} of ${String(modules.length)} artifact module(s) come from ` +
          `the installed package`,
        { group: GROUP },
      ),
    );
  }

  return found;
}

/** @param {string} text */
function indent(text) {
  return text
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')
    .trimEnd();
}

/**
 * Build the probe, drive it, and take it down again.
 *
 * @param {{ keep?: boolean }} [options]
 * @returns {Promise<Diagnostic[]>}
 */
export async function checkPackagedInstall(options = {}) {
  const probe = await mkdtemp(join(tmpdir(), 'srl-pack-'));

  /** @type {Diagnostic[]} */
  const found = [info('pack/probe', probe, { group: GROUP })];
  try {
    await writeFile(join(probe, 'package.json'), applicationManifest('pack-probe'));
    try {
      await install(probe);
      found.push(
        info('pack/install', '`npm install` resolved only the declared dependencies', {
          group: GROUP,
        }),
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      found.push(refuse('pack/install-failed', `the declared dependencies did not install:\n\n${indent(detail)}`));
      return found;
    }

    // A scaffold that refused wrote no application, and every step below would then
    // report the absence of one rather than the reason for it.
    const created = await create(probe);
    found.push(...created);
    if (!hasErrors(created)) found.push(...(await check(probe)));
  } finally {
    if (options.keep === true) {
      found.push(info('pack/kept', `kept for inspection: ${probe}`, { group: GROUP }));
    } else {
      await rm(probe, { recursive: true, force: true });
    }
  }
  return found;
}

process.exitCode = report(await checkPackagedInstall({ keep: process.argv.includes('--keep') }), {
  format: outputFormat(),
  summary: 'Both tarballs install and drive an application end to end.',
});
