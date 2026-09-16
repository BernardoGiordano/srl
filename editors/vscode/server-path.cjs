'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Find the project's language server, preferring its installed `@srljs/cli`.
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
 * Check whether the folder declares srl in its manifest.
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
 * Return the server path and whether the folder declares srl.
 *
 * @param {string} root
 * @returns {{ server: string | null, declared: boolean }}
 */
function locate(root) {
  const server = findServer(root);
  return { server, declared: server !== null || declaresSrl(root) };
}

module.exports = { declaresSrl, findServer, locate };
