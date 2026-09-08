'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve the language server shipped by this repository or by the project's own
 * @srljs/cli. Using the project copy keeps the template grammar version-aligned.
 *
 * @param {string} root
 * @returns {string | null}
 */
function findServer(root) {
  const candidates = [
    path.join(root, 'cli', 'language-server', 'server.mjs'),
    path.join(root, 'node_modules', '@srljs', 'cli', 'language-server', 'server.mjs'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** The manifest fields a dependency can be declared in. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Whether the folder's own manifest asks for srl.
 *
 * A folder that names `@srljs/cli` but has no server on disk has dependencies to install,
 * which is worth saying. A folder that names neither package is not an srl project at
 * all, and a window that opens one HTML file should not be told its toolchain is broken.
 *
 * @param {string} root
 * @returns {boolean}
 */
function declaresSrl(root) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  return DEPENDENCY_FIELDS.some((field) => {
    const declared = manifest?.[field];
    if (declared === null || typeof declared !== 'object') return false;
    return declared['@srljs/cli'] !== undefined || declared['@srljs/core'] !== undefined;
  });
}

/**
 * What one folder offers: the server to start, and whether its absence is a problem the
 * folder's owner can act on.
 *
 * @param {string} root
 * @returns {{ server: string | null, declared: boolean }}
 */
function locate(root) {
  const server = findServer(root);
  return { server, declared: server !== null || declaresSrl(root) };
}

module.exports = { declaresSrl, findServer, locate };
