import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { REPO } from '../../cli/layout.mjs';
import { applicationManifest } from '../fixtures/installed-layout.mjs';

void test('an installed application declares every dependency its first build needs', async () => {
  const [repositorySource, lockSource, coreSource, cliSource] = await Promise.all(
    [
      readFile(join(REPO, 'package.json'), 'utf8'),
      readFile(join(REPO, 'package-lock.json'), 'utf8'),
      readFile(join(REPO, 'source', 'package.json'), 'utf8'),
      readFile(join(REPO, 'cli', 'package.json'), 'utf8'),
    ],
  );
  const repositoryPackage = JSON.parse(repositorySource);
  const repositoryLock = JSON.parse(lockSource);
  const corePackage = JSON.parse(coreSource);
  const cliPackage = JSON.parse(cliSource);
  const manifest = JSON.parse(applicationManifest('installed-application'));

  assert.deepEqual(manifest, {
    name: 'installed-application',
    private: true,
    type: 'module',
    version: '0.0.0',
    devDependencies: {
      '@srljs/core': corePackage.version,
      '@srljs/cli': cliPackage.version,
      '@tailwindcss/cli': repositoryPackage.devDependencies['@tailwindcss/cli'],
      '@types/node': repositoryLock.packages['node_modules/@types/node'].version,
      tailwindcss: repositoryPackage.devDependencies.tailwindcss,
    },
  });
});
