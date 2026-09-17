import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { checkProject } from '../checks/index.mjs';
import { CODES, describeCode } from '../diagnostics/catalog.mjs';
import { errors } from '../diagnostics/index.mjs';
import { apps, walk } from '../layout.mjs';
import { readProject } from '../project-model/index.mjs';

/**
 * `srl check` as one runner over every check, and the catalogue its codes live in.
 *
 * The runner's promise is one command, one shape and one exit code, so these tests
 * assert on codes and never on wording. ADR-0072, ADR-0120.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(CLI, 'bin', 'srl.mjs');
const FIXTURES = join(CLI, 'test', 'fixtures', 'project-model');

/** Namespaces `srl check` reports under. Other tools own the rest. */
const CHECKED = /['"`]((?:check|project|types|templates|importmap|messages)\/[a-z][a-z0-9-]*)['"`]/gu;

/**
 * Run the published command.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: number, stdout: string }>}
 */
async function srl(args, env = process.env) {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args], { env });
    return { code: 0, stdout };
  } catch (cause) {
    const failed = /** @type {{ code: number, stdout: string }} */ (cause);
    return { code: failed.code, stdout: failed.stdout };
  }
}

void test('every code a published check reports is catalogued, and every entry is reported', async () => {
  const sources = (await walk(CLI, /\.mjs$/u)).filter(
    (file) =>
      !relative(CLI, file).split(sep).includes('test') && !file.endsWith(join('diagnostics', 'catalog.mjs')),
  );
  /** @type {Set<string>} */
  const reported = new Set();
  for (const file of sources) {
    for (const match of (await readFile(file, 'utf8')).matchAll(CHECKED)) {
      if (match[1] !== undefined) reported.add(match[1]);
    }
  }

  const catalogued = new Set(Object.keys(CODES));
  assert.deepEqual([...reported].filter((code) => !catalogued.has(code)).sort(), [], 'add these to the catalogue');
  assert.deepEqual([...catalogued].filter((code) => !reported.has(code)).sort(), [], 'no check reports these');

  // The TypeScript families are built from a number, so no literal names them.
  assert.ok(describeCode('types/ts2322'));
  assert.ok(describeCode('templates/ts2551'));
  assert.equal(describeCode('templates/tsx'), undefined);
  assert.equal(describeCode('templates/dialect'), undefined);
});

void test('one run reads each model once and reports each application as one block', async () => {
  const selected = await apps();
  /** @type {Map<string, number>} */
  const reads = new Map();
  const found = await checkProject({
    subjects: ['project', 'templates', 'importmap', 'messages'],
    apps: selected,
    readModel: (app) => {
      reads.set(app.name, (reads.get(app.name) ?? 0) + 1);
      return readProject(app);
    },
  });

  assert.deepEqual(errors(found), []);
  assert.deepEqual([...reads.values()], selected.map(() => 1));
  assert.deepEqual(
    found.filter((diagnostic) => describeCode(diagnostic.code) === undefined).map((diagnostic) => diagnostic.code),
    [],
  );

  // One heading per application, in application order.
  const groups = found.map((diagnostic) => diagnostic.group).filter((group, index, all) => group !== all[index - 1]);
  assert.deepEqual(groups, selected.map((app) => app.name));
  for (const code of ['project/read', 'templates/checked', 'importmap/verbatim', 'messages/references']) {
    assert.ok(found.some((diagnostic) => diagnostic.code === code), code);
  }
});

void test('the project subject fails on model errors and keeps test-source warnings out', async () => {
  const app = { name: 'app-a', dir: join(FIXTURES, 'app-a') };
  const found = await checkProject({
    subjects: ['project'],
    apps: [app],
    readModel: (one) => readProject(one, { roots: [one.dir] }),
  });

  const codes = new Set(errors(found).map((diagnostic) => diagnostic.code));
  for (const code of ['project/dynamic', 'project/duplicate-tag', 'project/unresolved-uses']) {
    assert.ok(codes.has(code), code);
  }
  assert.ok(!found.some((diagnostic) => diagnostic.code === 'project/read'));

  // The application's own warnings stay. Its suites' deliberate mistakes do not.
  const warnings = found.filter((diagnostic) => diagnostic.severity === 'warning');
  assert.ok(warnings.some((diagnostic) => diagnostic.code === 'project/dynamic'));
  assert.deepEqual(
    warnings.filter((diagnostic) => diagnostic.file?.includes('app-a/src/test/')),
    [],
  );
});

void test('the command refuses what it cannot run, in the shape it was asked for', async () => {
  const unknown = await srl(['check', 'nonsense', '--json']);
  assert.equal(unknown.code, 1);
  assert.deepEqual(
    JSON.parse(unknown.stdout).diagnostics.map((/** @type {{ code: string }} */ one) => one.code),
    ['check/unknown-subject'],
  );

  const write = await srl(['check', 'templates', '--write', '--json']);
  assert.equal(write.code, 1);
  assert.equal(JSON.parse(write.stdout).diagnostics[0].code, 'check/write-outside-messages');

  const app = await srl(['check', 'project', '--app', 'nowhere', '--json']);
  assert.equal(app.code, 1);
  assert.equal(JSON.parse(app.stdout).diagnostics[0].code, 'check/unknown-application');

  const catalogue = await srl(['check', '--codes', '--json']);
  assert.equal(catalogue.code, 0);
  assert.deepEqual(JSON.parse(catalogue.stdout).codes, CODES);
});

void test('the type check reports what tsc reports, at the line tsc names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-check-types-'));
  const env = { ...process.env, SRL_ROOT: root };
  try {
    const missing = await srl(['check', 'types', '--json'], env);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stdout).diagnostics[0].code, 'types/no-config');

    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { allowJs: true, checkJs: true, strict: true, types: [] },
        include: ['*.js'],
      }),
    );
    await writeFile(join(root, 'wrong.js'), "export {};\n/** @type {number} */\nconst count = 'three';\nvoid count;\n");

    const wrong = await srl(['check', 'types', '--json'], env);
    assert.equal(wrong.code, 1);
    const [finding] = JSON.parse(wrong.stdout).diagnostics;
    assert.equal(finding.code, 'types/ts2322');
    assert.equal(finding.file, 'wrong.js');
    assert.equal(finding.line, 3);
    assert.equal(finding.column, 7);

    await writeFile(join(root, 'wrong.js'), "export {};\n/** @type {number} */\nconst count = 3;\nvoid count;\n");
    const right = await srl(['check', 'types', '--json'], env);
    assert.equal(right.code, 0);
    assert.deepEqual(
      JSON.parse(right.stdout).diagnostics.map((/** @type {{ code: string }} */ one) => one.code),
      ['types/checked'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
