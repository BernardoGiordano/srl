import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

import { send, serveOrigin } from '../../cli/origin/index.mjs';
import {
  MOUNTS, PROBE_CONTROL_PIN, PROBE_CONTROL_URL, PROBE_CSP, PROBE_EMPTY_URL, PROBE_PIN, PROBE_URL,
  importMapFragment,
} from '../../cli/package/interface.mjs';

/** @typedef {Awaited<ReturnType<typeof importMapFragment>> & { scopes?: Record<string, Record<string, string>> }} ImportMap */

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  void test(`${name} admits remotes only with conclusive local integrity controls`, async (t) => {
    const trusted = await importMapFragment();
    /** @type {ImportMap} */
    let map = trusted;
    let policy = PROBE_CSP;
    /** @type {{ body: string, type: string, failSecond?: boolean }} */
    let network = { body: 'export const = ;', type: 'text/javascript' };
    /** @type {string[]} */
    const requests = [];
    const origin = await serveOrigin({
      mounts: MOUNTS,
      route: (_request, response, url) => {
        requests.push(url.pathname);
        if (url.pathname === '/') {
          const source = JSON.stringify(map);
          const hash = createHash('sha256').update(source).digest('base64');
          response.setHeader('Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'sha256-${hash}' ${policy}; object-src 'none'; base-uri 'none'`);
          send(response, { type: 'text/html', body: Buffer.from(`<script type="importmap">${source}</script>`) });
          return true;
        }
        if (url.pathname === '/network-probe.js') {
          if (network.failSecond && requests.filter((path) => path === url.pathname).length > 1) {
            response.writeHead(503).end();
          } else {
            send(response, { type: network.type, body: Buffer.from(network.body) });
          }
          return true;
        }
        if (url.pathname === '/remote.js') {
          send(response, { type: 'text/javascript', body: Buffer.from('export const changed = true;') });
          return true;
        }
        if (url.pathname === '/remote-loader.js') {
          send(response, {
            type: 'text/javascript',
            body: Buffer.from('export function load() { return import("/remote.js"); }'),
          });
          return true;
        }
        return false;
      },
    });
    t.after(origin.close);
    const browser = await engine.launch();
    t.after(() => browser.close());

    /** @param {ImportMap | undefined} [visible] */
    async function open(visible) {
      const page = await browser.newPage();
      await page.goto(origin.url);
      if (visible !== undefined) {
        // The parsed browser map lacks pins, but the runtime sees the trusted table.
        // This models ignored integrity without replacing import().
        await page.evaluate((value) => {
          const script = document.querySelector('script[type="importmap"]');
          if (script !== null) script.textContent = JSON.stringify(value);
        }, visible);
      }
      return page;
    }

    /** @param {import('playwright').Page} page */
    const verdict = (page) => page.evaluate(async () => {
      const url = '/lib/core/foundation/pins.js';
      const { pinsEnforced } = /** @type {typeof import('../../source/lib/core/foundation/pins.js')} */ (await import(url));
      try {
        const first = pinsEnforced();
        const shared = first === pinsEnforced();
        await first;
        return { admitted: true, error: '', shared, cached: first === pinsEnforced() };
      } catch (cause) {
        return { admitted: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    });

    await t.test('matching controls pass strict CSP, mismatch blocks, and changed remote bytes refuse', async () => {
      map = { ...trusted, integrity: { ...trusted.integrity, '/remote.js': PROBE_PIN } };
      policy = PROBE_CSP;
      const page = await open();
      try {
        assert.deepEqual(await verdict(page), { admitted: true, error: '', shared: true, cached: true });
        assert.equal(await page.evaluate(async () => {
          const url = '/remote-loader.js';
          const { load } = /** @type {{ load(this: void): Promise<unknown> }} */ (await import(url));
          try { await load(); return 'ran'; } catch { return 'refused'; }
        }), 'refused');
        assert.ok(!requests.includes('/network-probe.js'));
      } finally { await page.close(); }
    });

    await t.test('ignored integrity refuses remotes and retains that verdict', async () => {
      map = { imports: trusted.imports, integrity: {} };
      policy = 'data:';
      const page = await open(trusted);
      try {
        const result = await verdict(page);
        assert.equal(result.admitted, false);
        assert.match(result.error, /ignores import-map integrity/u);
        assert.equal(await page.evaluate(async () => {
          const url = '/lib/core/foundation/pins.js';
          const { pinsEnforced } = /** @type {typeof import('../../source/lib/core/foundation/pins.js')} */ (await import(url));
          try { await pinsEnforced(); } catch { /* The definitive refusal stays cached. */ }
          return pinsEnforced() === pinsEnforced();
        }), true);
      } finally { await page.close(); }
    });

    for (const allowed of ['', `'${PROBE_PIN}'`, `'${PROBE_CONTROL_PIN}'`]) {
      await t.test(`CSP without both control permissions refuses (${allowed || 'no probe hashes'})`, async () => {
        map = trusted;
        policy = allowed;
        const page = await open();
        try {
          const result = await verdict(page);
          assert.equal(result.admitted, false);
          assert.match(result.error, /controls failed.*inconclusive/u);
        } finally { await page.close(); }
      });
    }

    for (const target of [PROBE_CONTROL_URL, PROBE_EMPTY_URL, PROBE_URL]) {
      await t.test(`missing pin refuses ${target}`, async () => {
        map = { imports: trusted.imports, integrity: { ...trusted.integrity } };
        delete map.integrity[target];
        policy = PROBE_CSP;
        const page = await open();
        try { assert.equal((await verdict(page)).admitted, false); } finally { await page.close(); }
      });
    }

    await t.test('an inconclusive map can be corrected and checked again', async () => {
      map = trusted;
      policy = PROBE_CSP;
      const visible = { imports: trusted.imports, integrity: { ...trusted.integrity } };
      delete visible.integrity[PROBE_CONTROL_URL];
      const page = await open(visible);
      try {
        assert.equal((await verdict(page)).admitted, false);
        await page.evaluate((value) => {
          const script = document.querySelector('script[type="importmap"]');
          if (script !== null) script.textContent = JSON.stringify(value);
        }, trusted);
        assert.equal((await verdict(page)).admitted, true);
      } finally { await page.close(); }
    });

    const failures = {
      syntax: { body: 'export const = ;', type: 'text/javascript' },
      evaluation: { body: 'throw new TypeError("synthetic evaluation failure");', type: 'text/javascript' },
      MIME: { body: 'export const probe = true;', type: 'text/plain' },
      transport: { body: 'export const probe = true;', type: 'text/javascript', failSecond: true },
    };
    for (const [failure, response] of Object.entries(failures)) {
      await t.test(`the legacy transport probe cannot turn ${failure} into enforcement`, async () => {
        const visible = {
          imports: { ...trusted.imports, '@core/foundation/pin-probe.js': '/network-probe.js' },
          integrity: { ...trusted.integrity, '/network-probe.js': PROBE_PIN },
        };
        map = { imports: visible.imports, integrity: {} };
        network = response;
        policy = 'data:';
        requests.length = 0;
        const page = await open(visible);
        try {
          assert.equal((await verdict(page)).admitted, false);
          assert.ok(!requests.includes('/network-probe.js'));
        } finally { await page.close(); }
      });
      await t.test(`${failure} at a remapped probe cannot prove enforcement or reach transport`, async () => {
        map = {
          imports: { ...trusted.imports, [PROBE_URL]: '/network-probe.js' },
          integrity: trusted.integrity,
        };
        network = response;
        policy = `data: ${PROBE_CSP}`;
        requests.length = 0;
        const page = await open();
        try {
          const result = await verdict(page);
          assert.equal(result.admitted, false);
          assert.match(result.error, /remapped/u);
          assert.ok(!requests.includes('/network-probe.js'));
        } finally { await page.close(); }
      });
    }

    await t.test('a scoped rewrite of a positive control refuses before import', async () => {
      map = { ...trusted, scopes: { '/lib/': { [PROBE_CONTROL_URL]: '/network-probe.js' } } };
      policy = `data: ${PROBE_CSP}`;
      const page = await open();
      try {
        const result = await verdict(page);
        assert.equal(result.admitted, false);
        assert.match(result.error, /remapped/u);
      } finally { await page.close(); }
    });
  });
}
