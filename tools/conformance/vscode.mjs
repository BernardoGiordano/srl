/**
 * VS Code, downloaded, installed from the packed VSIX, and driven. ADR-0097.
 *
 * Two editions: the oldest the extension claims to support and the current stable one. A
 * claim in `engines.vscode` that nothing runs against is a claim, and the two versions
 * are where the platform's API drift shows up.
 *
 * Each run gets its own user-data and extensions directory, so what the editor knows is
 * the fixture and the extension, and nothing a developer's own profile carries.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { REPO, exists } from '../../cli/layout.mjs';
import { SCENARIOS } from './scenarios.mjs';

/** @import { AdapterRun, Fixture, Scenario, ScenarioResult } from './types.js' */

const run = promisify(execFile);

/** The census both the driver and the probe read. */
const { census } = /** @type {{ census: (roots: Record<string, string>) => { byRoot: Record<string, number>, total: number } }} */ (
  createRequire(import.meta.url)('./servers.cjs')
);

const EXTENSION_DIR = join(REPO, 'editors', 'vscode');
const PROBE = join(REPO, 'tools', 'conformance', 'probe');

/** Downloads survive between runs: an editor is 130 MB and the version is pinned. */
const CACHE = join(REPO, 'node_modules', '.cache', 'srl-editor-conformance');

/** The whole editor run, including a cold compiler on two projects. */
const PATIENCE = 15 * 60 * 1000;

export const name = 'vscode';

/** Every scenario: this adapter drives the editor's own providers. @param {Scenario} _scenario */
export function covers(_scenario) {
  return true;
}

/**
 * @param {Fixture} fixture
 * @param {Scenario[]} scenarios
 * @param {{ editions?: string[] }} [options] which editions to drive, when a caller wants
 *   one of them: a CI matrix runs them as separate jobs.
 * @returns {Promise<AdapterRun[]>}
 */
export async function drive(fixture, scenarios = SCENARIOS, options = {}) {
  const wanted = options.editions;
  const chosen = (await editions()).filter(({ edition }) => wanted === undefined || wanted.includes(edition));
  if (chosen.length === 0) return [];

  const packed = await pack();
  /** @type {AdapterRun[]} */
  const runs = [];
  for (const { edition, version } of chosen) {
    runs.push(await one(fixture, scenarios, packed, edition, version));
  }
  return runs;
}

/**
 * @param {Fixture} fixture
 * @param {Scenario[]} scenarios
 * @param {string} packed
 * @param {string} edition
 * @param {string} version
 * @returns {Promise<AdapterRun>}
 */
async function one(fixture, scenarios, packed, edition, version) {
  /** @param {string} detail @returns {AdapterRun} */
  const unavailable = (detail) => ({
    adapter: name,
    edition,
    version,
    results: scenarios.map((scenario) => ({ id: scenario.id, status: 'unavailable', detail })),
  });

  /** @type {{ electron: string, cli: string }} */
  let editor;
  try {
    editor = await editorAt(version);
  } catch (cause) {
    return unavailable(`VS Code ${version} could not be fetched: ${describe(cause)}`);
  }

  const profile = await mkdtemp(join(tmpdir(), 'srl-vsc-'));
  try {
    const user = join(profile, 'u');
    const extensions = join(profile, 'e');
    const logs = join(profile, 'l');
    for (const directory of [user, extensions, logs]) await mkdir(directory, { recursive: true });

    await run(editor.electron, [editor.cli, '--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', packed], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    const workspace = join(fixture.root, `${edition}.code-workspace`);
    await writeFile(
      workspace,
      `${JSON.stringify(
        { folders: [{ path: fixture.roots.one }, { path: fixture.roots.declared }, { path: fixture.roots.plain }] },
        null,
        2,
      )}\n`,
    );

    // Everything but the one scenario that is about the editor no longer running.
    const inside = scenarios.filter((scenario) => scenario.ask !== 'orphans');
    const out = join(profile, 'results.json');
    const planPath = join(profile, 'plan.json');
    await writeFile(
      planPath,
      `${JSON.stringify(
        {
          out,
          logs,
          roots: fixture.roots,
          extension: await identifier(),
          restartCommand: 'srl.restartLanguageServer',
          scenarios: inside,
        },
        null,
        2,
      )}\n`,
    );

    const spawned = await run(
      editor.electron,
      [
        `--extensionDevelopmentPath=${PROBE}`,
        `--extensionTestsPath=${join(PROBE, 'run.cjs')}`,
        '--user-data-dir',
        user,
        '--extensions-dir',
        extensions,
        '--logsPath',
        logs,
        // The client only traces when its channel is at trace level, whatever
        // `srl.trace.server` says, and only a command or this flag sets that.
        '--log',
        'trace',
        '--disable-workspace-trust',
        '--disable-updates',
        '--disable-telemetry',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
        workspace,
      ],
      { env: { ...process.env, SRL_CONFORMANCE_PLAN: planPath }, timeout: PATIENCE, maxBuffer: 64 * 1024 * 1024 },
    ).catch((cause) => ({ stdout: '', stderr: describe(cause) }));

    if (!(await exists(out))) {
      return unavailable(`VS Code ${version} wrote no results: ${lastLines(String(spawned.stderr))}`);
    }
    const { results } = /** @type {{ results: ScenarioResult[] }} */ (JSON.parse(await readFile(out, 'utf8')));
    return { adapter: name, edition, version, results: [...results, ...orphans(fixture, scenarios)] };
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/**
 * What the editor left behind. The probe cannot answer this one: it stops existing with
 * the process whose cleanup is under test.
 *
 * @param {Fixture} fixture
 * @param {Scenario[]} scenarios
 * @returns {ScenarioResult[]}
 */
function orphans(fixture, scenarios) {
  return scenarios
    .filter((scenario) => scenario.ask === 'orphans')
    .map((scenario) => {
      const left = census(fixture.roots).total;
      /** @type {ScenarioResult} */
      const result = {
        id: scenario.id,
        status: left === 0 ? 'pass' : 'fail',
        detail: left === 0 ? '' : `${String(left)} language server(s) outlived the editor`,
      };
      return result;
    });
}

/* ── The editor ────────────────────────────────────────────────────────── */

/**
 * The two versions under test: the minimum `engines.vscode` admits, and current stable.
 *
 * @returns {Promise<Array<{ edition: string, version: string }>>}
 */
async function editions() {
  const manifest = /** @type {{ engines: { vscode: string } }} */ (
    JSON.parse(await readFile(join(EXTENSION_DIR, 'package.json'), 'utf8'))
  );
  const minimum = /(\d+\.\d+\.\d+)/u.exec(manifest.engines.vscode)?.[1];
  if (minimum === undefined) throw new Error(`engines.vscode is ${manifest.engines.vscode}, which names no version`);

  const answer = await fetch(`https://update.code.visualstudio.com/api/update/${target()}/stable/latest`);
  if (!answer.ok) throw new Error(`the VS Code update service answered ${String(answer.status)}`);
  const current = /** @type {{ name: string }} */ (await answer.json()).name;

  return current === minimum
    ? [{ edition: 'minimum', version: minimum }]
    : [
        { edition: 'minimum', version: minimum },
        { edition: 'current', version: current },
      ];
}

/** The download the update service names this machine. */
function target() {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `darwin-${architecture}`;
  if (process.platform === 'linux') return `linux-${architecture}`;
  throw new Error(`${process.platform} has no conformance download; run this on macOS or Linux`);
}

/**
 * One version, downloaded once and kept. The archive is not integrity-checked: it is a
 * tool this run drives, never a byte that ships, and the pinned URL is the update
 * service's own.
 *
 * @param {string} version
 * @returns {Promise<{ electron: string, cli: string }>}
 */
async function editorAt(version) {
  const home = join(CACHE, `vscode-${version}-${target()}`);
  const already = await binaries(home);
  if (already !== null) return already;

  await mkdir(home, { recursive: true });
  const archive = join(home, process.platform === 'darwin' ? 'editor.zip' : 'editor.tar.gz');
  const answer = await fetch(`https://update.code.visualstudio.com/${version}/${target()}/stable`, {
    redirect: 'follow',
  });
  if (!answer.ok || answer.body === null) {
    throw new Error(`the update service answered ${String(answer.status)} for ${version}`);
  }
  await pipeline(Readable.fromWeb(/** @type {any} */ (answer.body)), createWriteStream(archive));

  if (process.platform === 'darwin') await run('unzip', ['-q', '-o', archive, '-d', home]);
  else await run('tar', ['xzf', archive, '-C', home]);
  await rm(archive, { force: true });

  const extracted = await binaries(home);
  if (extracted === null) throw new Error(`the ${version} archive held no editor this run recognises`);
  await chmod(extracted.electron, 0o755);
  return extracted;
}

/**
 * The two things a run needs out of an extracted editor: the executable to spawn, and the
 * CLI script it runs under `ELECTRON_RUN_AS_NODE` to install an extension.
 *
 * Both are found rather than named. The macOS executable has been called `Electron` and
 * `Code` in versions this run drives, and the Linux directory carries the architecture,
 * so the layout is read from disk instead of written down twice.
 *
 * @param {string} home
 * @returns {Promise<{ electron: string, cli: string } | null>}
 */
async function binaries(home) {
  if (process.platform === 'darwin') {
    const contents = join(home, 'Visual Studio Code.app', 'Contents');
    const executables = await readdir(join(contents, 'MacOS')).catch(() => []);
    const executable = executables[0];
    if (executable === undefined) return null;
    return {
      electron: join(contents, 'MacOS', executable),
      cli: join(contents, 'Resources', 'app', 'out', 'cli.js'),
    };
  }
  const entries = await readdir(home).catch(() => []);
  const directory = entries.find((entry) => entry.startsWith('VSCode-linux-'));
  if (directory === undefined) return null;
  return {
    electron: join(home, directory, 'code'),
    cli: join(home, directory, 'resources', 'app', 'out', 'cli.js'),
  };
}

/* ── The extension ─────────────────────────────────────────────────────── */

/** The VSIX a user installs, built here rather than assumed. @returns {Promise<string>} */
async function pack() {
  if (!(await exists(join(EXTENSION_DIR, 'node_modules')))) {
    await run('npm', ['ci'], { cwd: EXTENSION_DIR });
  }
  await run('npm', ['run', 'package'], { cwd: EXTENSION_DIR });
  const manifest = /** @type {{ name: string, version: string }} */ (
    JSON.parse(await readFile(join(EXTENSION_DIR, 'package.json'), 'utf8'))
  );
  const packed = join(EXTENSION_DIR, `${manifest.name}-${manifest.version}.vsix`);
  if (!(await exists(packed))) throw new Error(`\`npm run package\` wrote no ${packed}`);
  return packed;
}

/** `publisher.name`, which is what the extension host calls it. @returns {Promise<string>} */
async function identifier() {
  const manifest = /** @type {{ name: string, publisher: string }} */ (
    JSON.parse(await readFile(join(EXTENSION_DIR, 'package.json'), 'utf8'))
  );
  return `${manifest.publisher}.${manifest.name}`;
}

/** @param {unknown} cause */
function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** @param {string} text */
function lastLines(text) {
  return text.split('\n').filter(Boolean).slice(-3).join(' / ') || 'no output';
}
