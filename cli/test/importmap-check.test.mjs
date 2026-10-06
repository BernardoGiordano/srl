import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkImportMaps } from '../checks/importmap-check.mjs';
import { errors } from '../diagnostics/index.mjs';
import { PROBE_PIN, PROBE_URL, importMapFragment, mountedFile } from '../package/interface.mjs';
import { PROBE_PIN as RUNTIME_PROBE_PIN } from '@srljs/core/lib/core/foundation/pins.js';

/**
 * The probe is the one entry pinned to bytes it doesn't have, so the check compares
 * its pin to the sentinel and refuses the sentinel anywhere else. ADR-0129.
 */

/**
 * An application whose map is the library fragment with `edit` applied.
 *
 * @param {(map: { imports: Record<string, string>, integrity: Record<string, string> }) => void} edit
 */
async function application(edit) {
  const dir = await mkdtemp(join(tmpdir(), 'srl-importmap-'));
  const map = await importMapFragment();
  edit(map);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'main.js'), 'export {};\n');
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html><head><script type="importmap">${JSON.stringify(map)}</script>` +
      '<script type="module" src="/src/main.js"></script></head><body></body></html>\n',
  );
  return { name: 'probe-app', dir };
}

/** @param {{ name: string, dir: string }} app */
async function codes(app) {
  try {
    return errors(await checkImportMaps({ apps: [app] })).map((diagnostic) => diagnostic.code);
  } finally {
    await rm(app.dir, { recursive: true, force: true });
  }
}

void test('the fragment pins the probe to the sentinel, and the check accepts it', async () => {
  const fragment = await importMapFragment();
  assert.equal(fragment.integrity[PROBE_URL], PROBE_PIN);
  assert.deepEqual(await codes(await application(() => {})), []);
});

void test('a probe pinned to its own bytes is refused', async () => {
  const probe = mountedFile(PROBE_URL);
  assert.ok(probe !== null);
  const actual = `sha384-${createHash('sha384').update(await readFile(probe)).digest('base64')}`;
  const found = await codes(
    await application((map) => {
      map.integrity[PROBE_URL] = actual;
    }),
  );
  assert.deepEqual(found, ['importmap/probe-pin']);
});

void test('the sentinel on any other URL is refused', async () => {
  const found = await codes(
    await application((map) => {
      map.integrity['/src/main.js'] = PROBE_PIN;
    }),
  );
  assert.deepEqual(found, ['importmap/sentinel-pin']);
});

void test('the CLI and the runtime agree on the probe pin', () => {
  assert.equal(PROBE_PIN, RUNTIME_PROBE_PIN);
});
