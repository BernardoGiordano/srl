import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPO } from '../../cli/layout.mjs';
import { emitProject } from '../../cli/scaffold/project.mjs';

void test('a new project declares every dependency its first build needs, as this checkout installs it', async () => {
  const [lockSource, coreSource, cliSource] = await Promise.all(
    [
      readFile(join(REPO, 'package-lock.json'), 'utf8'),
      readFile(join(REPO, 'source', 'package.json'), 'utf8'),
      readFile(join(REPO, 'cli', 'package.json'), 'utf8'),
    ],
  );
  const lock = /** @type {{ packages: Record<string, { version: string }> }} */ (JSON.parse(lockSource));
  const locked = (/** @type {string} */ name) => lock.packages[`node_modules/${name}`]?.version;

  const parent = await mkdtemp(join(tmpdir(), 'srl-project-'));
  try {
    await emitProject(parent, { name: 'installed-application' });
    const manifest = JSON.parse(await readFile(join(parent, 'installed-application', 'package.json'), 'utf8'));

    // The pinned pair, then the application-owned tools at the versions the packaged
    // install proves. ADR-0098, ADR-0122.
    assert.deepEqual(manifest.dependencies, { '@srljs/core': JSON.parse(coreSource).version });
    assert.deepEqual(manifest.devDependencies, {
      '@srljs/cli': JSON.parse(cliSource).version,
      '@tailwindcss/cli': locked('@tailwindcss/cli'),
      '@types/node': locked('@types/node'),
      tailwindcss: locked('tailwindcss'),
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
