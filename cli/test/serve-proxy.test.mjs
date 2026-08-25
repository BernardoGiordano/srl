import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
 * Spawned rather than imported: the module reads process.argv and listens on a
 * port at import time, so a second case in one process would inherit the first
 * one's flags.
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

/** A port nothing is listening on: bind to 0, ask which one that was, release it. */
async function freePort() {
  const probe = createSocketServer();
  await new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => { resolve(undefined); });
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * The server, on a free port, with the given --proxy arguments. Resolves once it
 * has printed its startup table, which is the only thing that says it is listening.
 *
 * @param {string[]} proxies
 */
async function serve(proxies) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [SERVE, '--app', 'example', '--port', String(port), '--no-watch',
      ...proxies.flatMap((value) => ['--proxy', value])],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('server did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('watch disabled')) { clearTimeout(fail); resolve(undefined); }
    });
    child.on('exit', (code) => { clearTimeout(fail); reject(new Error(`server exited ${String(code)}`)); });
  });

  return { base: `http://127.0.0.1:${String(port)}`, close: () => { child.kill(); } };
}

void test('--proxy forwards the method, the body, the query and the cookie', async () => {
  const api = await upstream();
  const server = await serve([`/api/=${api.origin}`]);
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
    server.close();
    api.close();
  }
});

void test('an upstream 404 stays a 404, rather than becoming the history fallback', async () => {
  const api = await upstream();
  const server = await serve([`/api/=${api.origin}`]);
  try {
    const response = await fetch(`${server.base}/api/missing`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json');
  } finally {
    server.close();
    api.close();
  }
});

void test('Set-Cookie reaches the browser with its attributes intact', async () => {
  const api = await upstream();
  const server = await serve([`/auth/=${api.origin}`]);
  try {
    const response = await fetch(`${server.base}/auth/session`, { redirect: 'manual' });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /^session=opaque; Path=\/; HttpOnly; SameSite=Lax$/u);
  } finally {
    server.close();
    api.close();
  }
});

void test('a prefix matches on a segment boundary, so /api does not claim /apiary', async () => {
  const api = await upstream();
  const server = await serve([`/api=${api.origin}`]);
  try {
    const proxied = await fetch(`${server.base}/api/site`);
    assert.equal(proxied.status, 200);

    // Nothing serves /apiary either, but a 404 from disk and a 200 from the
    // upstream echo are different answers and only one of them is right.
    const notProxied = await fetch(`${server.base}/apiary`);
    assert.equal(notProxied.status, 404);
  } finally {
    server.close();
    api.close();
  }
});

void test('a backend that is not running is a 502 naming the origin', async () => {
  const server = await serve(['/api/=http://127.0.0.1:9']);
  try {
    const response = await fetch(`${server.base}/api/site`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'backend_unavailable');
    assert.match(body.detail, /127\.0\.0\.1:9/u);
  } finally {
    server.close();
  }
});

void test('the static mounts and the history fallback are untouched by a proxy', async () => {
  const api = await upstream();
  const server = await serve([`/api/=${api.origin}`]);
  try {
    assert.equal((await fetch(`${server.base}/`)).status, 200);
    assert.equal((await fetch(`${server.base}/some/spa/route`, { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await fetch(`${server.base}/does-not-exist.js`)).status, 404);
  } finally {
    server.close();
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
