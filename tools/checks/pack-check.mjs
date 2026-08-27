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
 *   4. Scaffold the application with the published `srl new`, so the fixture is not
 *      written here at all: the shape lives in cli/scaffold/application.mjs, the one
 *      module `srl new` and this probe both cross, and a consumer's first command is
 *      the thing under test. ADR-0073.
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
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { error, hasErrors, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
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
 * The application, scaffolded by the published toolchain.
 *
 * This used to be a hundred and eighty lines of fixture: an index.html with the import map
 * pasted and a hash computed, two components with their templates, the stylesheet, the
 * manifest, a locale bundle and a tsconfig. All of it was the shape of a correct srl
 * application, written down in the one place no consumer could reach, which made it a
 * fifth description of a contract the toolchain enforces. It is now
 * cli/scaffold/application.mjs, and this runs it as a consumer does. ADR-0073.
 *
 * Through the bin rather than by import, for the same reason everything else here is:
 * imported, the scaffold would find the library beside `cli/` in this checkout and
 * paste *that* import map. Run inside the probe, it resolves the installed package, and
 * the fixture is made of the bytes actually under test.
 *
 * What stays here is what belongs to the probe rather than to an application: a
 * package.json naming it, and the commit the artifact stamps.
 *
 * @param {string} probe
 * @returns {Promise<Diagnostic[]>}
 */
async function create(probe) {
  await writeFile(
    join(probe, 'package.json'),
    `${JSON.stringify({ name: 'pack-probe', private: true, type: 'module', version: '0.0.0' }, null, 2)}\n`,
  );

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
  await run('git', ['add', '-A'], { cwd: probe });
  await run(
    'git',
    ['-c', 'user.email=pack@check', '-c', 'user.name=pack-check', 'commit', '-qm', 'probe'],
    { cwd: probe },
  );

  return [info('pack/scaffold', `\`srl new ${APP}\` wrote the application`, { group: GROUP })];
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
