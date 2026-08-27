/**
 * The door rule: which exports a marker removes, and which forms it refuses.
 *
 * Every case is a string rather than a file, because the rule is a function of one
 * module's text and nothing else — no manifest, no resolution, no build. The
 * emitted bundles are checked separately, against their own bytes, in
 * `tools/test/package-bundle.test.mjs`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { barrelSource, moduleDoor } from '../package/door.mjs';

void test('every top-level export is in the door until something says otherwise', () => {
  const door = moduleDoor(
    [
      'const hidden = 1;',
      'export const A = 1;',
      'export function b() {}',
      'export class C {}',
      "export { d, e } from './x.js';",
      'export const f = 1, g = 2;',
    ].join('\n'),
    'x.js',
  );

  assert.deepEqual(door.names, ['A', 'b', 'C', 'd', 'e', 'f', 'g']);
  assert.deepEqual(door.internal, []);
});

void test('a marked declaration leaves the door and keeps its export', () => {
  const door = moduleDoor(
    [
      '/** Public. */',
      'export function open() {}',
      '',
      '/**',
      ' * Exported for tests.',
      ' *',
      ' * @internal',
      ' */',
      'export function shut() {}',
      '',
      '/** @internal */',
      'export const ALSO = 1;',
    ].join('\n'),
    'x.js',
  );

  assert.deepEqual(door.names, ['open', 'shut', 'ALSO']);
  assert.deepEqual(door.internal, ['shut', 'ALSO']);
});

void test('one marker over one statement marks every name it declares', () => {
  const door = moduleDoor('/** @internal */\nexport const A = 1, B = 2;\n', 'x.js');
  assert.deepEqual(door.internal, ['A', 'B']);
});

void test('a module header does not mark the export beneath it', () => {
  // TypeScript attaches every preceding JSDoc block to a statement, blank line or
  // not, so without the adjacency rule a header that happened to use the word
  // would mark the first export and silently nothing else.
  const door = moduleDoor(
    ['/**', ' * A module of helpers.', ' *', ' * @internal', ' */', '', 'export const A = 1;'].join(
      '\n',
    ),
    'x.js',
  );
  assert.deepEqual(door.internal, []);
});

void test('the forms that would make the door quietly wrong are refused', () => {
  assert.throws(() => moduleDoor("export * from './x.js';", 'x.js'), /export \*/u);
  assert.throws(() => moduleDoor("export * as x from './x.js';", 'x.js'), /namespace object/u);
  assert.throws(() => moduleDoor('export default function () {}', 'x.js'), /default export/u);
  assert.throws(() => moduleDoor('const o = {};\nexport const { a } = o;', 'x.js'), /pattern/u);
});

void test('a member that keeps nothing back is re-exported whole', () => {
  assert.equal(
    barrelSource([{ file: '/lib/a.js', door: { names: ['x', 'y'], internal: [] } }]),
    'export * from "/lib/a.js";\n',
  );
});

void test('a member that marks a name is listed instead, in source order', () => {
  assert.equal(
    barrelSource([{ file: '/lib/a.js', door: { names: ['x', 'y', 'z'], internal: ['y'] } }]),
    'export { x, z } from "/lib/a.js";\n',
  );
});

void test('a member that keeps everything back is still imported for its side effects', () => {
  assert.equal(
    barrelSource([{ file: '/lib/a.js', door: { names: ['x'], internal: ['x'] } }]),
    'import "/lib/a.js";\n',
  );
});

void test('the library marks the names its own comments call internal', () => {
  // A tripwire on the rule reaching real source, not a list to keep in step: the
  // door of the whole package is asserted against the emitted bundle.
  const dialect = new URL('../../source/lib/core/template/dialect.js', import.meta.url);
  const door = moduleDoor(readFileSync(dialect, 'utf8'), 'dialect.js');

  assert.ok(door.names.includes('FOR_HEAD'));
  assert.deepEqual(
    door.names.filter((name) => !door.internal.includes(name)),
    [],
    'the template dialect is a grammar two implementations share, not an application surface',
  );
});
