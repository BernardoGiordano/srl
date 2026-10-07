import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium } from 'playwright';

import { send, serveOrigin } from '../../cli/origin/index.mjs';
import { IMPORT_MAP_FILE, MOUNTS } from '../../cli/package/interface.mjs';

/** @import { IncomingMessage } from 'node:http' */

/** @param {IncomingMessage} request */
async function capture(request) {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return { method: request.method, headers: request.headers, body };
}

void test('authenticated redirects cannot send credentials or bodies beyond audience admission', async (t) => {
  /** @type {Awaited<ReturnType<typeof capture>>[]} */
  const received = [];
  const receiver = await serveOrigin({
    mounts: [],
    route: async (request, response) => {
      received.push(await capture(request));
      response.writeHead(request.method === 'OPTIONS' ? 204 : 200, {
        'Access-Control-Allow-Origin': request.headers.origin ?? '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-CSRF-Token',
        'Access-Control-Allow-Methods': 'POST',
      });
      response.end('received');
      return true;
    },
  });
  t.after(receiver.close);

  const map = await readFile(IMPORT_MAP_FILE, 'utf8');
  /** @type {Awaited<ReturnType<typeof capture>>[]} */
  const admitted = [];
  /** @type {Awaited<ReturnType<typeof capture>>[]} */
  const sameOrigin = [];
  const origin = await serveOrigin({
    mounts: MOUNTS,
    route: async (request, response, url) => {
      if (url.pathname === '/') {
        send(response, {
          type: 'text/html',
          body: Buffer.from(`<!doctype html><script type="importmap">${map}</script>`),
        });
        return true;
      }
      if (url.pathname === '/receive') {
        sameOrigin.push(await capture(request));
        response.writeHead(200).end('received');
        return true;
      }
      if (url.pathname !== '/redirect' && url.pathname !== '/ok') return false;
      admitted.push(await capture(request));
      if (url.pathname === '/ok') response.writeHead(200).end('ok');
      else if (url.searchParams.has('retry') && admitted.length === 1) response.writeHead(401).end();
      else response.writeHead(Number(url.searchParams.get('status')), {
        Location: url.searchParams.has('same') ? '/receive' : `${receiver.url}/receive`,
      }).end();
      return true;
    },
  });
  t.after(origin.close);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin.url);
  t.beforeEach(() => {
    received.length = 0;
    admitted.length = 0;
    sameOrigin.length = 0;
  });

  /**
   * @param {string} path
   * @param {{ rebuild?: boolean, redirect?: RequestRedirect, audience?: string[] }} [options]
   */
  const request = (path, options = {}) => page.evaluate(async ({ path, options }) => {
    const moduleUrl = '/lib/auth/session.js';
    const { AuthSession } = /** @type {typeof import('../../source/lib/auth/session.js')} */ (await import(moduleUrl));
    const current = { subject: 'test', name: 'Test', scopes: [], expiresAt: Date.now() + 3_600_000 };
    let authorizations = 0;
    let refreshes = 0;
    /** @type {import('../../source/lib/auth/types.js').TokenStore} */
    const store = {
      strategy: 'custom',
      init: () => Promise.resolve(current),
      login: () => Promise.resolve(current),
      logout: () => Promise.resolve(),
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(current);
      },
      authorize: async (request) => {
        authorizations += 1;
        const headers = new Headers(request.headers);
        headers.set('Authorization', 'Bearer synthetic');
        headers.set('X-Api-Key', `synthetic-${String(refreshes)}`);
        headers.set('X-CSRF-Token', 'synthetic-csrf');
        return options.rebuild
          ? new Request(request.url, { method: request.method, headers, body: await request.text(), redirect: 'follow' })
          : new Request(request, { headers });
      },
    };
    const auth = new AuthSession(store, { audience: options.audience });
    try {
      await auth.init();
      const response = await auth.fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"synthetic":true}',
        redirect: options.redirect,
      });
      return { error: '', status: response.status, body: await response.text(), authorizations, refreshes };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.name : String(cause), status: 0, body: '', authorizations, refreshes };
    } finally {
      auth.dispose();
    }
  }, { path, options });

  await t.test('the receiver accepts the same headers and body through browser CORS', async () => {
    const result = await request(`${receiver.url}/receive`, { audience: [receiver.url] });
    assert.equal(result.status, 200);
    const post = received.find((entry) => entry.method === 'POST');
    assert.ok(post !== undefined);
    assert.equal(post.headers['x-api-key'], 'synthetic-0');
    assert.equal(post.headers['x-csrf-token'], 'synthetic-csrf');
    assert.equal(post.body, '{"synthetic":true}');
  });
  for (const status of [301, 302, 303, 307, 308]) {
    await t.test(`${String(status)} is refused after a store rebuilds the request with redirect follow`, async () => {
      const result = await request(`/redirect?status=${String(status)}`, { rebuild: true, redirect: 'follow' });
      assert.equal(result.error, 'TypeError');
      assert.equal(result.authorizations, 1);
      assert.equal(result.refreshes, 0);
      assert.equal(admitted.length, 1);
      assert.equal(admitted[0]?.headers['x-api-key'], 'synthetic-0');
      assert.equal(admitted[0]?.body, '{"synthetic":true}');
      assert.deepEqual(received, [], 'no redirected request or preflight reaches the receiver');
    });
  }

  await t.test('a 401 retry refuses a 307 despite caller manual and store follow', async () => {
    const result = await request('/redirect?status=307&retry', { rebuild: true, redirect: 'manual' });
    assert.equal(result.error, 'TypeError');
    assert.equal(result.authorizations, 2);
    assert.equal(result.refreshes, 1);
    assert.deepEqual(admitted.map((entry) => entry.headers['x-api-key']), ['synthetic-0', 'synthetic-1']);
    assert.deepEqual(admitted.map((entry) => entry.body), ['{"synthetic":true}', '{"synthetic":true}']);
    assert.deepEqual(received, []);
  });

  await t.test('a same-origin redirect is refused with default request options', async () => {
    const result = await request('/redirect?status=307&same');
    assert.equal(result.error, 'TypeError');
    assert.deepEqual(sameOrigin, []);
  });

  await t.test('a successful authorized POST still sends the body and credentials', async () => {
    const result = await request('/ok', { rebuild: true });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'ok');
    assert.equal(admitted[0]?.headers['x-csrf-token'], 'synthetic-csrf');
    assert.equal(admitted[0]?.body, '{"synthetic":true}');
  });

  await t.test('an initial request outside the audience retains ordinary redirect behavior', async () => {
    const result = await request('/redirect?status=307', { audience: [], redirect: 'follow' });
    assert.equal(result.status, 200);
    assert.equal(result.authorizations, 0);
    const post = received.find((entry) => entry.method === 'POST');
    assert.ok(post !== undefined);
    assert.equal(post.headers['x-api-key'], undefined);
    assert.equal(post.headers['x-csrf-token'], undefined);
    assert.equal(post.body, '{"synthetic":true}');
  });
});
