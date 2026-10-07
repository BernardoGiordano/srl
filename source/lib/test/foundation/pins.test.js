import { PROBE_CONTROL_PIN, PROBE_PIN, PROBE_URL, pageIntegrity, pinFor, pinned, pinsEnforced } from '@core/foundation/pins.js';
import { assert } from '../harness.js';
import { pinOf, withPagePins } from '../page-pins.js';

/**
 * The page's pin table, read from the test page's own import map. ADR-0129.
 *
 * The harness copies the application's map. Chrome admits both matching local
 * controls and refuses the mismatch, so `pinsEnforced` resolves.
 */

const FIXTURE = '/lib/test/fixtures/styled-card.html';

describe('pin table', () => {
  it('answers with the pin the page holds for a same-origin path', async () => {
    const pin = await pinOf(FIXTURE);
    await withPagePins({ [FIXTURE]: pin }, () => {
      assert.equal(pinFor(FIXTURE), pin);
      assert.equal(pinFor('/lib/test/../test/fixtures/styled-card.html'), pin);
      assert.equal(pinFor(new URL(FIXTURE, location.origin)), pin);
      assert.equal(pinFor(`https://elsewhere.example${FIXTURE}`), undefined);
      assert.equal(pinFor('/lib/test/fixtures/styled-page.html'), undefined);
    });
    assert.equal(pinFor(FIXTURE), undefined, 'a restored map no longer pins the fixture');
  });

  it('adds a pin to a request only for a pinned URL', async () => {
    await withPagePins({ [FIXTURE]: PROBE_PIN }, () => {
      assert.equal(pinned(FIXTURE, { cache: 'no-cache' }).integrity, PROBE_PIN);
      assert.equal(pinned(FIXTURE, { cache: 'no-cache' }).cache, 'no-cache');
    });
    assert.equal(pinned(FIXTURE).integrity, undefined);
  });

  it('makes a changed file fail its request', async () => {
    // A loader passes the pin to fetch, so bytes that differ from it never arrive.
    await withPagePins({ [FIXTURE]: PROBE_PIN }, () =>
      assert.rejects(() => fetch(FIXTURE, pinned(FIXTURE)), ''),
    );
    const pin = await pinOf(FIXTURE);
    await withPagePins({ [FIXTURE]: pin }, async () => {
      assert.equal((await fetch(FIXTURE, pinned(FIXTURE))).ok, true);
    });
  });

  it('cannot prove enforcement when the probe is not pinned to the sentinel', async () => {
    await withPagePins({ [PROBE_URL]: PROBE_CONTROL_PIN }, () =>
      assert.rejects(() => pinsEnforced(), `pin its URL to ${PROBE_PIN}`),
    );
  });

  it('proves this engine enforces import-map pins', async () => {
    // The probe that couldn't be checked above is checked again here, because only a
    // verdict is kept.
    assert.equal(pageIntegrity()[PROBE_URL], PROBE_PIN);
    await pinsEnforced();
  });
});
