import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveMount, serveOrigin, toFile } from '../origin/index.mjs';

/**
 * The rules every server over `cli/origin/` shares, asserted once.
 *
 * Before this module existed each of them was asserted nowhere: the traversal guard was
 * copy-pasted into four servers and the only suite that exercised any of it drove a real
 * Chrome over a real production build. ADR-0075.
 *
 * A directory tree and `fetch`, no browser and no build:
 *
 *   <root>/lib/core/reactive.js   a mounted library file
 *   <root>/app/index.html         the application document, and the history fallback
 *   <root>/app/main.js
 *   <root>/app/nested/index.html  a directory index
 *   <root>/secret.txt             outside every mount, which is the point
 */

/** @param {(fixture: { root: string, mounts: Array<[string, string]>, appDir: string }) => Promise<void>} run */
async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'srl-origin-'));
  try {
    const appDir = join(root, 'app');
    await mkdir(join(root, 'lib', 'core'), { recursive: true });
    await mkdir(join(appDir, 'nested'), { recursive: true });
    await writeFile(join(root, 'lib', 'core', 'reactive.js'), 'export const reactive = 1;\n');
    await writeFile(join(appDir, 'index.html'), '<!doctype html><body>application</body>\n');
    await writeFile(join(appDir, 'main.js'), 'export const main = 1;\n');
    await writeFile(join(appDir, 'nested', 'index.html'), '<!doctype html><body>nested</body>\n');
    await writeFile(join(root, 'secret.txt'), 'not yours\n');
    await run({
      root,
      appDir,
      mounts: [
        ['/lib/', join(root, 'lib')],
        ['/', appDir],
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * @param {import('../origin/types.js').OriginOptions} options
 * @param {(url: string) => Promise<void>} run
 */
async function withOrigin(options, run) {
  const origin = await serveOrigin(options);
  try {
    await run(origin.url);
  } finally {
    await origin.close();
  }
}

/** A navigation, which is the only request the history fallback may answer. */
const NAVIGATION = { headers: { Accept: 'text/html,application/xhtml+xml' } };

void test('resolveMount takes the first prefix that matches, on a segment boundary', () => {
  /** @type {Array<[string, string]>} */
  const mounts = [
    ['/lib/', '/packages/lib'],
    ['/app.manifest.json', '/example/app.manifest.json'],
    ['/', '/example'],
  ];

  assert.deepEqual(resolveMount('/lib/core/reactive.js', mounts), {
    prefix: '/lib/',
    target: '/packages/lib',
    rest: 'core/reactive.js',
  });

  // A prefix that is a whole path matches itself and nothing it is a substring of.
  assert.equal(resolveMount('/app.manifest.json', mounts)?.target, '/example/app.manifest.json');
  assert.equal(resolveMount('/app.manifest.jsonx', mounts)?.target, '/example');

  // /libraries is not /lib/, and `/` matches everything, which is why it is last.
  assert.deepEqual(resolveMount('/libraries/x.js', mounts), {
    prefix: '/',
    target: '/example',
    rest: 'libraries/x.js',
  });

  assert.equal(resolveMount('/anything', [['/lib/', '/packages/lib']]), null);
});

void test('toFile refuses a path that climbs out of its mount', async () => {
  await withFixture(({ root, mounts, appDir }) => {
    assert.equal(toFile('/lib/core/reactive.js', mounts), join(root, 'lib', 'core', 'reactive.js'));
    assert.equal(toFile('/main.js', mounts), join(appDir, 'main.js'));

    // The candidate is re-checked against the directory it resolved into, so a
    // decoded traversal leaves the mount and is refused rather than climbing out.
    assert.equal(toFile('/lib/..%2f..%2fsecret.txt', mounts), null);
    assert.equal(toFile('/lib/../../secret.txt', mounts), null);

    // Neither of these is a 500: both are requests a caller can send.
    assert.equal(toFile('/lib/%zz', mounts), null);
    assert.equal(toFile('/lib/core%00.js', mounts), null);
    return Promise.resolve();
  });
});

void test('a mount serves its file, typed by extension', async () => {
  await withFixture(async ({ mounts }) => {
    await withOrigin({ mounts }, async (url) => {
      const response = await fetch(`${url}/lib/core/reactive.js`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), 'export const reactive = 1;\n');
    });
  });
});

void test('a traversal is 403 and a malformed escape is not a 500', async () => {
  await withFixture(async ({ mounts }) => {
    await withOrigin({ mounts }, async (url) => {
      assert.equal((await fetch(`${url}/lib/..%2f..%2fsecret.txt`)).status, 403);
      assert.equal((await fetch(`${url}/lib/%zz`)).status, 403);
    });
  });
});

void test('a directory is answered with its index.html', async () => {
  await withFixture(async ({ mounts }) => {
    await withOrigin({ mounts }, async (url) => {
      const response = await fetch(`${url}/nested/`, NAVIGATION);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.match(await response.text(), /nested/u);
    });
  });
});

void test('the history fallback answers navigations and nothing else', async () => {
  await withFixture(async ({ mounts, appDir }) => {
    await withOrigin({ mounts, fallback: join(appDir, 'index.html') }, async (url) => {
      const navigation = await fetch(`${url}/orders/42`, NAVIGATION);
      assert.equal(navigation.status, 200);
      assert.match(await navigation.text(), /application/u);

      // A missing .js must stay a 404, or a typo in an import silently returns HTML
      // and the error becomes "Unexpected token '<'" somewhere unrelated.
      assert.equal((await fetch(`${url}/src/gone.js`, NAVIGATION)).status, 404);

      // And a fetch of a missing endpoint must not be handed a page either.
      assert.equal((await fetch(`${url}/orders/42`)).status, 404);
    });
  });
});

void test('with no fallback a navigation is a 404', async () => {
  await withFixture(async ({ mounts }) => {
    await withOrigin({ mounts }, async (url) => {
      assert.equal((await fetch(`${url}/orders/42`, NAVIGATION)).status, 404);
    });
  });
});

void test('anything but GET or HEAD is 405, and route sees it first', async () => {
  await withFixture(async ({ mounts }) => {
    await withOrigin({ mounts }, async (url) => {
      const refused = await fetch(`${url}/main.js`, { method: 'POST', body: 'x' });
      assert.equal(refused.status, 405);
      assert.equal(refused.headers.get('allow'), 'GET, HEAD');
    });

    // The reason `route` is consulted before the method check: a POST to a proxied
    // API must reach the backend, not the answer that is correct for a file.
    await withOrigin(
      {
        mounts,
        route: (request, response, requested) => {
          if (!requested.pathname.startsWith('/api/')) return false;
          response.writeHead(201, { 'Content-Type': 'text/plain' }).end(request.method ?? '');
          return true;
        },
      },
      async (url) => {
        const answered = await fetch(`${url}/api/session`, { method: 'POST', body: 'x' });
        assert.equal(answered.status, 201);
        assert.equal(await answered.text(), 'POST');
      },
    );
  });
});

void test('a transform replaces the body and describes it, and headers override the default', async () => {
  await withFixture(async ({ mounts, appDir }) => {
    const entry = join(appDir, 'index.html');
    const injected = Buffer.from('<!doctype html><body>application<script></script></body>\n');

    await withOrigin(
      {
        mounts,
        fallback: entry,
        headers: (_pathname, file) => ({
          'Cache-Control': file === entry ? 'private, no-cache' : 'public, max-age=31536000, immutable',
          ...(file === entry ? { 'Content-Security-Policy': "default-src 'self'" } : {}),
        }),
        transform: (file) =>
          file === entry ? { body: injected, headers: { 'X-Injected': 'yes' } } : null,
      },
      async (url) => {
        const document = await fetch(`${url}/`, NAVIGATION);
        assert.equal(document.status, 200);
        assert.equal(document.headers.get('x-injected'), 'yes');
        assert.equal(document.headers.get('cache-control'), 'private, no-cache');
        assert.equal(document.headers.get('content-security-policy'), "default-src 'self'");
        // The length is the transformed body's, not the file's.
        assert.equal(document.headers.get('content-length'), String(injected.byteLength));
        assert.equal(await document.text(), injected.toString());

        const asset = await fetch(`${url}/main.js`);
        assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      },
    );
  });
});

void test('HEAD carries the length and no body, transformed or streamed', async () => {
  await withFixture(async ({ mounts, appDir }) => {
    const entry = join(appDir, 'index.html');
    const injected = Buffer.from('<!doctype html><body>injected</body>\n');

    await withOrigin(
      {
        mounts,
        transform: (file) => (file === entry ? { body: injected } : null),
      },
      async (url) => {
        const streamed = await fetch(`${url}/main.js`, { method: 'HEAD' });
        assert.equal(streamed.status, 200);
        assert.equal(streamed.headers.get('content-length'), String('export const main = 1;\n'.length));
        assert.equal(await streamed.text(), '');

        const transformed = await fetch(`${url}/`, { method: 'HEAD' });
        assert.equal(transformed.headers.get('content-length'), String(injected.byteLength));
        assert.equal(await transformed.text(), '');
      },
    );
  });
});

void test('a streamed file carries a validator, and a conditional request is a 304', async () => {
  await withFixture(async ({ mounts }) => {
    await withOrigin({ mounts, headers: () => ({ 'Cache-Control': 'no-cache' }) }, async (url) => {
      const first = await fetch(`${url}/lib/core/reactive.js`);
      const etag = first.headers.get('etag') ?? '';
      assert.match(etag, /^W\/".+"$/u);
      assert.equal(await first.text(), 'export const reactive = 1;\n');

      const again = await fetch(`${url}/lib/core/reactive.js`, {
        headers: { 'If-None-Match': etag },
      });
      assert.equal(again.status, 304);
      assert.equal(await again.text(), '');
      // What the 200 said about caching this URL is repeated; the type of a
      // representation that is not being sent is not.
      assert.equal(again.headers.get('etag'), etag);
      assert.equal(again.headers.get('cache-control'), 'no-cache');
      assert.equal(again.headers.get('content-type'), null);
      assert.equal(again.headers.get('content-length'), null);

      // The comparison is the weak one this header requires, and the list form and
      // `*` are both what a browser can legitimately send.
      const forms = [etag.replace('W/', ''), `"other", ${etag}`, '*'];
      for (const header of forms) {
        const conditional = await fetch(`${url}/lib/core/reactive.js`, {
          headers: { 'If-None-Match': header },
        });
        assert.equal(conditional.status, 304, header);
      }

      // A tag that is not ours is a whole body, which is the case an edit produces.
      const stale = await fetch(`${url}/lib/core/reactive.js`, {
        headers: { 'If-None-Match': '"stale"' },
      });
      assert.equal(stale.status, 200);
      assert.equal(await stale.text(), 'export const reactive = 1;\n');

      // HEAD revalidates the same way.
      const head = await fetch(`${url}/lib/core/reactive.js`, {
        method: 'HEAD',
        headers: { 'If-None-Match': etag },
      });
      assert.equal(head.status, 304);
    });
  });
});

void test('the validator changes with the file, so an edit is a whole body again', async () => {
  await withFixture(async ({ root, mounts }) => {
    const file = join(root, 'lib', 'core', 'reactive.js');
    await withOrigin({ mounts }, async (url) => {
      const etag = (await fetch(`${url}/lib/core/reactive.js`)).headers.get('etag') ?? '';

      await writeFile(file, 'export const reactive = 2;\n');
      // Size is unchanged here, so this is the mtime half of the validator doing the
      // work — and a filesystem with one-second timestamps needs to see a new second.
      await utimes(file, new Date(), new Date(Date.now() + 2000));

      const edited = await fetch(`${url}/lib/core/reactive.js`, {
        headers: { 'If-None-Match': etag },
      });
      assert.equal(edited.status, 200);
      assert.equal(await edited.text(), 'export const reactive = 2;\n');
      assert.notEqual(edited.headers.get('etag'), etag);
    });
  });
});

void test('a transform is not validated by the file, unless it says it is', async () => {
  await withFixture(async ({ mounts, appDir }) => {
    const entry = join(appDir, 'index.html');
    const generated = Buffer.from('<!doctype html><body>generated</body>\n');

    // No ETag of its own: stat describes the file, and a body built from more than
    // the file would be revalidated against something that does not change with it.
    await withOrigin({ mounts, transform: (file) => (file === entry ? { body: generated } : null) },
      async (url) => {
        const response = await fetch(`${url}/index.html`);
        assert.equal(response.headers.get('etag'), null);
        const conditional = await fetch(`${url}/index.html`, { headers: { 'If-None-Match': '*' } });
        assert.equal(conditional.status, 200);
      },
    );

    // And one that knows its own bytes says so, and gets the 304.
    await withOrigin(
      {
        mounts,
        transform: (file) =>
          file === entry ? { body: generated, headers: { ETag: '"generated-1"' } } : null,
      },
      async (url) => {
        const response = await fetch(`${url}/index.html`);
        assert.equal(response.headers.get('etag'), '"generated-1"');
        const conditional = await fetch(`${url}/index.html`, {
          headers: { 'If-None-Match': '"generated-1"' },
        });
        assert.equal(conditional.status, 304);
        assert.equal(await conditional.text(), '');
      },
    );
  });
});
