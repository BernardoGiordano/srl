import assert from 'node:assert/strict';
import test from 'node:test';

import { testRunnerConfig } from '../testing/web-test-runner.mjs';

/**
 * The preset's first middleware. The runner binds every interface and serves the
 * repository root, so this is what keeps `.git/` and a rebinding page out. ADR-0131.
 */

/**
 * What the first middleware does with one request, as the status it set or `next`.
 *
 * @param {{ peer?: string, host?: string, path?: string }} request
 * @returns {Promise<number | 'next'>}
 */
async function admit({ peer = '127.0.0.1', host = 'localhost:8000', path = '/example/src/main.js' }) {
  const [first] = testRunnerConfig({ app: 'example' }).middleware ?? [];
  assert.ok(first !== undefined);
  const ctx = {
    req: { socket: { remoteAddress: peer } },
    path,
    url: path,
    status: 0,
    get: (/** @type {string} */ name) => (name === 'host' ? host : ''),
  };
  let passed = false;
  await first(/** @type {never} */ (ctx), () => {
    passed = true;
    return Promise.resolve();
  });
  return passed ? 'next' : ctx.status;
}

void test('the runner answers a loopback peer addressing a loopback name', async () => {
  assert.equal(await admit({}), 'next');
  assert.equal(await admit({ peer: '::1', host: '127.0.0.1:8000' }), 'next');
  assert.equal(await admit({ peer: '::ffff:127.0.0.1' }), 'next');
});

void test('a peer on the network and a rebound hostname are refused', async () => {
  assert.equal(await admit({ peer: '192.168.1.20' }), 403);
  assert.equal(await admit({ peer: '::ffff:10.0.0.2' }), 403);
  assert.equal(await admit({ host: 'rebound.example:8000' }), 403);
  assert.equal(await admit({ host: '' }), 403);
});

void test('a dotfile is a 404, however it is spelled', async () => {
  for (const path of ['/.git/config', '/.env', '/%2egit/HEAD', '/example/.env', '/%E0%A4%A']) {
    assert.equal(await admit({ path }), 404, path);
  }
  assert.equal(await admit({ path: '/.well-known/security.txt' }), 'next');
});
