import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PUBLIC,
  REPORT,
  isRemoteReport,
  parseReport,
  readReport,
  writeReport,
} from '../delivery/artifact-report.mjs';

/** @import { RemoteArtifactReport, ShellArtifactReport } from '../delivery/artifact-report.mjs' */

/**
 * The contract, stated rather than built. Every assertion below is about the shape
 * of one document, which is the whole point of the module having an interface: the
 * artifact report used to be checkable only by running Vite over a real application
 * and reading what came out.
 */
const IMPORT_MAP_HASH = 'sha256-3q2+7w==';

/** @returns {ShellArtifactReport} */
function shellReport() {
  return /** @type {ShellArtifactReport} */ ({
    version: 1,
    experimental: true,
    root: '.',
    public: PUBLIC,
    app: 'example',
    release: { commit: 'a'.repeat(40), sourceDateEpoch: 0 },
    target: 'es2022',
    cache: {
      immutable: 'public, max-age=31536000, immutable',
      revalidate: 'private, no-cache',
      metadata: null,
    },
    entry: 'assets/entry-abcd1234.js',
    chunks: [
      {
        path: 'assets/entry-abcd1234.js',
        entry: true,
        dynamicEntry: false,
        facade: 'example/src/main.js',
        imports: [],
        dynamicImports: [],
        modules: ['example/src/main.js'],
      },
    ],
    shared: { '@core/': '/assets/shared/core-abcd1234.js' },
    remotes: [],
    security: {
      importMap: { source: '{"imports":{}}', sha256: IMPORT_MAP_HASH },
      modules: [{ path: 'assets/entry-abcd1234.js', integrity: `sha384-${'A'.repeat(64)}` }],
      csp: `script-src 'self' '${IMPORT_MAP_HASH}'`,
    },
    templates: {
      delivery: 'split',
      bundle: null,
      url: null,
      count: 1,
      bytes: 12,
      files: ['assets/templates/app-root-0123456789abcdef.html'],
    },
    files: [
      {
        path: `${PUBLIC}/index.html`,
        cache: 'revalidate',
        bytes: 10,
        gzip: 8,
        brotli: 7,
        sha256: 'b'.repeat(64),
      },
    ],
    totals: { files: 1, bytes: 10, gzip: 8, brotli: 7 },
  });
}

/** @returns {RemoteArtifactReport} */
function remoteReport() {
  const base = '/remotes/billing/0000000000000000000000000000000000000000/';
  const url = `${base}assets/remote-entry-abcd1234.js`;
  const shell = shellReport();
  return /** @type {RemoteArtifactReport} */ ({
    version: 1,
    kind: 'remote',
    experimental: true,
    root: '.',
    public: PUBLIC,
    base,
    app: 'example',
    name: 'billing',
    release: shell.release,
    target: shell.target,
    cache: shell.cache,
    entry: 'assets/remote-entry-abcd1234.js',
    chunks: shell.chunks,
    remote: {
      name: 'billing',
      url,
      integrity: `sha384-${'A'.repeat(64)}`,
      assets: [{ type: 'module', url, integrity: `sha384-${'A'.repeat(64)}` }],
      shared: ['@core/'],
      locales: [`${base}i18n/{locale}.json`],
    },
    templates: shell.templates,
    files: shell.files,
    totals: shell.totals,
  });
}

/** @param {ShellArtifactReport | RemoteArtifactReport} report */
function serialize(report) {
  return JSON.stringify(report);
}

void test('a well-formed report survives a round trip through the module', () => {
  const parsed = parseReport(serialize(shellReport()), 'shell');
  assert.equal(parsed.app, 'example');
  assert.equal(isRemoteReport(parsed), false);
  assert.deepEqual(parsed, shellReport());

  const remote = parseReport(serialize(remoteReport()), 'remote');
  assert.equal(isRemoteReport(remote), true);
  assert.equal(remote.kind, 'remote');
});

void test('a shell and a Remote report are told apart by kind alone', () => {
  const shell = parseReport(serialize(shellReport()), 'shell');
  assert.ok(!isRemoteReport(shell));
  assert.equal(shell.security.csp.includes(IMPORT_MAP_HASH), true);

  const remote = parseReport(serialize(remoteReport()), 'remote');
  assert.ok(isRemoteReport(remote));
  assert.equal(remote.remote.name, remote.name);
});

void test('a report the module cannot name is refused, and says which field', () => {
  /** @type {Array<[string, (report: Record<string, unknown>) => void, RegExp]>} */
  const cases = [
    ['version', (report) => (report.version = 2), /unsupported report version/u],
    ['app', (report) => (report.app = 'Example'), /app must be a package-safe name/u],
    ['public', (report) => (report.public = 'www'), /browser root must be/u],
    [
      'release',
      (report) => (report.release = { commit: 'nope', sourceDateEpoch: null }),
      /release\.commit must be null or a commit hash/u,
    ],
    [
      'cache',
      (report) => (report.cache = { immutable: 'a', revalidate: 'b', metadata: 'c' }),
      /cache\.metadata must be null/u,
    ],
    [
      'inventory digest',
      (report) => {
        const files = /** @type {Array<Record<string, unknown>>} */ (report.files);
        if (files[0] !== undefined) files[0].sha256 = 'short';
      },
      /carries no SHA-256 digest/u,
    ],
    [
      'inventory cache class',
      (report) => {
        const files = /** @type {Array<Record<string, unknown>>} */ (report.files);
        if (files[0] !== undefined) files[0].cache = 'forever';
      },
      /unsupported cache class/u,
    ],
    [
      'the report listing itself',
      (report) => {
        const files = /** @type {Array<Record<string, unknown>>} */ (report.files);
        if (files[0] !== undefined) files[0].path = REPORT;
      },
      /may not list artifact\.json itself/u,
    ],
    [
      'template count',
      (report) => {
        const templates = /** @type {Record<string, unknown>} */ (report.templates);
        templates.count = 3;
      },
      /templates\.count differs/u,
    ],
    [
      'split delivery naming a bundle',
      (report) => {
        const templates = /** @type {Record<string, unknown>} */ (report.templates);
        templates.bundle = 'assets/templates-0123456789abcdef.json';
      },
      /split template delivery names no bundle/u,
    ],
    ['kind', (report) => (report.kind = 'shell'), /unsupported report kind/u],
  ];

  for (const [label, corrupt, expected] of cases) {
    const report = /** @type {Record<string, unknown>} */ (
      /** @type {unknown} */ (JSON.parse(serialize(shellReport())))
    );
    corrupt(report);
    assert.throws(() => parseReport(JSON.stringify(report), 'shell'), expected, label);
  }
});

void test('a CSP that does not admit its own import map is refused', () => {
  const report = shellReport();
  const broken = {
    ...report,
    security: { ...report.security, csp: "script-src 'self'" },
  };
  assert.throws(
    () => parseReport(JSON.stringify(broken), 'shell'),
    /CSP does not admit the reported import map/u,
  );

  const quoted = {
    ...report,
    security: { ...report.security, csp: `script-src "self" '${IMPORT_MAP_HASH}'` },
  };
  assert.throws(
    () => parseReport(JSON.stringify(quoted), 'shell'),
    /CSP carries a character a header cannot/u,
  );
});

void test("a Remote whose descriptor names another Remote is refused", () => {
  const report = remoteReport();
  const mismatched = { ...report, remote: { ...report.remote, name: 'analytics' } };
  assert.throws(
    () => parseReport(JSON.stringify(mismatched), 'remote'),
    /transport descriptor names another Remote/u,
  );

  const relative = { ...report, base: 'remotes/billing/0/' };
  assert.throws(
    () => parseReport(JSON.stringify(relative), 'remote'),
    /publication base must be an absolute directory URL/u,
  );
});

void test('bytes that are not JSON are refused as such, with the cause attached', () => {
  assert.throws(
    () => parseReport('{', 'dist/example/artifact.json'),
    (error) =>
      error instanceof Error &&
      /dist\/example\/artifact\.json: cannot parse/u.test(error.message) &&
      error.cause instanceof SyntaxError,
  );
});

void test('a written report is admitted first, and reads back identical', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-report-'));
  try {
    const written = await writeReport(temporary, shellReport());
    assert.ok(Object.isFrozen(written), 'a written report is handed back frozen');
    assert.ok(Object.isFrozen(written.security), 'and frozen all the way down');

    const source = await readFile(join(temporary, REPORT), 'utf8');
    assert.equal(source.endsWith('}\n'), true, 'the file is one JSON document and a newline');

    const { report, bytes, path } = await readReport(temporary);
    assert.equal(path, join(temporary, REPORT));
    assert.equal(bytes.toString('utf8'), source);
    assert.deepEqual(report, shellReport());

    const broken = { ...shellReport(), totals: { files: -1, bytes: 0, gzip: 0, brotli: 0 } };
    await assert.rejects(
      writeReport(temporary, broken),
      /totals\.files must be a non-negative integer/u,
    );
    assert.equal(
      await readFile(join(temporary, REPORT), 'utf8'),
      source,
      'a refused report never reached disk',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('a report that is not there is a filesystem error, not a contract one', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-report-missing-'));
  try {
    await assert.rejects(readReport(temporary), { code: 'ENOENT' });
    await writeFile(join(temporary, REPORT), 'not json');
    await assert.rejects(readReport(temporary), /cannot parse/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
