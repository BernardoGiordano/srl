import { signal } from '@core/foundation/reactive.js';
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { recordUpdates } from '@core/diagnostics/updates.js';
import { reviseTemplate, seedTemplates } from '@core/template/template.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/** @import { ElementUpdate, UpdateRecord } from '@core/diagnostics/types.js' */

/**
 * Replacing a template's markup in a page that is already rendering it.
 *
 * What makes this worth a suite of its own is what has to survive. A reload is
 * always available and always correct; the only reason to revise a template
 * instead is that the host keeps being the same object, so a form half filled in,
 * a store already fetched and a signal already true are all still there after the
 * edit. Every test below asserts a survival as well as the new markup.
 *
 * Templates are seeded rather than fetched, except where the test is about a
 * request: seeding puts source in the same cache a fetch fills, so the compile
 * path under test is the production one. ADR-0111.
 */

let serial = 0;

/**
 * A component whose markup can be edited, under a tag and URL no other test uses.
 *
 * The module caches are keyed by URL and live for the page, and a tag can only be
 * defined once, so sharing either between tests would make them order-dependent.
 *
 * @param {string} markup
 * @param {typeof SignalElement} [element]
 * @returns {Promise<{ tag: string, url: string }>}
 */
async function component(markup, element = class extends SignalElement {}) {
  serial += 1;
  const url = `/lib/test/revision/fixture-${String(serial)}.html`;
  const tag = `revision-host-${String(serial)}`;
  seedTemplates({ [url]: markup });
  await defineComponent({ tag, element, module: import.meta.url, template: url });
  return { tag, url };
}

/**
 * A host that carries state the markup does not, so a revision can be seen to keep
 * it. Subclassed per test rather than registered, because a constructor can only
 * be given to `customElements.define` once.
 */
class Stateful extends SignalElement {
  greeting = 'hello';

  count = signal(1);

  seen = 0;

  onMount() {
    this.seen += 1;
  }
}

describe('template revisions', () => {
  afterEach(() => {
    unmountAll();
  });

  it('renders the edited markup into the host that was already showing it', async () => {
    const { tag, url } = await component(
      '<p class="before">{{ greeting }}</p>',
      class extends Stateful {},
    );
    const element = /** @type {Stateful} */ (mount(`<${tag}></${tag}>`));
    await settled(element);
    element.greeting = 'bonjour';

    assert.ok(reviseTemplate(url, '<p class="after">{{ greeting }} again</p>'));
    await settled(element);

    assert.equal(present(element.querySelector('.after')).textContent, 'bonjour again');
    assert.equal(element.querySelector('.before'), null, 'the old markup must be gone');
    assert.equal(
      element,
      document.querySelector(tag),
      'the host must be the same element, not a replacement',
    );
    assert.equal(element.seen, 1, 'a revision is a render, not a remount');
  });

  it('keeps the host state the old markup was reading', async () => {
    const { tag, url } = await component(
      '<p class="count">{{ count }}</p>',
      class extends Stateful {},
    );
    const element = /** @type {Stateful} */ (mount(`<${tag}></${tag}>`));
    await settled(element);
    element.count.value = 7;
    await settled(element);

    reviseTemplate(url, '<b class="count">{{ count }} items</b>');
    await settled(element);

    assert.equal(present(element.querySelector('.count')).textContent, '7 items');
  });

  it('binds the revised markup to the signals it reads', async () => {
    const { tag, url } = await component(
      '<p class="count">{{ count }}</p>',
      class extends Stateful {},
    );
    const element = /** @type {Stateful} */ (mount(`<${tag}></${tag}>`));
    await settled(element);

    reviseTemplate(url, '<p class="count">now {{ count }}</p>');
    await settled(element);
    element.count.value = 42;
    await settled(element);

    assert.equal(
      present(element.querySelector('.count')).textContent,
      'now 42',
      'the new bindings must own effects of their own, or the page goes dead after one edit',
    );
  });

  it('updates every host that shares the template', async () => {
    const { tag, url } = await component('<p class="text">one</p>');
    const first = mount(`<div><${tag}></${tag}><${tag}></${tag}></div>`);
    const hosts = [...first.querySelectorAll(tag)];
    await Promise.all(hosts.map((host) => settled(host)));

    reviseTemplate(url, '<p class="text">two</p>');
    await Promise.all(hosts.map((host) => settled(host)));

    assert.sameArray(
      hosts.map((host) => present(host.querySelector('.text')).textContent),
      ['two', 'two'],
    );
  });

  it('updates a host whose class inherited the template', async () => {
    class Base extends SignalElement {}
    const { url } = await component('<p class="text">base</p>', Base);

    serial += 1;
    const tag = `revision-derived-${String(serial)}`;
    await defineComponent({
      tag,
      element: class extends Base {},
      module: import.meta.url,
      template: false,
    });

    const element = mount(`<${tag}></${tag}>`);
    await settled(element);
    assert.equal(present(element.querySelector('.text')).textContent, 'base');

    reviseTemplate(url, '<p class="text">edited</p>');
    await settled(element);

    assert.equal(present(element.querySelector('.text')).textContent, 'edited');
  });

  it('projects the same authored children into the revised markup', async () => {
    const { tag, url } = await component('<section><x-content></x-content></section>');
    const element = mount(`<${tag}><span class="authored">mine</span></${tag}>`);
    await settled(element);
    const authored = present(element.querySelector('.authored'));

    reviseTemplate(url, '<article class="wrapper"><x-content></x-content></article>');
    await settled(element);

    assert.ok(present(element.querySelector('.wrapper')), 'the revision must have rendered');
    assert.equal(
      element.querySelector('.authored'),
      authored,
      'projected children are moved, never recreated, so the node must be the same one',
    );
  });

  it('renders the revision when a host that was away comes back', async () => {
    const { tag, url } = await component('<p class="text">before</p>');
    const element = mount(`<${tag}></${tag}>`);
    await settled(element);
    element.remove();

    reviseTemplate(url, '<p class="text">after</p>');
    document.body.append(element);
    await settled(element);

    assert.equal(present(element.querySelector('.text')).textContent, 'after');
    element.remove();
  });

  it('keeps the previous markup when an edit does not compile', async () => {
    const { tag, url } = await component('<p class="text">good</p>');
    const element = mount(`<${tag}></${tag}>`);
    await settled(element);

    assert.throws(() => reviseTemplate(url, '<p []="">no</p>'));
    await settled(element);

    assert.equal(
      present(element.querySelector('.text')).textContent,
      'good',
      'a file caught half-written must not blank the screen',
    );

    reviseTemplate(url, '<p class="text">better</p>');
    await settled(element);
    assert.equal(
      present(element.querySelector('.text')).textContent,
      'better',
      'the failed edit must not have poisoned the cache for the one that follows',
    );
  });

  it('reports that the template is why the element rendered', async () => {
    const { tag, url } = await component('<p class="text">before</p>');
    const element = mount(`<${tag}></${tag}>`);
    await settled(element);

    const stop = recordUpdates();
    reviseTemplate(url, '<p class="text">after</p>');
    await settled(element);
    const report = stop();

    const causes = report.records
      .filter(
        /** @returns {record is ElementUpdate} */
        (/** @type {UpdateRecord} */ record) => record.kind === 'element' && record.tag === tag,
      )
      .map((record) => record.cause);
    assert.sameArray(causes, ['template'], 'ADR-0109: the path that knew names the cause');
  });

  it('answers false for a template this page never loaded', () => {
    assert.notOk(reviseTemplate('/lib/test/revision/never-asked-for.html', '<p>hi</p>'));
  });
});

/**
 * The edit that arrives while the template is still on its way.
 *
 * The request resolves after the revision has been published, and what it carries is
 * the file as it was before the save. Compiling those bytes would attach markup the
 * developer has already replaced. Worse, because it outlives the edit, it would hand one
 * URL a second strings array, so two hosts of one template would render from different
 * parsed templates for the rest of the session. ADR-0014.
 */
describe('a revision that races the first request', () => {
  /** @type {typeof globalThis.fetch} */
  let realFetch;

  /** @type {(body: string) => void} */
  let answer;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
      () =>
        new Promise((resolve) => {
          answer = (body) => {
            resolve(new Response(body, { status: 200 }));
          };
        })
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    unmountAll();
  });

  it('wins, and the bytes that arrive late are dropped', async () => {
    serial += 1;
    const url = `/lib/test/revision/racing-${String(serial)}.html`;
    const tag = `revision-racing-${String(serial)}`;

    // Not awaited yet, because the definition is waiting on the request, which is the
    // window an edit can land in. `attachTemplate` starts the request before its first
    // await, so the URL is in the source cache by the time this returns.
    const defining = defineComponent({
      tag,
      element: class extends SignalElement {},
      module: import.meta.url,
      template: url,
    });

    assert.ok(reviseTemplate(url, '<p class="text">edited</p>'));
    answer('<p class="text">from disk</p>');
    await defining;

    const element = mount(`<${tag}></${tag}>`);
    await settled(element);

    assert.equal(present(element.querySelector('.text')).textContent, 'edited');
  });
});
