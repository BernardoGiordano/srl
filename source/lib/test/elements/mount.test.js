import { defineComponent } from '@core/elements/component.js';
import {
  MountError,
  MountSequence,
  createElement,
  defineTag,
  requireElement,
} from '@core/elements/mount.js';
import { assert, mount, present, unmountAll } from '../harness.js';

/** @import { MountRequest } from '@core/elements/types.js' */

/**
 * The interface these tests cross is the one all three adapters cross:
 * `<x-outlet>`, the router and the remote loader each build a `MountRequest` and
 * hand it to this module. Loading, definition, validation, races and release used
 * to be reachable only by driving a whole navigation or a whole signal effect,
 * which is why their rules had drifted apart in the first place.
 */

class Alpha extends HTMLElement {}
await defineComponent({
  tag: 'mount-alpha',
  element: Alpha,
  module: import.meta.url,
  template: false,
});

class Beta extends HTMLElement {
  /** @type {number} */
  limit = 0;
}
await defineComponent({
  tag: 'mount-beta',
  element: Beta,
  module: import.meta.url,
  template: false,
});

describe('defineTag', () => {
  it('instantiates a defined tag without calling load', async () => {
    let loads = 0;
    const tag = await defineTag({
      where: 'test',
      tag: 'mount-alpha',
      load: () => {
        loads += 1;
        return Promise.resolve();
      },
    });

    assert.equal(tag, 'mount-alpha');
    assert.equal(loads, 0, 'an already-defined element must cost no module fetch');
  });

  it('loads once for an undefined tag and returns it', async () => {
    let loads = 0;
    /** @type {MountRequest} */
    const request = {
      where: 'test',
      tag: 'mount-lazy',
      load: () => {
        loads += 1;
        customElements.define('mount-lazy', class extends HTMLElement {});
        return Promise.resolve();
      },
    };

    assert.equal(await defineTag(request), 'mount-lazy');
    assert.equal(await defineTag(request), 'mount-lazy');
    assert.equal(loads, 1, 'the second request must see it defined');
  });

  it('reports an undefined tag with no way to define it', async () => {
    await assert.rejects(
      () => defineTag({ where: 'Route "/x"', tag: 'mount-absent' }),
      'Route "/x" names <mount-absent>, which is not a defined custom element',
    );
  });

  it('reports a load that resolved without defining its element', async () => {
    await assert.rejects(
      () =>
        defineTag({
          where: '<x-outlet>',
          tag: 'mount-ghost',
          load: () => Promise.resolve(),
        }),
      'still undefined after `load` resolved',
    );
  });

  it('reads the component its load resolved', async () => {
    const tag = await defineTag({
      where: 'Route "/late"',
      // The shape a lazy route needs: the caller learns what it is mounting from
      // the module it just loaded, so no route table repeats a tag string.
      load: () => {
        class Discovered extends HTMLElement {}
        return defineComponent({
          tag: 'mount-discovered',
          element: Discovered,
          module: import.meta.url,
          template: false,
        }).then(() => Discovered);
      },
    });

    assert.equal(tag, 'mount-discovered');
  });

  it('reads a tag from a class a request names directly', async () => {
    assert.equal(await defineTag({ where: 'test', tag: Alpha }), 'mount-alpha');
  });

  it('refuses a class that never declared a definition', async () => {
    class Undeclared extends HTMLElement {}
    await assert.rejects(
      () => defineTag({ where: 'test', tag: Undeclared }),
      'has no component definition',
    );
  });

  it('names nothing for a request that names nothing', async () => {
    assert.equal(await defineTag({ where: 'test' }), undefined);
  });
});

describe('createElement', () => {
  it('assigns props as properties, not attributes', async () => {
    const element = /** @type {Beta} */ (
      await requireElement({ where: 'test', tag: 'mount-beta', props: { limit: 7 } })
    );

    assert.equal(typeof element.limit, 'number', 'an attribute would arrive as a string');
    assert.equal(element.limit, 7);
    assert.notOk(element.hasAttribute('limit'));
  });

  it('returns null when the request names nothing to mount', async () => {
    // The router's componentless level: a parent contributing a prefix and a
    // guard and rendering nothing at all.
    assert.equal(await createElement({ where: 'Route "/area"' }), null);
  });

  it('rejects the same request when an element is required', async () => {
    await assert.rejects(
      () => requireElement({ where: 'Remote "x"' }),
      'names no custom element to mount',
    );
  });

  it('prefers create over instantiating the tag', async () => {
    const own = document.createElement('mount-alpha');
    const element = await requireElement({
      where: 'test',
      tag: 'mount-alpha',
      create: () => own,
    });

    assert.equal(element, own);
  });

  it('reports a create that returned something else', async () => {
    await assert.rejects(
      () =>
        requireElement({
          where: 'Route "/managed"',
          create: () => /** @type {HTMLElement} */ (/** @type {unknown} */ ('not an element')),
        }),
      'Route "/managed" mount() did not return an HTMLElement.',
    );
  });

  it('reports a create whose element is not the tag the request names', async () => {
    await assert.rejects(
      () =>
        requireElement({
          where: 'Remote "billing"',
          tag: 'mount-beta',
          create: () => document.createElement('mount-alpha'),
        }),
      'Remote "billing" names <mount-beta> but its mount() returned <mount-alpha>.',
    );
  });

  it('reports a create whose tag was never defined', async () => {
    await assert.rejects(
      () =>
        requireElement({
          where: 'Remote "billing"',
          tag: 'mount-undeclared',
          create: () => document.createElement('mount-undeclared'),
        }),
      'without defining as a custom element',
    );
  });

  it('fails with one error type, whatever the request shape', async () => {
    /** @type {MountRequest[]} */
    const broken = [
      { where: 'test', tag: 'mount-absent' },
      { where: 'test', tag: 'mount-ghost', load: () => Promise.resolve() },
      { where: 'test', create: () => /** @type {HTMLElement} */ (/** @type {unknown} */ (null)) },
      { where: 'test' },
    ];

    for (const request of broken) {
      /** @type {unknown} */
      let captured;
      try {
        await requireElement(request);
      } catch (cause) {
        captured = cause;
      }
      assert.ok(captured instanceof MountError, `${JSON.stringify(request.where)} must be typed`);
      assert.equal(/** @type {MountError} */ (captured).where, 'test');
    }
  });
});

describe('MountSequence', () => {
  afterEach(() => {
    unmountAll();
  });

  it('supersedes an attempt as soon as a newer one begins', () => {
    const sequence = new MountSequence();
    const first = sequence.begin();
    assert.ok(first.live);

    const second = sequence.begin();
    assert.notOk(first.live, 'only the newest attempt may complete');
    assert.ok(second.live);
  });

  it('releases the element of a superseded attempt', async () => {
    const sequence = new MountSequence();
    /** @type {HTMLElement[]} */
    const released = [];
    /** @type {MountRequest} */
    const request = {
      where: 'Route "/managed"',
      tag: 'mount-alpha',
      release: (element) => {
        released.push(element);
      },
    };

    const attempt = sequence.begin();
    const element = await requireElement(request);
    sequence.begin();

    assert.notOk(await attempt.keep(element, request));
    assert.sameArray(released, [element], 'a never-inserted mount still needs its teardown');
  });

  it('keeps the element of the current attempt without releasing it', async () => {
    const sequence = new MountSequence();
    let releases = 0;
    /** @type {MountRequest} */
    const request = {
      where: 'test',
      tag: 'mount-alpha',
      release: () => {
        releases += 1;
      },
    };

    const attempt = sequence.begin();
    const element = await requireElement(request);

    assert.ok(await attempt.keep(element, request));
    assert.equal(releases, 0);
  });

  it('places an element in its container, replacing what was there', async () => {
    const container = mount('<div><span class="stale">old</span></div>');
    const sequence = new MountSequence();
    /** @type {MountRequest} */
    const request = { where: 'test', tag: 'mount-alpha' };

    const attempt = sequence.begin();
    const element = await requireElement(request);

    assert.ok(await attempt.place(container, element, request));
    assert.equal(container.childElementCount, 1);
    assert.equal(present(container.firstElementChild).localName, 'mount-alpha');
  });

  it('places nothing for a superseded attempt', async () => {
    const container = mount('<div><span class="stale">old</span></div>');
    const sequence = new MountSequence();
    /** @type {HTMLElement[]} */
    const released = [];
    /** @type {MountRequest} */
    const request = {
      where: 'test',
      tag: 'mount-alpha',
      release: (element) => {
        released.push(element);
      },
    };

    const attempt = sequence.begin();
    const element = await requireElement(request);
    sequence.begin();

    assert.notOk(await attempt.place(container, element, request));
    assert.equal(
      present(container.firstElementChild).className,
      'stale',
      'the loser must not land',
    );
    assert.equal(released.length, 1);
  });

  it('places nothing, and fails nothing, for a request that named nothing', async () => {
    const container = mount('<div></div>');
    const sequence = new MountSequence();
    /** @type {MountRequest} */
    const request = { where: 'Route "/area"' };

    const attempt = sequence.begin();
    assert.ok(await attempt.place(container, null, request));
    assert.equal(container.childElementCount, 0);
  });

  it('invalidates the running attempt on cancel, and starts none', () => {
    const sequence = new MountSequence();
    const attempt = sequence.begin();

    sequence.cancel();

    assert.notOk(attempt.live, 'a stopped router must not mount what it already asked for');
  });
});
