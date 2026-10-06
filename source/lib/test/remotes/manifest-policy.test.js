import { admitManifest } from '@core/remotes/manifest-policy.js';
import { assert, present } from '../harness.js';

/**
 * Manifest admission, tested as policy rather than as field validation.
 *
 * Every case here is a document whose fields are individually well-formed and whose
 * combination is not. A token endpoint that is a valid string pointing at somebody
 * else's origin, two remotes that each declare a legal mount, a locale list that turns a
 * legal bundle pattern into a path outside the application. Those are the failures a
 * per-field check cannot see, and they are why the whole document is admitted in one
 * place before anything downstream is built.
 *
 * The pins come from a literal here rather than from the page, because this suite is the
 * policy's and `remotes/mfe.test.js` covers the browser adapter that reads the real
 * import map. Both go through this module.
 */

const PIN = 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_PIN = 'sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const PINS = {
  '/remotes/one/entry.js': PIN,
  '/remotes/two/entry.js': OTHER_PIN,
  '/remotes/one/app.css': OTHER_PIN,
  '/remotes/one/templates.json': PIN,
  '/remotes/one/a.html': PIN,
  '/remotes/one/i18n/en.json': PIN,
  '/templates.json': PIN,
  '/assets/i18n/en-0123456789abcdef.json': PIN,
};

describe('manifest admission', () => {
  describe('destination trust', () => {
    it('refuses an auth destination on another origin', () => {
      // Every field is a valid string, the remotes are pinned, and the document
      // sends the user's credentials to somebody else. `connect-src 'self'` stops it
      // in the hardened deployment and nowhere else, so the refusal belongs at
      // admission.
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
      assert.equal(present(admitted.auth).apiBaseUrl, '/api/v1/');
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
      assert.sameArray(Object.keys(admit({}).templateGroups), []);
      assert.sameArray([...present(admit({ remotes: [remote({})] }).remotes[0]).templateFiles], []);
    });

    it('admits grouped templates under the rules the flat list has, and derives the union', () => {
      // Every value becomes a `fetch` under the page's own `connect-src 'self'`,
      // so the group's entries are admitted exactly as the flat list's are.
      assert.throws(
        () => admit({ templateGroups: { entry: ['https://cdn.example/a.html'] } }),
        'templateGroups.entry[0] must be same-origin',
      );
      assert.throws(
        () => admit({ templateGroups: { entry: '/assets/templates/a.html' } }),
        'templateGroups.entry must be an array',
      );

      // Across the record rather than within a group. A template is named by one
      // module, which lives in one chunk, so the same URL in two groups is a join that
      // went wrong, and it would be paid twice, once per group that starts.
      assert.throws(
        () =>
          admit({
            templateGroups: {
              entry: ['/assets/templates/a.html'],
              'chunk:assets/x.js': ['/assets/x/../templates/a.html'],
            },
          }),
        'names /assets/templates/a.html more than once',
      );

      const admitted = admit({
        templateGroups: {
          entry: ['/assets/x/../templates/a.html'],
          'chunk:assets/x.js': ['/assets/templates/b.html'],
        },
      });
      assert.sameArray([...(admitted.templateGroups.entry ?? [])], ['/assets/templates/a.html']);
      // The union is derived, entry first, so a caller that wants every template
      // this artifact holds reads one property and not a partition. ADR-0081.
      assert.sameArray(
        [...admitted.templateFiles],
        ['/assets/templates/a.html', '/assets/templates/b.html'],
      );
    });

    it('keeps a group named __proto__ as a group rather than as a prototype', () => {
      // `JSON.parse` makes `__proto__` an own key. Written into a plain object it
      // replaced the record's prototype, and the group left both the record and the
      // union without a refusal. ADR-0118.
      const admitted = admit({
        templateGroups: JSON.parse('{ "__proto__": ["/assets/templates/a.html"] }'),
      });
      assert.ok(Object.getPrototypeOf(admitted.templateGroups) === null);
      assert.sameArray(Object.keys(admitted.templateGroups), ['__proto__']);
      assert.sameArray([...admitted.templateFiles], ['/assets/templates/a.html']);
    });

    it('refuses a document that names its templates both ways', () => {
      // A generator that could not decide. One document cannot say both which chunk
      // needs what and that everything is needed at once, and the runtime would have
      // to pick quietly, and differently from the next reader. ADR-0081.
      assert.throws(
        () =>
          admit({
            templateGroups: { entry: ['/assets/templates/a.html'] },
            templateFiles: ['/assets/templates/b.html'],
          }),
        'names its templates twice',
      );
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

    it('maps a bundle URL to the file that serves it, and only a URL it resolves to', () => {
      // A hash cannot live in a pattern, so a build that hash-names its locale
      // bundles says per resolved URL which file answers for it. Which URLs those
      // are is a fact about the whole block: `bundles` alone does not know the
      // locales, and `supportedLocales` alone does not know the patterns. ADR-0083.
      const i18n = { defaultLocale: 'en', supportedLocales: ['en', 'it'], bundles: BUNDLES };
      assert.throws(
        () =>
          admit({ i18n: { ...i18n, bundleFiles: { '/i18n/de.json': '/assets/i18n/de-x.json' } } }),
        'no bundle pattern resolves to',
      );
      assert.throws(
        () =>
          admit({
            i18n: { ...i18n, bundleFiles: { '/i18n/en.json': 'https://cdn.invalid/en.json' } },
          }),
        'must be same-origin',
      );

      const admitted = admit({
        i18n: { ...i18n, bundleFiles: { '/i18n/en.json': '/assets/x/../i18n/en-0123456789abcdef.json' } },
      });
      assert.equal(
        admitted.i18n.bundleFiles?.['/i18n/en.json'],
        '/assets/i18n/en-0123456789abcdef.json',
      );
    });

    it('gives a document that maps nothing an empty mapping rather than nothing', () => {
      // Development has no mapping, because the declared URL is the file. The
      // consumer is one optional read on the fetch path, and it stays one.
      assert.equal(Object.keys(present(admit({}).i18n.bundleFiles)).length, 0);
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
              remote({
                assets: [{ type: 'style', url: '/remotes/one/app.css', integrity: OTHER_PIN }],
              }),
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
      // where the order of the array decides whose guard runs and whose grants bound
      // the context, rather than the policy written in it.
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

  describe('absent sections', () => {
    it('admits an empty document as a plain application', () => {
      // No remotes, no API and one locale, which is what an application that mounts
      // nothing and signs nobody in actually has. ADR-0123.
      const admitted = admitDocument({});
      assert.sameArray([...admitted.remotes], []);
      assert.equal(admitted.auth, undefined);
      assert.equal(admitted.i18n.defaultLocale, 'en');
      assert.sameArray([...admitted.i18n.supportedLocales], ['en']);
      assert.sameArray([...admitted.i18n.bundles], []);
    });

    it('lets each locale field follow the other', () => {
      assert.sameArray([...admitDocument({ i18n: { defaultLocale: 'it' } }).i18n.supportedLocales], ['it']);
      assert.equal(admitDocument({ i18n: { supportedLocales: ['it', 'en'] } }).i18n.defaultLocale, 'it');
    });

    it('still refuses a present section with a bad value', () => {
      // A default stands in for a missing section. It never repairs a written one.
      assert.throws(() => admitDocument({ remotes: {} }), 'remotes must be an array');
      assert.throws(() => admitDocument({ auth: {} }), 'auth.apiBaseUrl must be a non-empty string');
      assert.throws(
        () => admitDocument({ i18n: { supportedLocales: [] } }),
        'i18n.supportedLocales must be a non-empty array',
      );
      assert.throws(() => admitDocument({ i18n: { defaultLocale: '../x' } }), 'i18n.defaultLocale must be');
    });

    it('refuses a key it does not know, so a misspelled section cannot read as absent', () => {
      assert.throws(() => admitDocument({ remote: [] }), 'does not know, "remote"');
      assert.throws(() => admitDocument({ auth: { apiBase: '/api' } }), 'does not know, "apiBase"');
      assert.throws(() => admit({ remotes: [remote({ mounts: '/one' })] }), 'does not know, "mounts"');
      assert.throws(
        () => admit({ remotes: [remote({ grants: { apis: ['/api/'] } })] }),
        'does not know, "apis"',
      );
    });

    it('allows annotations anywhere', () => {
      const admitted = admitDocument({
        $schema: './app.manifest.schema.json',
        $comment: ['Annotations are for people and editors.'],
        i18n: { $comment: 'one locale', defaultLocale: 'en' },
      });
      assert.equal(admitted.i18n.defaultLocale, 'en');
    });
  });

  describe('the page pins every byte the manifest names', () => {
    // A manifest is fetched with no-cache and can change after the document did. Every
    // URL it names must carry a pin the document already holds, so a changed manifest
    // can point only at bytes the page vouches for. ADR-0129.
    const entry = { type: 'module', url: '/remotes/one/entry.js', integrity: PIN };

    it('refuses a style or template asset whose digest is not the page pin', () => {
      assert.throws(
        () =>
          admit({
            remotes: [
              remote({
                assets: [entry, { type: 'style', url: '/remotes/one/app.css', integrity: PIN }],
              }),
            ],
          }),
        "assets[1] integrity does not match the page's static import-map pin",
      );
      assert.throws(
        () =>
          admit({
            remotes: [
              remote({
                assets: [entry, { type: 'template', url: '/remotes/one/b.html', integrity: PIN }],
              }),
            ],
          }),
        "does not match the page's static import-map pin for /remotes/one/b.html",
      );
    });

    it('refuses a remote template file the page does not pin', () => {
      assert.throws(
        () => admit({ remotes: [remote({ templateFiles: ['/remotes/one/b.html'] })] }),
        "templateFiles[0] names /remotes/one/b.html, which the page's import map doesn't pin",
      );
      const admitted = admit({ remotes: [remote({ templateFiles: ['/remotes/one/a.html'] })] });
      assert.sameArray([...present(admitted.remotes[0]).templateFiles], ['/remotes/one/a.html']);
    });

    it('needs an asset record for every split template a built remote announces', () => {
      // Composition carries a remote's digests into the shell's import map from its
      // asset records, so an announced file without one would arrive unpinned.
      assert.throws(
        () =>
          admit({
            remotes: [remote({ assets: [entry], templateFiles: ['/remotes/one/a.html'] })],
          }),
        'announces templates with no asset record: /remotes/one/a.html',
      );
      const admitted = admit({
        remotes: [
          remote({
            assets: [entry, { type: 'template', url: '/remotes/one/a.html', integrity: PIN }],
            templateFiles: ['/remotes/one/a.html'],
          }),
        ],
      });
      assert.sameArray(
        present(admitted.remotes[0]).assets.map((asset) => asset.type),
        ['module', 'template'],
      );
    });

    it('admits a locale asset only where a locale pattern resolves', () => {
      const locales = ['/remotes/one/i18n/{locale}.json'];
      assert.throws(
        () =>
          admit({
            remotes: [
              remote({
                assets: [entry, { type: 'locale', url: '/remotes/one/a.html', integrity: PIN }],
                locales,
              }),
            ],
          }),
        'no locale pattern resolves to',
      );
      const admitted = admit({
        remotes: [
          remote({
            assets: [entry, { type: 'locale', url: '/remotes/one/i18n/en.json', integrity: PIN }],
            locales,
          }),
        ],
      });
      assert.sameArray(
        present(admitted.remotes[0]).assets.map((asset) => asset.type),
        ['module', 'locale'],
      );
    });

    it('refuses a template bundle the page does not pin', () => {
      // A bundle seeds every template, the login screen included, so a manifest that
      // could name any JSON on the origin could replace the shell's markup.
      assert.throws(
        () => admit({ templateBundle: '/remotes/one/upload.json' }),
        "templateBundle names /remotes/one/upload.json, which the page's import map doesn't pin",
      );
      assert.equal(admit({ templateBundle: '/templates.json' }).templateBundle, '/templates.json');
    });

    it('refuses a locale mapping to a file the page does not pin', () => {
      const i18n = { defaultLocale: 'en', supportedLocales: ['en'], bundles: BUNDLES };
      assert.throws(
        () =>
          admit({ i18n: { ...i18n, bundleFiles: { '/i18n/en.json': '/remotes/one/en.json' } } }),
        "doesn't pin",
      );
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
    // A deep base on purpose, because the page's URL is whatever route the user
    // deep-linked to and a manifest path may not mean two different files because of
    // it.
    base: 'https://app.example/deep/route',
    pins: () => PINS,
  });
}

/**
 * Admit a document as written, with none of the sections `admit` fills in.
 *
 * @param {Record<string, unknown>} document
 * @returns {import('@core/remotes/types.js').AppManifest}
 */
function admitDocument(document) {
  return admitManifest(document, {
    url: '/app.manifest.json',
    base: 'https://app.example/',
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
