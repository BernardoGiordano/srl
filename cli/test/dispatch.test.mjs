import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The `srl` dispatcher and its short command names.
 *
 * A short form runs the same program as its long form, so each pair must answer
 * with the same output and the same exit code.
 */

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/srl.mjs', import.meta.url));

/**
 * Run the published command against a project root.
 *
 * @param {string[]} args
 * @param {{ root: string, cwd?: string }} where
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function srl(args, { root, cwd = root }) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SRL_ROOT: root };
  delete env.APP;
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failed = /** @type {{ code: number, stdout: string, stderr: string }} */ (cause);
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

/** @param {(dir: string) => Promise<void>} body @returns {Promise<void>} */
async function inTemporary(body) {
  const dir = await mkdtemp(join(tmpdir(), 'srl-dispatch-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test('each short form answers exactly as its long form', async () => {
  await inTemporary(async (root) => {
    const pairs = [
      [['n', '--json'], ['new', '--json']],
      [['g', 'c', 'user-card', '--json'], ['generate', 'component', 'user-card', '--json']],
      [['g', 'nope', '--json'], ['generate', 'nope', '--json']],
      [['s'], ['serve']],
      [['b'], ['build']],
    ];
    for (const [short, long] of pairs) {
      const answer = await srl(short ?? [], { root });
      assert.notEqual(answer.code, 0, `srl ${short?.join(' ')} fails in an empty root`);
      assert.deepEqual(answer, await srl(long ?? [], { root }), `srl ${short?.join(' ')}`);
    }
  });
});

void test('srl n then srl g c writes a project and a component', async () => {
  await inTemporary(async (dir) => {
    assert.equal((await srl(['n', 'my-app'], { root: dir })).code, 0);

    const project = join(dir, 'my-app');
    assert.equal((await srl(['g', 'c', 'user-card'], { root: project })).code, 0);
    assert.deepEqual((await readdir(join(project, 'web', 'src', 'components'))).sort(), [
      'user-card.html',
      'user-card.js',
    ]);
  });
});

void test('a name on Object.prototype is an unknown command', async () => {
  await inTemporary(async (root) => {
    for (const name of ['constructor', 'toString']) {
      const answer = await srl([name], { root });
      assert.equal(answer.code, 1);
      assert.match(answer.stderr, new RegExp(`unknown command "${name}"`, 'u'));
    }
  });
});
