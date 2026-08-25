/** Verify one staged or remote release against its immutable release report. */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Shared asset directories may contain retained hashes from older releases. Versioned
 * release directories are exact: any unreported file there is publication drift.
 *
 * @param {{ releaseDir: string, assetsDir: string }} options
 */
export async function verifyPublishedRelease(options) {
  const releaseDir = resolve(options.releaseDir);
  const assetsDir = resolve(options.assetsDir);
  const reportPath = join(releaseDir, 'release.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (
    report.version !== 1 ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(report.app ?? '') ||
    (report.kind !== undefined && report.kind !== 'remote') ||
    !Array.isArray(report.files)
  ) {
    throw new Error('release-verify: unsupported release.json contract.');
  }

  const expectedRelease = new Set(['release.json']);
  const expectedFiles = new Set();
  let bytes = 0;
  for (const file of report.files) {
    if (
      !['asset', 'release'].includes(file.target) ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.bytes) ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new Error('release-verify: malformed file record.');
    }
    const key = `${file.target}/${file.path}`;
    if (expectedFiles.has(key)) {
      throw new Error(`release-verify: duplicate file record ${key}`);
    }
    expectedFiles.add(key);
    const root = file.target === 'asset' ? assetsDir : releaseDir;
    const path = inside(root, file.path);
    const content = await readFile(path);
    const actual = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== file.bytes || actual !== file.sha256) {
      throw new Error(`release-verify: hash mismatch for ${file.target}/${file.path}`);
    }
    if (file.target === 'release') expectedRelease.add(file.path);
    bytes += content.byteLength;
  }

  const actualRelease = new Set(
    (await walk(releaseDir)).map((path) => relative(releaseDir, path).split(sep).join('/')),
  );
  if (
    expectedRelease.size !== actualRelease.size ||
    [...expectedRelease].some((path) => !actualRelease.has(path))
  ) {
    throw new Error('release-verify: versioned release directory contains unreported drift.');
  }
  return {
    id: report.id,
    app: report.app,
    ...(report.kind === undefined ? {} : { kind: report.kind, name: report.name }),
    files: report.files.length,
    bytes,
  };
}

/** @param {string} root @param {string} path */
function inside(root, path) {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    throw new Error(`release-verify: unsafe path ${path}`);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`release-verify: path escapes root: ${path}`);
  }
  return target;
}

/** @param {string} root @returns {Promise<string[]>} */
async function walk(root) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`release-verify: symbolic or special file found: ${path}`);
  }
  return files;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const releaseDir = process.argv[2];
    const assetsDir = process.argv[3];
    if (releaseDir === undefined || assetsDir === undefined) {
      throw new Error('usage: node verify-release.mjs <release-directory> <asset-directory>');
    }
    const result = await verifyPublishedRelease({ releaseDir, assetsDir });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
