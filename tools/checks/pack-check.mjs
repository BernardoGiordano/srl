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
 * packs both workspaces and installs them the way a consumer does. The probe then does
 * six things.
 *
 *   1. Runs the published `srl new` from a launcher install, as `npx @srljs/cli new`
 *      does, and installs the project from the manifest it wrote. The install refuses
 *      a manifest that pins anything but the versions this checkout proves. The shape
 *      lives in cli/scaffold/, which `srl new` and this probe both cross, so a
 *      consumer's first command is the thing under test. ADR-0073, ADR-0122.
 *   2. Adds a styled component with `srl generate component`, puts it on the home
 *      page, and commits with `git add .`, which the scaffolded .gitignore has to keep
 *      out of node_modules and dist.
 *   3. Runs the scaffolded `npm run check` and `npm run build`.
 *   4. Typechecks a consumer of the other audience, a bundler user with no import map,
 *      against nothing but the package's `exports`. ADR-0066.
 *   5. Typechecks a strict consumer of the import-map audience as one whole program,
 *      importing every library module through the published tsconfig base. It allows
 *      no diagnostic anywhere, the package's own included, and no library JavaScript
 *      in the program where a declaration belongs. ADR-0066.
 *   6. Reads the documentation each package ships. Every relative link resolves inside
 *      its package, and every record the package cites is in its own docs/adr/.
 *      ADR-0121.
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
import { linkTarget, relativeLinks } from '../delivery/package-docs.mjs';
import { install, launch, localBin, pack, srl, useComponent } from '../fixtures/installed-layout.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */

const run = promisify(execFile);

/** The project `srl new` writes, and the application it starts with. */
const PROJECT = 'project';
const APP = 'web';

/** The component the probe generates, with a stylesheet so the build has one to scope. */
const COMPONENT = 'user-card';

/** The heading every finding here sits under: there is one subject, the probe. */
const GROUP = 'packaged install';

/** @param {string} code @param {string} message @returns {Diagnostic} */
function refuse(code, message) {
  return error(code, message, { group: GROUP });
}

/**
 * The project, scaffolded and installed by the published toolchain.
 *
 * The launcher runs `srl new` the way npx does, from an install outside the project,
 * so the application must reach the library through the project's own node_modules
 * rather than through the directory the CLI ran from. Written here, the fixture would
 * be a second description of a contract the toolchain enforces. ADR-0073, ADR-0122.
 *
 * Through the installed bin rather than by import. Imported, the scaffold would find the
 * library beside `cli/` in this checkout and paste that import map. Run from the
 * launcher, it reads the installed package, so the fixture is made of the bytes under
 * test.
 *
 * @param {string} probe
 * @param {string[]} tarballs
 * @returns {Promise<Diagnostic[]>}
 */
async function create(probe, tarballs) {
  const launcher = join(probe, 'launcher');
  try {
    await launch(launcher, tarballs);
  } catch (cause) {
    return [refuse('pack/install-failed', `the launcher did not install:\n\n${indent(message(cause))}`)];
  }

  const scaffold = await srl(probe, ['new', PROJECT], { prefix: launcher });
  if (scaffold.code !== 0) {
    return [
      refuse(
        'pack/scaffold-failed',
        `\`srl new ${PROJECT}\` failed from an installed CLI:\n\n${indent(scaffold.output)}`,
      ),
    ];
  }

  const project = join(probe, PROJECT);
  try {
    await install(project, tarballs);
  } catch (cause) {
    return [refuse('pack/install-failed', `the scaffolded project did not install:\n\n${indent(message(cause))}`)];
  }

  /** @type {Diagnostic[]} */
  const found = [
    info('pack/scaffold', `\`srl new ${PROJECT}\` wrote the project`, { group: GROUP }),
    info('pack/install', '`npm install` resolved the scaffolded manifest', { group: GROUP }),
  ];

  const generated = await srl(project, ['generate', 'component', COMPONENT, '--styles']);
  if (generated.code !== 0) {
    found.push(
      refuse(
        'pack/generate-failed',
        `\`srl generate component ${COMPONENT}\` failed in an installed project:\n\n${indent(generated.output)}`,
      ),
    );
    return found;
  }
  await useComponent(project, APP, COMPONENT);
  found.push(
    info('pack/generate', `\`srl generate component ${COMPONENT}\` wrote a styled component`, {
      group: GROUP,
    }),
  );

  // The artifact stamps the commit it was built from, so the project has to be one.
  await run('git', ['init', '-q', '.'], { cwd: project });
  await run('git', ['add', '.'], { cwd: project });
  await run(
    'git',
    ['-c', 'user.email=pack@check', '-c', 'user.name=pack-check', 'commit', '-qm', 'probe'],
    { cwd: project },
  );

  const { stdout } = await run('git', ['ls-files'], { cwd: project });
  const ignored = stdout
    .split('\n')
    .filter((file) => file.startsWith('node_modules/') || file.startsWith('dist/'));
  found.push(
    ignored.length === 0
      ? info('pack/ignored', '`git add .` left node_modules out', { group: GROUP })
      : refuse(
          'pack/committed-dependencies',
          `\`git add .\` committed ${String(ignored.length)} installed or built file(s). The ` +
            `scaffolded .gitignore has to exclude them.`,
        ),
  );
  return found;
}

/**
 * One of the scaffolded project's npm scripts.
 *
 * @param {string} project
 * @param {string} name
 * @returns {Promise<{ code: number, output: string }>}
 */
async function script(project, name) {
  try {
    const { stdout, stderr } = await run('npm', ['run', '--silent', name], { cwd: project });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (cause) {
    const detail = /** @type {{ code?: unknown, stdout?: unknown, stderr?: unknown }} */ (cause);
    return {
      code: typeof detail.code === 'number' ? detail.code : 1,
      output: [detail.stdout, detail.stderr].filter((text) => typeof text === 'string').join(''),
    };
  }
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
 * @param {string} project
 * @returns {Promise<void>}
 */
async function writeTypedConsumer(project) {
  const dir = join(project, TYPED);
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
 * @param {string} project
 * @returns {Promise<{ modules: number, javascript: string[] }>} How many library modules
 *   the consumer imports, and the package files behind the JavaScript subpaths among them.
 */
async function writeStrictConsumer(project) {
  const dir = join(project, STRICT);
  await mkdir(dir, { recursive: true });

  const installed = join(project, 'node_modules', '@srljs', 'core');
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

/** The installed packages, by the directory name under node_modules/@srljs. */
const PACKAGES = ['core', 'cli'];

/** A record citation, in any file a package ships. */
const CITATION = /\bADR-(\d{4})\b/gu;

/**
 * The documentation one installed package carries, held against what it links and cites.
 *
 * Read from the installed files rather than from docs/, because the question is what the
 * tarball holds. A `files` list that dropped `docs` would pass every check in the
 * checkout. ADR-0121.
 *
 * @param {string} project
 * @param {string} name
 * @returns {Promise<Diagnostic[]>}
 */
async function shippedDocs(project, name) {
  const root = join(project, 'node_modules', '@srljs', name);
  const label = `@srljs/${name}`;
  const index = join(root, 'llms.txt');
  if (!(await exists(index))) {
    return [refuse('pack/no-docs', `${label} ships no llms.txt. Run \`npm run package\` before packing.`)];
  }

  const pages = await walk(join(root, 'docs'), /\.md$/u);
  /** @type {Array<[string, string]>} */
  const documents = [['llms.txt', await readFile(index, 'utf8')]];
  for (const page of pages) {
    documents.push([relative(root, page).split(sep).join('/'), await readFile(page, 'utf8')]);
  }

  /** @type {string[]} */
  const broken = [];
  for (const [page, text] of documents) {
    for (const target of relativeLinks(text)) {
      const resolved = linkTarget(page, target);
      if (resolved === null || !(await exists(join(root, resolved)))) broken.push(`${page} -> ${target}`);
    }
  }

  const records = new Set(
    documents.map(([page]) => /^docs\/adr\/(\d{4})-/u.exec(page)?.[1]).filter((number) => number !== undefined),
  );
  /** @type {Set<string>} */
  const cited = new Set();
  for (const file of await walk(root, /\.(?:m?js|ts|html|json)$/u)) {
    for (const match of (await readFile(file, 'utf8')).matchAll(CITATION)) cited.add(match[1] ?? '');
  }
  cited.delete('0000');
  const unresolved = [...cited].filter((number) => !records.has(number)).sort();

  /** @type {Diagnostic[]} */
  const found = [];
  if (broken.length > 0) {
    found.push(
      refuse(
        'pack/docs-broken-link',
        `${label} ships documentation whose links go nowhere once installed:\n\n${indent(broken.join('\n'))}`,
      ),
    );
  }
  if (unresolved.length > 0) {
    found.push(
      refuse(
        'pack/unresolved-citation',
        `${label} cites ${unresolved.map((number) => `ADR-${number}`).join(', ')}, which its docs/adr/ does not hold.`,
      ),
    );
  }
  if (found.length === 0) {
    found.push(
      info(
        'pack/docs',
        `${label} ships ${String(pages.length)} page(s), and its ${String(cited.size)} cited record(s) resolve inside it`,
        { group: GROUP },
      ),
    );
  }
  return found;
}

/**
 * Drive the installed project, and say what each step found.
 *
 * @param {string} project
 * @returns {Promise<Diagnostic[]>}
 */
async function check(project) {
  /* ── The two facts that have to be found rather than written down ─────── */

  const resolved = await srl(project, ['layout', '--apps']);
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

  /* ── The scaffolded scripts, through the published bin ────────────────── */

  for (const name of ['check', 'build']) {
    const result = await script(project, name);
    if (result.code === 0) {
      found.push(info('pack/tool', `npm run ${name}`, { group: GROUP }));
      continue;
    }
    found.push(
      refuse(
        'pack/tool-failed',
        `\`npm run ${name}\` failed in the scaffolded project:\n\n${indent(result.output)}`,
      ),
    );
  }

  /* ── The bundled path carries its types ───────────────────────────────── */

  await writeTypedConsumer(project);
  const typed = await localBin(project, 'tsc', ['-p', join(TYPED, 'tsconfig.json')]);
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

  const consumer = await writeStrictConsumer(project);
  const strictConfig = join(STRICT, 'tsconfig.json');
  const strict = await localBin(project, 'tsc', ['-p', strictConfig]);
  const listed = await localBin(project, 'tsc', ['-p', strictConfig, '--listFilesOnly']);
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

  /* ── Each package carries its documentation ──────────────────────────── */

  for (const name of PACKAGES) found.push(...(await shippedDocs(project, name)));

  /* ── The artifact is real, and is the installed library's ─────────────── */

  const reportPath = join(project, 'dist', APP, 'artifact.json');
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

/** @param {unknown} cause @returns {string} */
function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
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
    let tarballs;
    try {
      tarballs = await pack(join(probe, 'tarballs'));
    } catch (cause) {
      found.push(refuse('pack/pack-failed', `\`npm pack\` failed:\n\n${indent(message(cause))}`));
      return found;
    }

    // A scaffold that refused wrote no project, and every step below would then report
    // the absence of one rather than the reason for it.
    const created = await create(probe, tarballs);
    found.push(...created);
    if (!hasErrors(created)) found.push(...(await check(join(probe, PROJECT))));
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
  summary: 'Both tarballs install, scaffold a project, and check and build it end to end.',
});
