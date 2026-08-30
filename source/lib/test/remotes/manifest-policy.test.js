import { admitManifest } from '@core/remotes/manifest-policy.js';
import { assert, present } from '../harness.js';

/**
 * Manifest admission, tested as policy rather than as field validation.
 *
 * Every case here is a document whose fields are individually well-formed and
 * whose *combination* is not: a token endpoint that is a valid string pointing at
 * somebody else's origin, two remotes that each declare a legal mount, a locale
 * list that turns a legal bundle pattern into a path outside the application.
 * Those are the failures a per-field check cannot see, and they are why the whole
 * document is admitted in one place before anything downstream is built.
 *
 * The pins come from a literal here rather than from the page: this suite is the
 * policy's, and `remotes/mfe.test.js` covers the browser adapter that reads the
 * real import map. Both go through this module.
 */

const PIN = 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_PIN = 'sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const PINS = {
  '/remotes/one/entry.js': PIN,
  '/remotes/two/entry.js': OTHER_PIN,
};

describe('manifest admission', () => {
  describe('destination trust', () => {
    it('refuses an auth destination on another origin', () => {
      // The exact shape review 3 demonstrated: every field is a valid string, the
      // remotes are pinned, and the document sends the user's credentials to
      // somebody else. `connect-src 'self'` stops it in the hardened deployment
      // and nowhere else, so the refusal belongs at admission.
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: 'https://attacker.example/api' }) }),
        'auth.apiBaseUrl must be same-origin',
      );
    });

    it('refuses the spellings that only look root-relative', () => {
      // A protocol-relative URL and a backslash are the two ways to write another
      // origin as something that reads like a path.
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: '//attacker.example/api' }) }),
        'must be same-origin',
      );
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: '/\\attacker.example/api' }) }),
        'must not contain a backslash',
      );
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: 'api' }) }),
        'must be same-origin',
      );
    });

    it('refuses credentials, fragments and empty destinations', () => {
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: 'https://user:pass@app.example/api' }) }),
        'must be same-origin',
      );
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: '/api#fragment' }) }),
        'must not contain a fragment',
      );
      assert.throws(
        () => admit({ auth: authWith({ apiBaseUrl: '' }) }),
        'auth.apiBaseUrl must be a non-empty string',
      );
    });

    it('normalizes a destination to the path it actually reaches', () => {
      const admitted = admit({ auth: authWith({ apiBaseUrl: '/api/v2/../v1/' }) });
      assert.equal(admitted.auth.apiBaseUrl, '/api/v1/');
    });

    it('refuses a template bundle or locale bundle on another origin', () => {
      assert.throws(
        () => admit({ templateBundle: 'https://cdn.example/templates.json' }),
        'templateBundle must be same-origin',
      );
      assert.throws(
        () => admit({ i18n: i18nWith({ bundles: ['https://cdn.example/{locale}.json'] }) }),
        'must be same-origin',
      );
    });

    it('refuses a template list that leaves the origin, and normalizes the rest', () => {
      // The runtime turns this list into `fetch` calls under `connect-src 'self'`,
      // so a cross-origin entry fails as a blocked request behind an optimisation
      // nobody is watching. One message at admission is the better failure.
      assert.throws(
        () => admit({ templateFiles: ['https://cdn.example/assets/templates/a.html'] }),
        'templateFiles[0] must be same-origin',
      );
      assert.throws(
        () => admit({ templateFiles: ['/assets/templates/a.html', '/assets/x/../templates/a.html'] }),
        'names /assets/templates/a.html more than once',
      );
      assert.throws(() => admit({ templateFiles: '/assets/templates/a.html' }), 'must be an array');

      const admitted = admit({ templateFiles: ['/assets/x/../templates/a.html'] });
      assert.sameArray([...admitted.templateFiles], ['/assets/templates/a.html']);
    });

    it('gives a document that names no templates an empty list rather than nothing', () => {
      // The only consumer iterates it. An optional list that is sometimes a list
      // and sometimes undefined is a guard at every call site, for a document that
      // simply has nothing to announce.
      assert.sameArray([...admit({}).templateFiles], []);
      assert.sameArray([...present(admit({ remotes: [remote({})] }).remotes[0]).templateFiles], []);
    });

    it('admits a bundle pattern through every locale it will be used with', () => {
      // The pattern is not what is fetched. `/i18n/{locale}.json` is same-origin
      // for every sane tag and leaves the application for a locale that carries
      // path syntax, so the locale list and the pattern are admitted together.
      assert.throws(
        () =>
          admit({
            i18n: { defaultLocale: 'en', supportedLocales: ['en', '../../etc'], bundles: BUNDLES },
          }),
        'must be a language tag',
      );
      const admitted = admit({
        i18n: { defaultLocale: 'en', supportedLocales: ['en', 'pt-BR'], bundles: BUNDLES },
      });
      assert.sameArray([...admitted.i18n.bundles], ['/i18n/{locale}.json']);
    });
  });

  describe('remote code admission', () => {
    it('refuses a remote whose digest is not the page pin, in either direction', () => {
      assert.throws(
        () => admit({ remotes: [remote({ integrity: OTHER_PIN })] }),
        'does not match the page',
      );
      assert.throws(
        () => admit({ remotes: [remote({ url: '/remotes/three/entry.js' })] }),
        'does not match the page',
      );
    });

    it('reads the page pins only when a remote needs them', () => {
      // An application with no remotes boots on a page with no import map, so
      // asking for one would fail a deployment that is complete.
      let asked = 0;
      const source = {
        url: '/app.manifest.json',
        base: 'https://app.example/deep/route',
        pins: () => {
          asked += 1;
          return PINS;
        },
      };

      admitManifest(manifestDocument({}), source);
      assert.equal(asked, 0, 'a manifest with no remotes must not need an import map');

      const two = remote({
        name: 'two',
        url: '/remotes/two/entry.js',
        integrity: OTHER_PIN,
        mount: '/two',
      });
      admitManifest(manifestDocument({ remotes: [remote(), two] }), source);
      assert.equal(asked, 1, 'the pins are read once for the whole document');
    });

    it('admits one independently published asset and shared-dependency contract', () => {
      const admitted = admit({
        remotes: [
          remote({
            assets: [
              { type: 'module', url: '/remotes/one/entry.js', integrity: PIN },
              { type: 'style', url: '/remotes/one/app.css', integrity: OTHER_PIN },
              { type: 'template', url: '/remotes/one/templates.json', integrity: PIN },
            ],
            shared: ['@core/foundation/reactive.js'],
            locales: ['/remotes/one/i18n/{locale}.json'],
            templates: '/remotes/one/templates.json',
          }),
        ],
      });
      const one = present(admitted.remotes[0]);

      assert.sameArray(one.assets.map((asset) => asset.type), ['module', 'style', 'template']);
      assert.sameArray([...one.shared], ['@core/foundation/reactive.js']);
      assert.sameArray([...one.locales], ['/remotes/one/i18n/{locale}.json']);
      assert.equal(one.templates, '/remotes/one/templates.json');
      assert.throws(() => {
        /** @type {string[]} */ (one.shared).push('@core/foundation/json.js');
      });
    });

    it('refuses incomplete independent artifact descriptors', () => {
      assert.throws(
        () =>
          admit({
            remotes: [
              remote({ assets: [{ type: 'style', url: '/remotes/one/app.css', integrity: PIN }] }),
            ],
          }),
        'assets must include its entry module',
      );
      assert.throws(
        () =>
          admit({
            remotes: [remote({ templates: '/remotes/one/templates.json' })],
          }),
        'templates must name its single template asset',
      );
      assert.throws(
        () => admit({ remotes: [remote({ shared: ['./private.js'] })] }),
        'must be a bare specifier',
      );
      assert.throws(
        () => admit({ remotes: [remote({ locales: ['/remotes/one/i18n/en.json'] })] }),
        'has no {locale} placeholder',
      );
    });
  });

  describe('whole-set invariants', () => {
    it('refuses two remotes with one name', () => {
      assert.throws(
        () =>
          admit({
            remotes: [
              remote(),
              remote({ url: '/remotes/two/entry.js', integrity: OTHER_PIN, mount: '/two' }),
            ],
          }),
        'two remotes are named "one"',
      );
    });

    it('refuses two remotes on one mount', () => {
      assert.throws(
        () =>
          admit({
            remotes: [
              remote(),
              remote({ name: 'two', url: '/remotes/two/entry.js', integrity: OTHER_PIN }),
            ],
          }),
        'both mount at "/one"',
      );
    });

    it('refuses a mount that contains another, in either declaration order', () => {
      // A mount is `${mount}/*`, matched first-declared-first, so this is the case
      // where the order of the array — not the policy written in it — decides
      // whose guard runs and whose grants bound the context.
      const outer = remote({ mount: '/shop' });
      const inner = remote({
        name: 'two',
        url: '/remotes/two/entry.js',
        integrity: OTHER_PIN,
        mount: '/shop/billing',
      });

      assert.throws(() => admit({ remotes: [outer, inner] }), 'can never be routed to');
      assert.throws(() => admit({ remotes: [inner, outer] }), 'can never be routed to');
    });

    it('admits sibling mounts that merely share a prefix', () => {
      const admitted = admit({
        remotes: [
          remote({ mount: '/shop' }),
          remote({
            name: 'two',
            url: '/remotes/two/entry.js',
            integrity: OTHER_PIN,
            mount: '/shop-admin',
          }),
        ],
      });
      assert.sameArray(
        admitted.remotes.map((entry) => entry.mount),
        ['/shop', '/shop-admin'],
      );
    });

    it('normalizes a mount before comparing it', () => {
      // `/one/` and `/one` are one subtree written two ways. Comparing the two
      // spellings as text is how a duplicate mount gets admitted.
      assert.throws(
        () =>
          admit({
            remotes: [
              remote({ mount: '/one/' }),
              remote({ name: 'two', url: '/remotes/two/entry.js', integrity: OTHER_PIN }),
            ],
          }),
        'both mount at "/one"',
      );
    });

    it('refuses router syntax and the root in a mount', () => {
      for (const mount of ['/one/*', '/one/:id', '/one?tab=1']) {
        assert.throws(() => admit({ remotes: [remote({ mount })] }), 'plain path prefix');
      }
      assert.throws(() => admit({ remotes: [remote({ mount: '/' })] }), 'must not be "/"');
    });
  });

  describe('the admitted value', () => {
    it('is frozen all the way down', () => {
      // Downstream modules read this instead of the fetched document, so a
      // consumer that "fixes up" a grant or a mount would be rewriting policy
      // after it was decided.
      const admitted = admit({ remotes: [remote({ grants: { api: ['/api/one/'] } })] });
      const first = present(admitted.remotes[0]);

      assert.throws(() => {
        /** @type {{ templateBundle?: string }} */ (admitted).templateBundle = '/evil.json';
      });
      assert.throws(() => {
        /** @type {{ mount: string }} */ (first).mount = '/other';
      });
      assert.throws(() => {
        /** @type {string[]} */ (first.grants.api).push('/api/');
      });
    });

    it('normalizes a grant prefix to the path it confers', () => {
      const admitted = admit({
        remotes: [remote({ grants: { api: ['/api/reports/../analytics/'] } })],
      });
      assert.sameArray([...present(admitted.remotes[0]).grants.api], ['/api/analytics/']);
    });
  });
});

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const BUNDLES = ['/i18n/{locale}.json'];

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function manifestDocument(overrides) {
  return {
    remotes: [],
    auth: { apiBaseUrl: '/api' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: [] },
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {import('@core/remotes/types.js').AppManifest}
 */
function admit(overrides) {
  return admitManifest(manifestDocument(overrides), {
    url: '/app.manifest.json',
    // A deep base on purpose: the page's URL is whatever route the user deep-linked
    // to, and a manifest path may not mean two different files because of it.
    base: 'https://app.example/deep/route',
    pins: () => PINS,
  });
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function remote(overrides) {
  return {
    name: 'one',
    url: '/remotes/one/entry.js',
    integrity: PIN,
    mount: '/one',
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function authWith(overrides) {
  return { apiBaseUrl: '/api', ...overrides };
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function i18nWith(overrides) {
  return { defaultLocale: 'en', supportedLocales: ['en'], bundles: BUNDLES, ...overrides };
}
