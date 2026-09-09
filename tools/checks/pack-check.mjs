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
 * So this builds the layout instead of assuming it. tools/fixtures/installed-layout.mjs
 * packs both workspaces and extracts them into `node_modules/@srljs/`; the probe then:
 *
 *   1. Scaffolds the application with the published `srl new`, so the fixture is not
 *      written here at all: the shape lives in cli/scaffold/application.mjs, the one
 *      module `srl new` and this probe both cross, and a consumer's first command is
 *      the thing under test. ADR-0073.
 *   2. Runs the toolchain against it through the published `srl` bin: the import-map
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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { error, hasErrors, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { exists } from '../../cli/layout.mjs';
import { install, srl } from '../fixtures/installed-layout.mjs';

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
    await install(probe, { bundled: true });

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
