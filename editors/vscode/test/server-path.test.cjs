'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findServer, locate } = require('../server-path.cjs');

test('finds the language server in an srl checkout', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  assert.equal(findServer(root), path.join(root, 'cli', 'language-server', 'server.mjs'));
});

test('returns null outside an srl project', () => {
  assert.equal(findServer(__dirname), null);
});

test('a folder with the server installed is worth serving', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  assert.deepEqual(findServer(root) === null, false);
  assert.equal(locate(root).declared, true);
});

test('a folder that declares no srl dependency is not reported as broken', () => {
  assert.deepEqual(locate(__dirname), { server: null, declared: false });
});

test('a declared srl dependency with nothing installed is reported', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-locate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@srljs/cli': '0.9.0' } }),
  );
  assert.deepEqual(locate(root), { server: null, declared: true });
});
