/**
 * WebStorm, with the packed plugin installed, opening the fixture projects. ADR-0097.
 *
 * A JetBrains IDE gives an outside observer no way to ask for a completion, so this
 * adapter answers the session scenarios only: whether an installed plugin starts the
 * project's own toolchain, stays quiet about projects that are not srl, and leaves
 * nothing running. The rest of the scenarios are reported `unavailable` rather than
 * silently dropped, which is what makes the gap between the two editors readable.
 *
 * It needs an IDE installed and licensed, so it runs locally rather than in CI:
 *
 *   npm run conformance -- --webstorm
 *
 * `SRL_WEBSTORM_HOME` names the directory holding `MacOS/` or `bin/` when the IDE is not
 * where this looks. The plugins, system and log directories are the run's own, so the only
 * plugin loaded is the one under test; the configuration directory is the IDE's own,
 * because that is where its licence is, and a run therefore leaves the same trace in it
 * that opening a project by hand would. `SRL_WEBSTORM_CONFIG` names another one.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { REPO, exists } from '../../cli/layout.mjs';
import { SCENARIOS } from './scenarios.mjs';

/** @import { AdapterRun, Fixture, RootName, Scenario, ScenarioResult } from './types.js' */

const run = promisify(execFile);

const { census } = /** @type {{ census: (roots: Record<string, string>) => { byRoot: Record<string, number>, total: number } }} */ (
  createRequire(import.meta.url)('./servers.cjs')
);

const PLUGIN_DIR = join(REPO, 'editors', 'webstorm');

/** How long a cold IDE may take to open a project and start the toolchain. */
const PATIENCE = 180_000;

/** How long a project that must start nothing is watched before it is believed. */
const SILENCE = 45_000;

export const name = 'webstorm';

/** The scenarios an outside observer can answer for this editor. */
const COVERED = new Set(['session.start', 'session.silent-roots', 'session.no-orphan']);

/** @param {Scenario} scenario @returns {boolean} */
export function covers(scenario) {
  return COVERED.has(scenario.id);
}

/**
 * One installation, so an edition filter says nothing here: the version is whatever is on
 * this machine.
 *
 * @param {Fixture} fixture
 * @param {Scenario[]} scenarios
 * @returns {Promise<AdapterRun[]>}
 */
export async function drive(fixture, scenarios = SCENARIOS) {
  /** @param {string} version @param {string} detail @returns {AdapterRun[]} */
  const unavailable = (version, detail) => [
    {
      adapter: name,
      edition: 'installed',
      version,
      results: scenarios.map((scenario) => ({ id: scenario.id, status: 'unavailable', detail })),
    },
  ];

  const home = await locate();
  if (home === null) {
    return unavailable('none', 'no WebStorm found; set SRL_WEBSTORM_HOME to the directory holding MacOS/ or bin/');
  }
  const plugin = await packed();
  if (plugin === null) {
    return unavailable(home.version, 'no plugin ZIP; run `mvn -B package` in editors/webstorm');
  }

  const profile = await mkdtemp(join(tmpdir(), 'srl-ws-'));
  try {
    const settings = await configure(profile, home, plugin);
    /** @type {ScenarioResult[]} */
    const results = [];
    for (const scenario of scenarios) {
      results.push(
        covers(scenario)
          ? await one(scenario, fixture, home, settings)
          : {
              id: scenario.id,
              status: 'unavailable',
              detail: 'the platform exposes no way to ask an installed IDE for this from outside it',
            },
      );
    }
    return [{ adapter: name, edition: 'installed', version: home.version, results }];
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/**
 * @param {Scenario} scenario
 * @param {Fixture} fixture
 * @param {{ launcher: string, version: string }} home
 * @param {Record<string, string>} settings
 * @returns {Promise<ScenarioResult>}
 */
async function one(scenario, fixture, home, settings) {
  const env = { ...process.env, ...settings };

  if (scenario.ask === 'orphans') {
    const left = census(fixture.roots).total;
    return { id: scenario.id, status: left === 0 ? 'pass' : 'fail', detail: left === 0 ? '' : `${String(left)} left running` };
  }

  if (scenario.ask === 'servers' && (scenario.expect.silent ?? []).length > 0) {
    for (const root of scenario.expect.silent ?? []) {
      const started = await opened(home.launcher, env, fixture, root, null, SILENCE);
      if (started !== null) return { id: scenario.id, status: 'fail', detail: started };
    }
    return { id: scenario.id, status: 'pass', detail: '' };
  }

  // One project per window: the serving roots are opened one at a time, which is what a
  // WebStorm window is. Multi-root belongs to the other editor.
  for (const root of scenario.expect.serving ?? []) {
    const missing = await opened(home.launcher, env, fixture, root, root, PATIENCE);
    if (missing !== null) return { id: scenario.id, status: 'fail', detail: missing };
  }
  return { id: scenario.id, status: 'pass', detail: '' };
}

/**
 * Open one project, watch for the server it should or should not start, and close the IDE
 * again. Returns null when the expectation held, or the sentence that says it did not.
 *
 * The plugin acts on a file being opened, and a project opened from the command line has
 * no editor tab. The IDE's own URL protocol is what opens one: it is answered by the
 * running instance, so it is fired on every turn of the loop rather than after a guess at
 * how long an IDE takes to start.
 *
 * @param {string} launcher
 * @param {NodeJS.ProcessEnv} env
 * @param {Fixture} fixture
 * @param {RootName} root
 * @param {RootName | null} serving
 * @param {number} patience
 * @returns {Promise<string | null>}
 */
async function opened(launcher, env, fixture, root, serving, patience) {
  const project = fixture.roots[root];
  const ide = spawn(launcher, ['nosplash', project], { env, stdio: 'ignore' });
  try {
    const until = Date.now() + patience;
    for (;;) {
      await navigate(project);
      const found = census(fixture.roots).byRoot[root] ?? 0;
      if (serving !== null && found === 1) return null;
      if (found > (serving === null ? 0 : 1)) {
        return `${root} holds ${String(found)} servers where ${String(serving === null ? 0 : 1)} was expected`;
      }
      if (Date.now() > until) {
        return serving === null ? null : `${root} started no language server within ${String(patience / 1000)}s`;
      }
      await new Promise((done) => setTimeout(done, 5000));
    }
  } finally {
    ide.kill('SIGTERM');
    // The IDE takes the server down with it; give it long enough that the next scenario's
    // census is not reading the last one's processes.
    for (let waited = 0; waited < 30 && census(fixture.roots).total > 0; waited += 1) {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
}

/**
 * Ask the running IDE to open a file in this project. `jetbrains://web-storm/navigate`
 * names the project by directory name, which is what the IDE calls it.
 *
 * Failure is not reported: until the IDE is listening there is nothing to answer, and the
 * caller is already watching for the outcome that matters.
 *
 * @param {string} project
 * @returns {Promise<void>}
 */
async function navigate(project) {
  const relative = ['app/src/main.html', 'index.html'].find((candidate) => existsSync(join(project, candidate)));
  if (relative === undefined) return;
  const url = `jetbrains://web-storm/navigate/reference?project=${basename(project)}&path=${relative}`;
  await run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]).catch(() => undefined);
}

/* ── The installation ──────────────────────────────────────────────────── */

/**
 * The IDE to drive: `SRL_WEBSTORM_HOME`, or the usual place for this platform.
 *
 * @returns {Promise<{ launcher: string, version: string, data: string, properties: string[] } | null>}
 */
async function locate() {
  const candidates = [
    process.env.SRL_WEBSTORM_HOME,
    process.platform === 'darwin' ? '/Applications/WebStorm.app/Contents' : '/opt/webstorm',
  ].filter((path) => typeof path === 'string');

  for (const home of candidates) {
    const launcher = process.platform === 'darwin' ? join(home, 'MacOS', 'webstorm') : join(home, 'bin', 'webstorm.sh');
    const info = process.platform === 'darwin' ? join(home, 'Resources', 'product-info.json') : join(home, 'product-info.json');
    if (!(await exists(launcher)) || !(await exists(info))) continue;
    const product = /** @type {{ version: string, buildNumber: string, dataDirectoryName: string, envVarBaseName: string }} */ (
      JSON.parse(await readFile(info, 'utf8'))
    );
    return {
      launcher,
      version: `${product.version} (${product.buildNumber})`,
      data: product.dataDirectoryName,
      // Both spellings: the launcher reads the product's own prefix, and IDEA_PROPERTIES
      // is the one every JetBrains IDE still honours.
      properties: [`${product.envVarBaseName}_PROPERTIES`, 'IDEA_PROPERTIES'],
    };
  }
  return null;
}

/** The ZIP a user installs from disk. @returns {Promise<string | null>} */
async function packed() {
  const target = join(PLUGIN_DIR, 'target');
  if (!(await exists(target))) return null;
  const zip = (await readdir(target)).find((entry) => entry.startsWith('srl-webstorm-') && entry.endsWith('.zip'));
  return zip === undefined ? null : join(target, zip);
}

/**
 * A profile of this run's own: empty plugins, system and log directories, so the only
 * plugin loaded is the one under test and nothing it writes lands in a real workspace.
 *
 * The configuration directory is not one of them. It holds the IDE's licence, and an IDE
 * that cannot find one shows a dialog instead of opening the project, which would make
 * every scenario fail for a reason that is not the plugin's.
 *
 * @param {string} profile
 * @param {{ data: string, properties: string[] }} home
 * @param {string} plugin
 * @returns {Promise<Record<string, string>>}
 */
async function configure(profile, home, plugin) {
  const plugins = join(profile, 'plugins');
  const system = join(profile, 'system');
  const logs = join(profile, 'log');
  for (const directory of [plugins, system, logs]) await mkdir(directory, { recursive: true });

  await run('unzip', ['-q', '-o', plugin, '-d', plugins]);

  const properties = join(profile, 'idea.properties');
  await writeFile(
    properties,
    [
      `idea.config.path=${await configuration(home)}`,
      `idea.plugins.path=${plugins}`,
      `idea.system.path=${system}`,
      `idea.log.path=${logs}`,
      // A project the IDE has not been told to trust is opened with everything that runs
      // code switched off, this plugin included, and the dialog that asks is a dialog
      // nothing here can answer.
      'idea.trust.all.projects=true',
      '',
    ].join('\n'),
  );
  return Object.fromEntries(home.properties.map((variable) => [variable, properties]));
}

/** Where this IDE keeps its settings. @param {{ data: string }} home @returns {Promise<string>} */
async function configuration(home) {
  const named = process.env.SRL_WEBSTORM_CONFIG;
  if (typeof named === 'string' && named !== '') return named;
  const installed =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'JetBrains', home.data)
      : join(homedir(), '.config', 'JetBrains', home.data);
  if (!(await exists(installed))) throw new Error(`no IDE configuration at ${installed}; set SRL_WEBSTORM_CONFIG`);
  return installed;
}
