'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { findServer } = require('../server-path.cjs');

test('finds the language server in an srl checkout', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  assert.equal(findServer(root), path.join(root, 'cli', 'language-server', 'server.mjs'));
});

test('returns null outside an srl project', () => {
  assert.equal(findServer(__dirname), null);
});
