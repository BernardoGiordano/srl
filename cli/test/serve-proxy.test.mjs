import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { serveApplication } from '../dev/serve.mjs';
import { apps } from '../layout.mjs';

/**
 * `srl serve --proxy`, against a real upstream over a real socket.
 *
 * The behaviour worth pinning is not "a request arrives" — it is everything the
 * static branch of that server would otherwise do to an API request, and each of
 * these has a wrong answer that looks like an application bug rather than a server
 * one:
 *
 *   a POST                 answered 405 by the static branch, because that is the
 *                          correct answer for a file and the wrong one for an API
 *   an upstream 404        turned into index.html by the history fallback, so a
 *                          missing endpoint reads as JSON.parse failing on '<'
 *   Set-Cookie             the BFF session, and a session is only returned to the
 *                          origin that set it — the reason to proxy at all
 *   /apiary                caught by a /api prefix that matched on characters
 *   a backend not running  the ordinary case, and it has to say so
 *
 * Imported rather than spawned. `serveApplication` takes the application and its
 * proxies and binds an ephemeral port, so a case states its own backend instead of
 * inheriting flags from a child process and waiting for a startup line on its
 * stdout. ADR-0075. One case is still spawned, and has to be: a malformed `--proxy`
 * is refused with an exit code, and an exit code needs a process.
 */

const SERVE = fileURLToPath(new URL('../dev/serve.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** An upstream that echoes what it received, so the assertions can be about the forwarding. */
async function upstream() {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      if (request.url === '/api/missing') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"no such endpoint"}');
        return;
      }
      if (request.url === '/auth/session') {
        response.writeHead(204, { 'Set-Cookie': 'session=opaque; Path=/; HttpOnly; SameSite=Lax' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        method: request.method,
        url: request.url,
        body,
        cookie: request.headers.cookie ?? null,
      }));
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(undefined); });
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { origin: `http://127.0.0.1:${String(port)}`, close: () => { server.close(); } };
}

/**
 * The example application, served on an ephemeral port with the given proxies and
 * no watching: a suite has nothing to reload and a recursive watch of the
 * repository is the slowest thing this file could do.
 *
 * @param {Array<{ prefix: string, origin: string }>} proxies
 */
async function serve(proxies) {
  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'the example application is missing');
  const server = await serveApplication({
    app,
    port: 0,
    host: '127.0.0.1',
    watch: false,
    proxies: proxies.map(({ prefix, origin }) => ({ prefix, origin: new URL(origin) })),
  });
  return { base: server.url, close: server.close };
}

void test('--proxy forwards the method, the body, the query and the cookie', async () => {
  const api = await upstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    const response = await fetch(`${server.base}/api/posts?draft=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'session=opaque' },
      body: '{"title":"hello"}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      method: 'POST',
      url: '/api/posts?draft=1',
      body: '{"title":"hello"}',
      cookie: 'session=opaque',
    });
  } finally {
    await server.close();
    api.close();
  }
});

void test('an upstream 404 stays a 404, rather than becoming the history fallback', async () => {
  const api = await upstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    const response = await fetch(`${server.base}/api/missing`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json');
  } finally {
    await server.close();
    api.close();
  }
});

void test('Set-Cookie reaches the browser with its attributes intact', async () => {
  const api = await upstream();
  const server = await serve([{ prefix: '/auth', origin: api.origin }]);
  try {
    const response = await fetch(`${server.base}/auth/session`, { redirect: 'manual' });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /^session=opaque; Path=\/; HttpOnly; SameSite=Lax$/u);
  } finally {
    await server.close();
    api.close();
  }
});

void test('a prefix matches on a segment boundary, so /api does not claim /apiary', async () => {
  const api = await upstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    const proxied = await fetch(`${server.base}/api/site`);
    assert.equal(proxied.status, 200);

    // Nothing serves /apiary either, but a 404 from disk and a 200 from the
    // upstream echo are different answers and only one of them is right.
    const notProxied = await fetch(`${server.base}/apiary`);
    assert.equal(notProxied.status, 404);
  } finally {
    await server.close();
    api.close();
  }
});

void test('a backend that is not running is a 502 naming the origin', async () => {
  const server = await serve([{ prefix: '/api', origin: 'http://127.0.0.1:9' }]);
  try {
    const response = await fetch(`${server.base}/api/site`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'backend_unavailable');
    assert.match(body.detail, /127\.0\.0\.1:9/u);
  } finally {
    await server.close();
  }
});

void test('the static mounts and the history fallback are untouched by a proxy', async () => {
  const api = await upstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    assert.equal((await fetch(`${server.base}/`, { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await fetch(`${server.base}/some/spa/route`, { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await fetch(`${server.base}/does-not-exist.js`)).status, 404);
  } finally {
    await server.close();
    api.close();
  }
});

void test('a malformed --proxy is refused at startup, not at the first request', async () => {
  for (const bad of ['/api', 'api/=http://127.0.0.1:1', '/api/=notaurl', '/api/=ftp://host/']) {
    const child = spawn(process.execPath, [SERVE, '--app', 'example', '--proxy', bad], {
      cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1, `${bad} should exit 1`);
    assert.match(stderr, /--proxy/u, `${bad} should say which flag was wrong`);
  }
});
