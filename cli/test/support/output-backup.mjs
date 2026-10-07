import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';

const [directory, protectedName, layout, authorization, operation] = process.argv.slice(2);
assert.ok(directory !== undefined && protectedName !== undefined && layout !== undefined);
assert.ok(authorization !== undefined && operation !== undefined);

let output = join(directory, 'sdk');
let backup = `${output}.previous`;
if (layout === 'parent link') {
  const physicalParent = join(directory, 'physical');
  await mkdir(physicalParent);
  await symlink(physicalParent, join(directory, 'alias'));
  output = join(directory, 'alias', 'sdk');
  backup = join(physicalParent, 'sdk.previous');
}

const protectedDirectory = layout === 'equal' ? backup
  : layout === 'backup link' ? join(directory, 'protected')
  : join(backup, 'protected');
const project = protectedName === 'project' ? protectedDirectory : join(directory, 'project');
const homeDirectory = protectedName === 'home directory' ? protectedDirectory : join(directory, 'home');
await mkdir(project, { recursive: true });
await mkdir(homeDirectory, { recursive: true });
await writeFile(join(project, 'project.txt'), 'keep project');
await writeFile(join(homeDirectory, 'home.txt'), 'keep home');

// Each child uses synthetic project and home paths, including publication checks.
process.env.SRL_ROOT = project;
mock.method(os, 'homedir', () => homeDirectory);
syncBuiltinESMExports();
const { admitOutput, replaceOutput } = await import('../../delivery/output-tree.mjs');
const options = { force: authorization === 'force' };
const stage = join(directory, '.stage');
await mkdir(stage);
await writeFile(join(stage, 'artifact.json'), '{"stage":true}');

if (operation === 'existing') {
  await mkdir(output);
  await writeFile(join(output, 'artifact.json'), '{"output":true}');
}
if (operation !== 'admit') await admitOutput(output, options);

if (layout === 'backup link') await symlink(protectedDirectory, backup);
if (authorization === 'marker') await writeFile(join(backup, 'artifact.json'), '{"backup":true}');

const before = await snapshot(directory);
const refusal = (/** @type {Error} */ error) => {
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes(`${output}.previous holds the ${protectedName}`), error.message);
  return true;
};
if (operation === 'admit') await assert.rejects(admitOutput(output, options), refusal);
else await assert.rejects(replaceOutput(stage, output, options), refusal);
assert.deepEqual(await snapshot(directory), before);

/**
 * Record directories, links and file bytes without following links.
 *
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function snapshot(root) {
  /** @type {Record<string, string>} */
  const entries = {};
  /** @param {string} directoryPath @param {string} prefix */
  async function visit(directoryPath, prefix) {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const path = join(directoryPath, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) entries[name] = `link ${await readlink(path)}`;
      else if (entry.isDirectory()) {
        entries[name] = 'directory';
        await visit(path, `${name}/`);
      } else entries[name] = (await readFile(path)).toString('base64');
    }
  }
  await visit(root, '');
  return entries;
}
