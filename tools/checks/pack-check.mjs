/**
 * Both tarballs, installed the way a stranger installs them, driven end to end.
 *
 *   node tools/checks/pack-check.mjs [--keep]
 *
 * Every other check in this repository runs against the checkout, where `cli/` is a
 * sibling of `source/` and both are inside the repository the tools operate on. A
 * consumer has none of that: the two packages are real directories under
 * `node_modules`, the repository is the working directory, and `@srljs/core/lib/...`
 * is a resolver question rather than a relative path.
 *
 * That difference has already broken the build once. The import-map resolver skipped
 * every importer under `node_modules`, which was right while the library was a
 * sibling directory and wrong the moment it was installed: it handed every `@core/`
 * import in the framework to a resolver that cannot see an import map. Nothing in
 * the checkout could notice, because in the checkout the condition is false.
 * ADR-0067, ADR-0068.
 *
 * So this builds the layout instead of assuming it:
 *
 *   1. `npm pack` both workspaces — the actual tarballs, so `files` is under test too.
 *   2. Extract them into `node_modules/@srljs/` as real directories. Not symlinks: a
 *      symlink resolves to the checkout and the whole point is lost, because Node
 *      resolves realpaths and every "am I installed?" test would answer no.
 *   3. Symlink every other dependency from this repository's node_modules, so the
 *      probe needs no network and pins nothing of its own.
 *   4. Write the smallest application that exercises the seam, with its import map
 *      pasted from the installed package's own lib/importmap.json — the same thing a
 *      consumer pastes, so no hash in here can go stale.
 *   5. Run the toolchain against it through the published `srl` bin: the import-map
 *      check, the template checker, the build.
 *
 * What it does not cover: remotes, i18n, the release transport. Those are checked in
 * the checkout, and none of them is where the installed shape differs.
 *
 * Every step's verdict is a `Diagnostic`, and cli/diagnostics/index.mjs prints them:
 * the probe is expensive enough that a caller wanting to know which step failed should
 * not have to scrape a terminal for it. ADR-0072.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { error, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { REPO, exists } from '../../cli/layout.mjs';

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
 * Run a command in the probe, capturing both streams. A non-zero exit is data here,
 * not a throw: the point is to report which step failed and what it said.
 *
 * @param {string} probe
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
async function srl(probe, args) {
  const bin = join(probe, 'node_modules', '@srljs', 'cli', 'bin', 'srl.mjs');
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { cwd: probe });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const detail = /** @type {{ code?: unknown, stdout?: unknown, stderr?: unknown }} */ (error);
    return {
      code: typeof detail.code === 'number' ? detail.code : 1,
      output: [detail.stdout, detail.stderr].filter((s) => typeof s === 'string').join(''),
    };
  }
}

/**
 * Pack both workspaces and extract them into the probe's node_modules.
 *
 * @param {string} probe
 * @returns {Promise<void>}
 */
async function install(probe) {
  const tarballs = join(probe, 'tarballs');
  await mkdir(tarballs, { recursive: true });
  await run(
    'npm',
    [
      'pack',
      '--workspace',
      '@srljs/core',
      '--workspace',
      '@srljs/cli',
      '--pack-destination',
      tarballs,
    ],
    { cwd: REPO },
  );

  const scoped = join(probe, 'node_modules', '@srljs');
  for (const [tarball, name] of [
    ['srljs-core-', 'core'],
    ['srljs-cli-', 'cli'],
  ]) {
    const files = await readdir(tarballs);
    const file = files.find((entry) => entry.startsWith(String(tarball)));
    if (file === undefined) throw new Error(`npm pack produced no ${String(tarball)}*.tgz`);
    const target = join(scoped, String(name));
    await mkdir(target, { recursive: true });
    // --strip-components drops the `package/` prefix every npm tarball carries.
    await run('tar', ['xzf', join(tarballs, file), '-C', target, '--strip-components', '1']);
  }

  // Everything else comes from this repository, so the probe pins nothing and downloads
  // nothing: a dependency resolves from its own realpath here exactly as it would from a
  // real install.
  //
  // Mostly by symlink, with one exception that is not cosmetic. A production bundle
  // inlines the library's runtime dependencies from npm rather than from lib/vendor —
  // the vendored copy is the buildless path's, and `npm run verify` is what keeps the
  // two at one version — so those packages end up as modules *in the artifact*, and the
  // artifact records every module's path relative to the repository. A symlink resolves
  // to this checkout, which is outside the probe, and the build refuses it. Correctly: a
  // module it cannot place inside the repository is a module it cannot describe. So the
  // bundled ones are real copies, as the transitive closure rather than a hand-written
  // list, because lit's own layout is lit's business.
  //
  // A scope is a real directory with symlinked packages inside it, never a symlinked
  // directory. Linking the scope would make every path under it a way out of the probe,
  // and a write meant for the copy would land in this repository's node_modules instead.
  const own = join(REPO, 'node_modules');
  const bundled = await bundledClosure(own);

  /** @param {string} name */
  const place = async (name) => {
    const target = join(probe, 'node_modules', name);
    if (bundled.has(name)) await cp(join(own, name), target, { recursive: true, dereference: true });
    else await symlink(join(own, name), target);
  };

  for (const entry of await readdir(own, { withFileTypes: true })) {
    if (entry.name === '@srljs') continue;
    if (!entry.name.startsWith('@')) {
      await place(entry.name);
      continue;
    }
    await mkdir(join(probe, 'node_modules', entry.name), { recursive: true });
    for (const scoped of await readdir(join(own, entry.name))) {
      await place(`${entry.name}/${scoped}`);
    }
  }
}

/**
 * The library's runtime dependencies and everything they depend on, as installed.
 *
 * @param {string} own this repository's node_modules
 * @returns {Promise<Set<string>>}
 */
async function bundledClosure(own) {
  const manifest = /** @type {{ dependencies?: Record<string, string> }} */ (
    JSON.parse(await readFile(join(REPO, 'source', 'package.json'), 'utf8'))
  );
  /** @type {Set<string>} */
  const found = new Set();
  const queue = Object.keys(manifest.dependencies ?? {});

  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || found.has(name)) continue;
    let nested;
    try {
      nested = /** @type {{ dependencies?: Record<string, string> }} */ (
        JSON.parse(await readFile(join(own, name, 'package.json'), 'utf8'))
      );
    } catch {
      // Not installed at the top level: npm nested it under a dependent, where it is
      // already inside the copy that dependent brings along.
      continue;
    }
    found.add(name);
    queue.push(...Object.keys(nested.dependencies ?? {}));
  }
  return found;
}

/**
 * The smallest application that puts the installed package under load: one component
 * with a template, a stylesheet that reaches into the package, and a manifest.
 *
 * @param {string} probe
 * @returns {Promise<void>}
 */
async function writeApplication(probe) {
  const dir = join(probe, APP);
  await mkdir(join(dir, 'src'), { recursive: true });

  // The map is the package's own, pasted. A consumer does exactly this, and it means no
  // specifier and no integrity hash in this file can drift from the library.
  const core = join(probe, 'node_modules', '@srljs', 'core');
  const fragment = await readFile(join(core, 'lib', 'importmap.json'), 'utf8');

  // The development Tailwind build is a classic script, so its hash is an attribute
  // rather than an integrity-map entry, and `srl check importmap` requires one on
  // anything vendored. Computed from the installed bytes for the same reason the map is
  // pasted rather than typed.
  const tailwindHash = `sha384-${createHash('sha384')
    .update(await readFile(join(core, 'lib', 'vendor', 'tailwind-browser.js')))
    .digest('base64')}`;

  // Eight facts, exactly one of each, and the production HTML transform refuses the
  // document otherwise: the two collection stylesheets it replaces with the compiled
  // one, the import map it replaces with pinned chunk URLs, the browser Tailwind and
  // its inline input it replaces with the compiled sheet, the entry module, the root
  // element and the noscript. That contract is the reason this fixture is a whole
  // index.html rather than a stub — a consumer's page has to satisfy it, so the probe's
  // does too. ADR-0041.
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>packaged</title>
    <link rel="stylesheet" href="/components/style.css" />
    <link rel="stylesheet" href="/components/theme-default.css" />
    <script type="importmap">
${fragment.trimEnd()}
    </script>
    <script src="/lib/vendor/tailwind-browser.js" integrity="${tailwindHash}"></script>
    <style type="text/tailwindcss">
      @custom-variant dark ([data-theme='dark'] &);
    </style>
    <script type="module" src="/src/main.js"></script>
  </head>
  <body>
    <app-root></app-root>
    <noscript>This application needs JavaScript.</noscript>
  </body>
</html>
`,
  );

  // A component, a template and a signal: the three things whose types the template
  // checker has to resolve through the installed package rather than a relative path.
  //
  // Two modules, and the second is reached by `import()`, because the build refuses an
  // artifact with fewer than two JavaScript chunks — an application with nothing lazy is
  // one whose entry carries every route, which is the shape the chunking exists to
  // avoid. It is also the interesting case here: a lazy chunk is where a second copy of
  // the framework would show up if the library resolved twice.
  await writeFile(
    join(dir, 'src', 'main.js'),
    `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { signal } from '@core/foundation/reactive.js';

export class AppRoot extends SignalElement {
  #count = signal(0);

  get count() {
    return this.#count.value;
  }

  increment() {
    this.#count.value += 1;
  }

  async open() {
    await import('./detail.js');
  }
}

await defineComponent({
  tag: 'app-root',
  element: AppRoot,
  module: import.meta.url,
});
`,
  );

  await writeFile(
    join(dir, 'src', 'main.html'),
    `<button type="button" (click)="increment()" class="font-semibold">{{ count }}</button>
<button type="button" (click)="open()">open</button>
`,
  );

  await writeFile(
    join(dir, 'src', 'detail.js'),
    `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';

export class AppDetail extends SignalElement {
  get title() {
    return 'detail';
  }
}

await defineComponent({
  tag: 'app-detail',
  element: AppDetail,
  module: import.meta.url,
});
`,
  );

  await writeFile(join(dir, 'src', 'detail.html'), `<h1>{{ title }}</h1>\n`);

  // Reaching into the package by node_modules path is what an application's own
  // stylesheet does, and getting it wrong is a Tailwind resolve error rather than
  // anything the build would otherwise catch.
  await writeFile(
    join(dir, 'src', 'app.css'),
    `@import '../../node_modules/@srljs/core/components/style.css';
@import '../../node_modules/@srljs/core/components/theme-default.css';
@import 'tailwindcss' source(none);

@source '../src/**/*.js';
@source '../src/**/*.html';
@source '../index.html';
`,
  );

  // The three frozen top-level fields, at their smallest admissible values: one locale
  // with one bundle, no API origin, no remotes. The manifest policy that admits this is
  // the library's own — the same module the browser runs at startup — so a shape it
  // would refuse fails here rather than in a page.
  await mkdir(join(dir, 'i18n'), { recursive: true });
  await writeFile(join(dir, 'i18n', 'en.json'), `${JSON.stringify({}, null, 2)}\n`);
  await writeFile(
    join(dir, 'app.manifest.json'),
    `${JSON.stringify(
      {
        auth: { apiBaseUrl: '/api' },
        i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: ['/i18n/{locale}.json'] },
        remotes: [],
      },
      null,
      2,
    )}\n`,
  );

  // Extending the published base is the documented setup, and the only way `@core/`
  // resolves for tsc. A consumer who copied four path mappings instead would have a
  // second table to keep in step; this asserts the first one works.
  await writeFile(
    join(probe, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '@srljs/core/tsconfig.base.json',
        compilerOptions: { types: ['node'] },
        include: [`${APP}/**/*.js`],
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    join(probe, 'package.json'),
    `${JSON.stringify({ name: 'pack-probe', private: true, type: 'module', version: '0.0.0' }, null, 2)}\n`,
  );

  // The artifact stamps the commit it was built from, so the probe has to be one.
  await run('git', ['init', '-q', '.'], { cwd: probe });
  await run('git', ['add', '-A'], { cwd: probe });
  await run(
    'git',
    ['-c', 'user.email=pack@check', '-c', 'user.name=pack-check', 'commit', '-qm', 'probe'],
    { cwd: probe },
  );
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
    await mkdir(join(probe, 'node_modules'), { recursive: true });
    await install(probe);
    await writeApplication(probe);
    found.push(...(await check(probe)));
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
