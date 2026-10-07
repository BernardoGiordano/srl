import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkImportMaps } from '../checks/importmap-check.mjs';
import { errors } from '../diagnostics/index.mjs';
import { PROBE_CONTROL_PIN, PROBE_CONTROL_URL, PROBE_EMPTY_URL, PROBE_PIN, PROBE_URL, importMapFragment } from '../package/interface.mjs';
import * as runtime from '@srljs/core/lib/core/foundation/pins.js';

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
  const actual = PROBE_CONTROL_PIN;
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

void test('the CLI and runtime agree on fixed probe bytes and pins', () => {
  for (const [name, value] of Object.entries({ PROBE_URL, PROBE_CONTROL_URL, PROBE_EMPTY_URL, PROBE_PIN, PROBE_CONTROL_PIN })) {
    assert.equal(runtime[/** @type {keyof typeof runtime} */ (name)], value);
  }
  for (const [url, pin] of [[PROBE_CONTROL_URL, PROBE_CONTROL_PIN], [PROBE_EMPTY_URL, PROBE_PIN]]) {
    const bytes = decodeURIComponent(new URL(/** @type {string} */ (url)).pathname.split(',')[1] ?? '');
    assert.equal(`sha384-${createHash('sha384').update(bytes).digest('base64')}`, pin);
  }
});

void test('missing or edited matching controls are refused', async () => {
  for (const url of [PROBE_CONTROL_URL, PROBE_EMPTY_URL]) {
    assert.deepEqual(await codes(await application((map) => { delete map.integrity[url]; })), ['importmap/edited-hash']);
    assert.deepEqual(await codes(await application((map) => { map.integrity[url] = 'sha384-invalid'; })), ['importmap/edited-hash']);
  }
});
