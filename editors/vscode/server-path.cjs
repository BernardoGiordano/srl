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

module.exports = { findServer };
