import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { serveApplication } from '../dev/serve.mjs';
import { apps } from '../layout.mjs';

/**
 * `srl serve --proxy`, against a real upstream over a real socket.
 *
 * The behaviour worth pinning is everything the static branch of that server would
 * otherwise do to an API request, rather than whether a request arrives. Each of
 * these has a wrong answer that looks like an application bug rather than a server
 * one:
 *
 *   a POST                 answered 405 by the static branch, because that is the
 *                          correct answer for a file and the wrong one for an API
 *   an upstream 404        turned into index.html by the history fallback, so a
 *                          missing endpoint reads as JSON.parse failing on '<'
 *   Set-Cookie             the BFF session, and a session is only returned to the
 *                          origin that set it, which is the reason to proxy at all
 *   /apiary                caught by a /api prefix that matched on characters
 *   a backend not running  the ordinary case, and it has to say so
 *
 * Imported rather than spawned. `serveApplication` takes the application and its
 * proxies and binds an ephemeral port, so a case states its own backend instead of
 * inheriting flags from a child process and waiting for a startup line on its stdout.
 * ADR-0075. One case is still spawned and has to be, because a malformed `--proxy` is
 * refused with an exit code and an exit code needs a process.
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
 * The example application, served on an ephemeral port with the given proxies and no
 * watching. A suite has nothing to reload, and a recursive watch of the repository is
 * the slowest thing this file could do.
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

void test('a rebound hostname never reaches the backend, and the server binds loopback by default', async () => {
  /** @type {string[]} */
  const seen = [];
  const api = createServer((incoming, response) => {
    seen.push(incoming.headers.host ?? '');
    response.end('{}');
  });
  await new Promise((resolve) => {
    api.listen(0, '127.0.0.1', () => { resolve(undefined); });
  });
  const { port: apiPort } = /** @type {import('node:net').AddressInfo} */ (api.address());

  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'the example application is missing');
  const server = await serveApplication({
    app,
    port: 0,
    watch: false,
    proxies: [{ prefix: '/api', origin: new URL(`http://127.0.0.1:${String(apiPort)}`) }],
  });

  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:/u);

    // The proxy rewrites Host to the upstream's, so a backend that checks Host
    // itself would see 127.0.0.1 here. The origin refuses first.
    const status = await new Promise((done, failed) => {
      request(`${server.url}/api/me`, { headers: { host: `rebound.example:${String(server.port)}` } }, (response) => {
        response.resume();
        done(response.statusCode);
      })
        .on('error', failed)
        .end();
    });
    assert.equal(status, 403);
    assert.deepEqual(seen, []);

    assert.equal((await fetch(`${server.url}/api/me`)).status, 200);
    assert.equal(seen.length, 1);
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

/* ── Upgrades ─────────────────────────────────────────────────────────────
 *
 * A toy protocol rather than WebSocket framing, because the proxy joins two sockets
 * and never reads what crosses them. The upstream records what it was asked, echoes
 * every byte back, and declines one path with an ordinary response.
 */

/** A proxy that never answers an upgrade leaves the page waiting, so a case fails rather than hangs. */
const UPGRADE = { timeout: 10_000 };

/** An upstream that switches to an echo protocol and records each upgrade it is asked for. */
async function upgradingUpstream() {
  /** @type {Array<{ url: string, host: string, origin: string | null }>} */
  const seen = [];
  const server = createServer((_request, response) => {
    response.writeHead(426).end();
  });
  server.on('upgrade', (incoming, socket) => {
    seen.push({
      url: incoming.url ?? '',
      host: incoming.headers.host ?? '',
      origin: incoming.headers.origin ?? null,
    });
    if (incoming.url === '/api/refused') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 6\r\n\r\norigin');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(undefined); });
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    host: `127.0.0.1:${String(port)}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * Ask for an upgrade, and settle with the 101 and its socket or with the response
 * that declined it.
 *
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number | undefined, socket?: import('node:stream').Duplex, body?: string }>}
 */
function askUpgrade(url, headers = {}) {
  return new Promise((done, failed) => {
    const asked = request(url, { headers: { Connection: 'Upgrade', Upgrade: 'echo', ...headers } });
    asked.on('upgrade', (response, socket) => {
      done({ status: response.statusCode, socket });
    });
    asked.on('response', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += String(chunk); });
      response.on('end', () => { done({ status: response.statusCode, body }); });
    });
    asked.on('error', failed);
    asked.end();
  });
}

/** @param {import('node:stream').Duplex} socket @returns {Promise<string>} */
function nextChunk(socket) {
  return new Promise((done) => {
    socket.once('data', (chunk) => { done(String(chunk)); });
  });
}

void test('an upgrade under a proxied prefix joins the page and the backend', UPGRADE, async () => {
  const api = await upgradingUpstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  const page = server.base.replace('127.0.0.1', 'localhost');
  try {
    const answer = await askUpgrade(`${server.base}/api/socket?room=1`, { Origin: page });
    assert.equal(answer.status, 101);
    const socket = answer.socket;
    assert.ok(socket !== undefined);
    socket.write('ping');
    assert.equal(await nextChunk(socket), 'ping');
    socket.destroy();

    // Host names the upstream, as it does for a request. Origin is the page's,
    // untouched, because the backend's own check decides who may connect.
    assert.deepEqual(api.seen, [{ url: '/api/socket?room=1', host: api.host, origin: page }]);
  } finally {
    await server.close();
    api.close();
  }
});

void test('a backend that declines an upgrade answers the page itself', UPGRADE, async () => {
  const api = await upgradingUpstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    const answer = await askUpgrade(`${server.base}/api/refused`);
    assert.equal(answer.status, 403);
    assert.equal(answer.body, 'origin');
  } finally {
    await server.close();
    api.close();
  }
});

void test('an upgrade meets Host admission and is forwarded only under a proxied prefix', UPGRADE, async () => {
  const api = await upgradingUpstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    const rebound = await askUpgrade(`${server.base}/api/socket`, {
      Host: `rebound.example:${new URL(server.base).port}`,
    });
    assert.equal(rebound.status, 403);

    const unproxied = await askUpgrade(`${server.base}/socket`);
    assert.equal(unproxied.status, 404);

    assert.deepEqual(api.seen, []);
  } finally {
    await server.close();
    api.close();
  }
});

void test('a backend that is not running refuses an upgrade with a 502', UPGRADE, async () => {
  const server = await serve([{ prefix: '/api', origin: 'http://127.0.0.1:9' }]);
  try {
    const answer = await askUpgrade(`${server.base}/api/socket`);
    assert.equal(answer.status, 502);
  } finally {
    await server.close();
  }
});

void test('closing the server ends a joined socket', UPGRADE, async () => {
  const api = await upgradingUpstream();
  const server = await serve([{ prefix: '/api', origin: api.origin }]);
  try {
    const answer = await askUpgrade(`${server.base}/api/socket`);
    const socket = answer.socket;
    assert.ok(socket !== undefined);
    const closed = new Promise((done) => socket.once('close', done));
    await server.close();
    await closed;
  } finally {
    api.close();
  }
});
