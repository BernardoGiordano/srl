import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { activateReleasePointer } from '../delivery/activate-release.mjs';

/**
 * Activation selects what visitors get, so it hashes the release against its report
 * first. A release tree is written by hand here, in the layout `srl release` stages,
 * with one versioned file and one shared asset.
 */

const ID = '0123456789ab-cdef01234567';

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** @returns {Promise<string>} the release root */
async function releaseRoot() {
  const root = await mkdtemp(join(tmpdir(), 'srl-activate-'));
  const releaseDir = join(root, 'releases', ID);
  await mkdir(join(releaseDir, 'public'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });

  const page = '<!doctype html><title>release</title>\n';
  const asset = 'export const entry = true;\n';
  await writeFile(join(releaseDir, 'public', 'index.html'), page);
  await writeFile(join(root, 'assets', 'entry-abcdefgh.js'), asset);
  await writeFile(
    join(releaseDir, 'release.json'),
    JSON.stringify({
      version: 1,
      app: 'example',
      id: ID,
      files: [
        { target: 'release', path: 'public/index.html', bytes: page.length, sha256: sha256(page) },
        { target: 'asset', path: 'entry-abcdefgh.js', bytes: asset.length, sha256: sha256(asset) },
      ],
    }),
  );
  return root;
}

void test('activation selects a release whose bytes match its report', async () => {
  const root = await releaseRoot();
  try {
    const selected = await activateReleasePointer({ root, id: ID });
    assert.deepEqual(selected, { current: ID, previous: null });
    assert.equal(await readlink(join(root, 'current')), `releases/${ID}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('activation refuses a release whose versioned bytes drifted', async () => {
  const root = await releaseRoot();
  try {
    await writeFile(join(root, 'releases', ID, 'public', 'index.html'), '<script>steal()</script>\n');
    await assert.rejects(activateReleasePointer({ root, id: ID }), /release-verify: hash mismatch/u);
    await assert.rejects(readlink(join(root, 'current')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('activation refuses a release whose shared asset drifted', async () => {
  const root = await releaseRoot();
  try {
    await writeFile(join(root, 'assets', 'entry-abcdefgh.js'), 'export const entry = false;\n');
    await assert.rejects(activateReleasePointer({ root, id: ID }), /release-verify: hash mismatch/u);
    await assert.rejects(readlink(join(root, 'current')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
