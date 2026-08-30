import {
  availableLocales,
  configureI18n,
  cur,
  direction,
  dt,
  locale,
  num,
  registerMessages,
  setLocale,
  t,
} from '@core/localization/i18n.js';
import {
  configurePreferences,
  createMemoryStorage,
  loadPreference,
} from '@core/preferences/persistence.js';
import { assert, present } from '../harness.js';

/**
 * Internationalisation, tested against real message files over real HTTP.
 * Nothing is stubbed; the bundles are fetched and merged exactly as they are in
 * production.
 *
 * They are this suite's own fixtures, though, and that was a correction. The
 * bundles used to be `/i18n/{locale}.json`, which the test runner mounts to
 * whichever application is under test — so the framework's suite was asserting
 * the content of one application's message files, and pointing `APP` at another
 * failed eight tests in a layer that had not changed. A library test that needs one
 * application to pass is the boundary leaking, which is the thing
 * source/lib/test says about itself in the config's header.
 *
 * The pattern is built by hand rather than with `new URL`, because the URL
 * parser percent-encodes the braces in `{locale}` and the substitution would
 * then never match.
 *
 * The one test that carries the architectural claim is "changes every reader when
 * the locale changes". Everything else is behaviour; that one is the reason this
 * approach was chosen over a build-time substitution.
 */

const FIXTURES = `${new URL('../fixtures/i18n/', import.meta.url).href}{locale}.json`;
const LATE_BUNDLE = `${new URL('../fixtures/late/', import.meta.url).href}{locale}.json`;

/**
 * A pattern with nothing behind it, and the file a build would have emitted for it.
 * Nothing resolves the second from the first, which is the point: only the mapping
 * can produce the message. ADR-0083.
 */
const MAPPED = `${new URL('../fixtures/hashed/', import.meta.url).href}{locale}.json`;
const EMITTED = new URL('../fixtures/hashed/en-0123456789abcdef.json', import.meta.url).href;

describe('i18n', () => {
  before(async () => {
    await configureI18n({
      defaultLocale: 'en',
      supportedLocales: ['en', 'it', 'ar'],
      bundles: [FIXTURES],
    });
    await setLocale('en');
  });

  after(async () => {
    await setLocale('en');
  });

  it('translates a key', () => {
    assert.equal(t('users.title'), 'Users');
  });

  it('flattens nested message files to dotted keys', () => {
    // en.json nests `users: { status: { active } }`; the runtime looks it up flat.
    assert.equal(t('users.status.active'), 'active');
  });

  it('skips $-prefixed translator notes instead of making them messages', () => {
    // JSON has no comments, so the bundles carry `$comment` — here an array of
    // lines. Walking into it produced `$comment.0`, `$comment.1` … as messages,
    // while `verify-deps.mjs` skipped them and said it flattened exactly as the
    // runtime does. Both sides skip them now; this is what keeps that true.
    assert.equal(t('$comment'), '$comment');
    assert.equal(t('$comment.0'), '$comment.0');
  });

  it('interpolates named parameters', () => {
    assert.equal(t('user.notFound', { id: '9' }), 'No user with id 9.');
  });

  it('leaves an unknown placeholder alone rather than blanking it', () => {
    assert.equal(t('user.notFound', { other: 'x' }), 'No user with id {id}.');
  });

  it('selects a plural category from Intl.PluralRules', () => {
    assert.equal(t('users.count', { count: 1 }), '1 user');
    assert.equal(t('users.count', { count: 5 }), '5 users');
  });

  it('formats numbers inside a message for the active locale', async () => {
    // 1234 groups in English and does not in Italian, because Italian CLDR sets
    // minimumGroupingDigits to 2: grouping starts at five digits. Nobody
    // hand-rolling this gets it right, and it is the argument for Intl doing the
    // formatting rather than the message file carrying pre-formatted numbers.
    assert.equal(t('users.count', { count: 1234 }), '1,234 users');
    await setLocale('it');
    assert.equal(t('users.count', { count: 1234 }), '1234 utenti');
    assert.equal(t('users.count', { count: 12345 }), '12.345 utenti');
    await setLocale('en');
  });

  it('returns the key and does not throw when a message is missing', () => {
    assert.equal(t('nothing.here.at.all'), 'nothing.here.at.all');
  });

  it('changes every reader when the locale changes', async () => {
    assert.equal(t('users.title'), 'Users');
    await setLocale('it');
    assert.equal(t('users.title'), 'Utenti');
    assert.equal(locale.value, 'it');
    await setLocale('en');
    assert.equal(t('users.title'), 'Users');
  });

  it('falls back key by key rather than locale by locale', async () => {
    await setLocale('ar');
    // Translated in ar.json.
    assert.equal(t('users.title'), 'المستخدمون');
    // Absent from ar.json, present in en.json.
    assert.equal(t('login.title'), 'Sign in');
    await setLocale('en');
  });

  it('reaches plural categories the default locale does not declare', async () => {
    await setLocale('ar');
    // Arabic has six categories; English declares two for the same key.
    assert.equal(t('users.count', { count: 0 }), 'لا مستخدمين');
    assert.equal(t('users.count', { count: 2 }), 'مستخدمان');
    assert.notOk(t('users.count', { count: 2 }).includes('users'));
    await setLocale('en');
  });

  it('negotiates a regional tag down to a supported base language', async () => {
    await setLocale('it-CH');
    assert.equal(locale.value, 'it', 'it-CH must resolve to the supported it');
    await setLocale('en');
  });

  it('falls back to the default locale for an unsupported request', async () => {
    await setLocale('ja');
    assert.equal(locale.value, 'en');
  });

  it('reports direction, and drives the document with it', async () => {
    assert.equal(direction.value, 'ltr');
    assert.equal(document.documentElement.dir, 'ltr');

    await setLocale('ar');
    assert.equal(direction.value, 'rtl');
    assert.equal(document.documentElement.dir, 'rtl');
    assert.equal(document.documentElement.lang, 'ar');

    await setLocale('en');
    assert.equal(direction.value, 'ltr');
  });

  it('lists the offered locales, each named in its own language', () => {
    const codes = availableLocales.value.map((entry) => entry.code);
    assert.sameArray(codes, ['en', 'it', 'ar']);

    const italian = present(availableLocales.value.find((entry) => entry.code === 'it'));
    assert.equal(italian.label, 'italiano', 'a picker should say "italiano", not "Italian"');
  });

  it('merges a bundle registered after startup', async () => {
    assert.equal(t('billing.title'), 'billing.title', 'not registered yet');
    await registerMessages(LATE_BUNDLE);
    assert.equal(t('billing.title'), 'Billing');
  });

  it('fetches the file the manifest maps a bundle URL to', async () => {
    // A content hash cannot live in a `{locale}` pattern, so a build that
    // hash-names its locale bundles — which is what lets them be served immutable
    // rather than revalidated on every load — maps each resolved URL to the file
    // that answers for it. The declared URL stays the identity: it is what the
    // pattern resolves to and what the cache is keyed on. ADR-0083.
    assert.equal(t('hashed.only'), 'hashed.only', 'not configured yet');
    await configureI18n({
      defaultLocale: 'en',
      supportedLocales: ['en', 'it', 'ar'],
      bundles: [FIXTURES],
      bundleFiles: { [MAPPED.replace('{locale}', 'en')]: EMITTED },
    });
    await registerMessages(MAPPED);
    assert.equal(t('hashed.only'), 'from the mapped file');
  });

  it('formats numbers, currency and dates per locale', async () => {
    await setLocale('en');
    assert.equal(num(1234.5), '1,234.5');
    assert.includes(cur(1234.5, 'EUR'), '1,234.50');
    assert.includes(dt(new Date('2026-03-14T00:00:00Z'), { dateStyle: 'short', timeZone: 'UTC' }), '26');

    await setLocale('it');
    assert.equal(num(12345.5), '12.345,5');
    assert.includes(cur(12345.5, 'EUR'), '12.345,50');
    await setLocale('en');
  });

  it('keeps currency a property of the amount, not of the locale', async () => {
    await setLocale('it');
    // An Italian user looking at a dollar price must see dollars.
    assert.includes(cur(10, 'USD'), '10,00');
    assert.notOk(cur(10, 'USD').includes('€'));
    await setLocale('en');
  });

  /**
   * The chosen language is a UI preference, so it goes through the module that owns them
   * and not through a `localStorage` slot of its own. Asserted through that interface for
   * the same reason the theme's is: an application that configures a memory store or an
   * encrypted wrapper has to get the language too, and a test reading storage directly
   * would keep passing on the day it stopped.
   */
  describe('persistence', () => {
    /** @type {ReturnType<typeof createMemoryStorage>} */
    let storage;

    beforeEach(() => {
      storage = createMemoryStorage();
      configurePreferences({ storage });
    });

    afterEach(async () => {
      configurePreferences();
      await setLocale('en');
    });

    it('stores the chosen locale as a preference', async () => {
      await setLocale('it');
      assert.equal(loadPreference('locale', 'ui.locale'), 'it');
    });

    it('starts in a locale an earlier build stored under the bare key', async () => {
      storage.setItem('ui.locale', 'it');

      await configureI18n({
        defaultLocale: 'en',
        supportedLocales: ['en', 'it', 'ar'],
        bundles: [FIXTURES],
      });

      assert.equal(locale.value, 'it');
      assert.equal(t('users.title'), 'Utenti', 'and the table is the Italian one');
      assert.equal(loadPreference('locale', 'ui.locale'), 'it', 'kept as an envelope');
      assert.equal(storage.getItem('ui.locale'), null, 'the bare key is read once');
    });

    /**
     * The assertion is "not the stored one" rather than a named locale, because what
     * wins instead is `navigator.languages` — which is a property of whoever is running
     * the suite, not of this repository.
     */
    it('ignores a stored locale this build does not support', async () => {
      storage.setItem('ui.locale', 'ja');

      await configureI18n({
        defaultLocale: 'en',
        supportedLocales: ['en', 'it', 'ar'],
        bundles: [FIXTURES],
      });

      assert.ok(locale.value !== 'ja', `negotiated to ${locale.value}, not the stored ja`);
      assert.ok(['en', 'it', 'ar'].includes(locale.value), locale.value);
      assert.equal(storage.getItem('ui.locale'), null);
    });

    it('switches locale with storage blocked entirely', async () => {
      configurePreferences({
        storage: {
          getItem: () => {
            throw new DOMException('blocked', 'SecurityError');
          },
          setItem: () => {
            throw new DOMException('blocked', 'SecurityError');
          },
          removeItem: () => {
            throw new DOMException('blocked', 'SecurityError');
          },
        },
      });

      await setLocale('it');
      assert.equal(locale.value, 'it');
      assert.equal(t('users.title'), 'Utenti', 'a blocked store may not stop a translation');
    });
  });
});
