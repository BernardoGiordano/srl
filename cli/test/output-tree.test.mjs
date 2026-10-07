import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REPO } from '../layout.mjs';
import {
  admitOutput,
  embedJson,
  listFiles,
  replaceOutput,
  within,
  writeWithin,
} from '../delivery/output-tree.mjs';

const run = promisify(execFile);
const BACKUP_FIXTURE = fileURLToPath(new URL('./support/output-backup.mjs', import.meta.url));

/**
 * The confined writer every build, composition and release goes through. ADR-0132.
 *
 * @param {(directory: string) => Promise<void>} body
 */
async function inTemporary(body) {
  const directory = await mkdtemp(join(tmpdir(), 'output-tree-'));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('a path resolves inside its root as written, or is refused', () => {
  assert.equal(within('/srv/out', 'public/assets/a.js'), '/srv/out/public/assets/a.js');
  for (const path of [
    '',
    '/etc/passwd',
    '../x',
    'a/../../x',
    'a//b',
    './a',
    'a/.',
    'a\\b',
    'a\0b',
    // What a locale pattern `/i18n/{locale}.json?/../../../x` hash-named to.
    'assets/i18n/en.json?/../../../x-0123456789abcdef',
    // What a component tag `x/../../` named its template file.
    'assets/templates/x/../../-0123456789abcdef.html',
  ]) {
    assert.throws(() => within('/srv/out', path), /output: unsafe relative path/u, path);
  }
});

void test('a write cannot leave its root through a symbolic link', async () => {
  await inTemporary(async (directory) => {
    const root = join(directory, 'stage');
    const outside = join(directory, 'outside');
    await mkdir(root);
    await mkdir(outside);

    await writeWithin(root, 'public/assets/a.js', 'ok');
    assert.equal(await readFile(join(root, 'public/assets/a.js'), 'utf8'), 'ok');

    await symlink(outside, join(root, 'linked'));
    await assert.rejects(writeWithin(root, 'linked/a.js', 'escaped'), /through a symbolic link/u);
    await assert.rejects(writeWithin(root, 'linked/deeper/a.js', 'escaped'), /through a symbolic link/u);

    await writeFile(join(outside, 'target.txt'), 'kept');
    await symlink(join(outside, 'target.txt'), join(root, 'file.txt'));
    await assert.rejects(writeWithin(root, 'file.txt', 'escaped'), /not a regular file/u);
    assert.equal(await readFile(join(outside, 'target.txt'), 'utf8'), 'kept');
    assert.deepEqual(await listFiles(outside), ['target.txt']);
  });
});

void test('a listing names every regular file and refuses a link', async () => {
  await inTemporary(async (directory) => {
    await writeWithin(directory, 'b/.hidden', '');
    await writeWithin(directory, 'a.txt', '');
    assert.deepEqual(await listFiles(directory), ['a.txt', 'b/.hidden']);

    await symlink(join(directory, 'a.txt'), join(directory, 'b', 'link'));
    await assert.rejects(listFiles(directory), /symbolic link or special file/u);
  });
});

void test('an output that holds the project or the home directory is never admitted', async () => {
  for (const outDir of [REPO, dirname(REPO), '/', homedir(), dirname(homedir())]) {
    await assert.rejects(admitOutput(outDir, { force: true }), /holds the (?:project|home directory)/u);
  }
  await inTemporary(async (directory) => {
    // A link is followed, so a spelling outside the project still names it.
    await symlink(dirname(REPO), join(directory, 'parent'));
    await assert.rejects(admitOutput(join(directory, 'parent')), /holds the project/u);
  });
});

void test('only a directory a build wrote is replaced without --force', async () => {
  await inTemporary(async (directory) => {
    const absent = join(directory, 'absent');
    assert.equal(await admitOutput(absent), absent);

    const empty = join(directory, 'empty');
    await mkdir(empty);
    assert.equal(await admitOutput(empty), empty);

    const built = join(directory, 'built');
    await writeWithin(built, 'artifact.json', '{}');
    assert.equal(await admitOutput(built), built);

    const owned = join(directory, 'owned');
    await writeWithin(owned, 'notes.txt', 'mine');
    await assert.rejects(admitOutput(owned), /holds no artifact\.json/u);
    assert.equal(await admitOutput(owned, { force: true }), owned);

    // The backup beside an output is replaced too, so it obeys the same rule.
    await writeWithin(directory, 'next.previous/notes.txt', 'mine');
    await assert.rejects(admitOutput(join(directory, 'next')), /next\.previous exists and holds no/u);
  });
});

for (const protectedName of ['project', 'home directory']) {
  for (const { layout, relation } of [
    { layout: 'equal', relation: 'equal to' },
    { layout: 'enclosing', relation: 'enclosing' },
    { layout: 'backup link', relation: 'linked to' },
    { layout: 'parent link', relation: 'resolving through a parent link to' },
  ]) {
    for (const authorization of ['force', 'marker']) {
      void test(`a backup ${relation} the ${protectedName} is refused with ${authorization}`, async () => {
        await inTemporary(async (directory) => {
          await run(process.execPath, [
            BACKUP_FIXTURE, directory, protectedName, layout, authorization, 'admit',
          ]);
        });
      });
    }
  }
  for (const authorization of ['force', 'marker']) {
    for (const outputState of ['absent', 'existing']) {
      void test(`publication refuses a new backup link to the ${protectedName} with ${authorization} and ${outputState} output`, async () => {
        await inTemporary(async (directory) => {
          await run(process.execPath, [
            BACKUP_FIXTURE, directory, protectedName, 'backup link', authorization, outputState,
          ]);
        });
      });
    }
  }
}

for (const authorization of ['force', 'marker']) {
  for (const outputState of ['absent', 'existing']) {
    void test(`an admitted abandoned backup is cleaned with ${authorization} and ${outputState} output`, async () => {
      await inTemporary(async (directory) => {
        const output = join(directory, 'out');
        const stage = join(directory, '.stage');
        await writeWithin(stage, 'artifact.json', '{"next":true}');
        await writeWithin(`${output}.previous`, authorization === 'marker' ? 'artifact.json' : 'notes.txt', 'old backup');
        if (outputState === 'existing') await writeWithin(output, 'artifact.json', '{"next":false}');

        await replaceOutput(stage, output, { force: authorization === 'force' });
        assert.equal(await readFile(join(output, 'artifact.json'), 'utf8'), '{"next":true}');
        assert.deepEqual(await listFiles(directory), ['out/artifact.json']);
      });
    });
  }
}

void test('replacing an output re-admits it and keeps what a build did not write', async () => {
  await inTemporary(async (directory) => {
    const output = join(directory, 'out');
    const stage = join(directory, '.stage');
    await writeWithin(stage, 'artifact.json', '{"next":true}');

    await writeWithin(output, 'notes.txt', 'mine');
    await assert.rejects(replaceOutput(stage, output), /holds no artifact\.json/u);
    assert.equal(await readFile(join(output, 'notes.txt'), 'utf8'), 'mine');

    await rm(output, { recursive: true });
    await writeWithin(output, 'artifact.json', '{"next":false}');
    await replaceOutput(stage, output);
    assert.equal(await readFile(join(output, 'artifact.json'), 'utf8'), '{"next":true}');
    assert.deepEqual(await listFiles(directory), ['out/artifact.json']);
  });
});

void test('embedded JSON cannot end the element that holds it', () => {
  const value = {
    imports: { app: '/assets/a.js' },
    integrity: { '/x</script><script>alert(1)</script><!--': 'a&b', '\u2028\u2029': '>' },
  };
  const text = embedJson(value);
  assert.doesNotMatch(text, /[<>&\u2028\u2029]/u);
  assert.deepEqual(JSON.parse(text), value);
  assert.equal(embedJson({ a: '/assets/a.js' }), JSON.stringify({ a: '/assets/a.js' }));
});
