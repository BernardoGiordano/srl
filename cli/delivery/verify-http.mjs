/** Verify bytes and headers served from one published browser artifact. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ artifactRoot: string, origin: string, fetch?: typeof globalThis.fetch }} options
 */
export async function verifyHttpArtifact(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const request = options.fetch ?? globalThis.fetch;
  const origin = new URL(options.origin);
  if (!/^https?:$/u.test(origin.protocol) || origin.pathname !== '/') {
    throw new Error(`http-verify: origin must be an HTTP origin: ${options.origin}`);
  }
  const report = JSON.parse(await readFile(join(artifactRoot, 'artifact.json'), 'utf8'));
  if (
    report.version !== 1 ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(report.app ?? '') ||
    !Array.isArray(report.files) ||
    (report.kind !== undefined && report.kind !== 'remote') ||
    (report.kind === 'remote' && typeof report.base !== 'string') ||
    (report.kind !== 'remote' && typeof report.security?.csp !== 'string')
  ) {
    throw new Error('http-verify: unsupported artifact report.');
  }
  const base = report.kind === 'remote' ? report.base : '/';
  if (!base.startsWith('/') || !base.endsWith('/') || base.startsWith('//')) {
    throw new Error(`http-verify: invalid artifact publication base: ${String(base)}`);
  }

  let checked = 0;
  for (const file of report.files) {
    if (!file.path.startsWith('public/')) continue;
    const pathname = `${base}${file.path.slice('public/'.length)}`;
    const response = await request(new URL(pathname, origin), {
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Accept-Encoding': 'identity' },
    });
    if (!response.ok) {
      throw new Error(`http-verify: ${pathname} answered ${String(response.status)}.`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(body).digest('hex');
    if (body.byteLength !== file.bytes || hash !== file.sha256) {
      throw new Error(`http-verify: served bytes differ for ${pathname}.`);
    }
    const expectedCache = report.cache[file.cache];
    if (typeof expectedCache !== 'string' || response.headers.get('cache-control') !== expectedCache) {
      throw new Error(`http-verify: Cache-Control differs for ${pathname}.`);
    }
    if (
      file.path === 'public/index.html' &&
      typeof report.security?.csp === 'string' &&
      response.headers.get('content-security-policy') !== report.security.csp
    ) {
      throw new Error('http-verify: served CSP differs from artifact security metadata.');
    }
    checked += 1;
  }

  const forbidden =
    report.kind === 'remote'
      ? ['artifact.json', 'release.json', 'THIRD_PARTY_LICENSES.md', 'assets/not-a-module.js']
      : [
          'artifact.json',
          'release.json',
          'THIRD_PARTY_LICENSES.md',
          'assets/not-a-module.js',
          'src/not-a-module.js',
          'lib/not-a-module.js',
          'components/not-a-module.js',
        ];
  for (const relativePath of forbidden) {
    const pathname = `${base}${relativePath}`;
    const response = await request(new URL(pathname, origin), { redirect: 'error' });
    if (response.status !== 404) {
      throw new Error(`http-verify: forbidden or missing path ${pathname} answered ${String(response.status)}.`);
    }
  }
  return {
    app: report.app,
    ...(report.kind === 'remote' ? { kind: 'remote', name: report.name, base } : {}),
    files: checked,
    commit: report.release.commit,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const artifactRoot = process.argv[2];
    const origin = process.argv[3];
    if (artifactRoot === undefined || origin === undefined) {
      throw new Error('usage: node verify-http.mjs <artifact-directory> <https-origin>');
    }
    const result = await verifyHttpArtifact({ artifactRoot, origin });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
