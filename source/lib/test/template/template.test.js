import { nothing, render } from 'lit';
import { signal } from '@core/foundation/reactive.js';
import {
  bypassSecurityTrustHtml,
  bypassSecurityTrustResourceUrl,
  bypassSecurityTrustStyle,
  bypassSecurityTrustUrl,
} from '@core/template/security.js';
import { compileTemplate, loadTemplate, prefetchTemplates } from '@core/template/template.js';
import { assert, present } from '../harness.js';

/**
 * The template compiler, tested through its output rather than its internals:
 * compile a string, render it into a real container, assert on the DOM.
 *
 * The identity test is the important one. lit-html caches a parsed template
 * against the strings array it was tagged with, so a compiler that rebuilt that
 * array per render would still produce correct HTML while quietly throwing away
 * and recreating every element. Asserting that a node survives a re-render is the
 * only thing that proves the fast path is actually taken.
 */

/** @type {HTMLElement} */
let host;

/**
 * @param {string} source
 * @param {object} model
 * @returns {HTMLElement}
 */
function paint(source, model) {
  const compiled = compileTemplate(source, 'test');
  render(compiled(model), host);
  return host;
}

describe('template compiler', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    // `render()` owns a standalone Lit root here, so explicitly clearing it is
    // what notifies async binding directives to release their signal effects.
    // SignalElement does the equivalent automatically on disconnect.
    render(nothing, host);
    host.remove();
  });

  it('interpolates text', () => {
    paint('<p>Hello {{ name }}</p>', { name: 'Ada' });
    assert.equal(present(host.querySelector('p')).textContent, 'Hello Ada');
  });

  it('unwraps signals without .value', () => {
    const name = signal('Ada');
    const model = { name };
    const compiled = compileTemplate('<p>{{ name }}</p>', 'test');

    render(compiled(model), host);
    assert.equal(present(host.querySelector('p')).textContent, 'Ada');

    name.value = 'Grace';
    render(compiled(model), host);
    assert.equal(present(host.querySelector('p')).textContent, 'Grace');
  });

  it('patches in place across renders instead of rebuilding', () => {
    const compiled = compileTemplate('<p>{{ n }}</p>', 'test');
    render(compiled({ n: 1 }), host);
    const first = present(host.querySelector('p'));

    render(compiled({ n: 2 }), host);
    assert.equal(host.querySelector('p'), first, 'lit reused the element');
    assert.equal(first.textContent, '2');
  });

  it('evaluates only bindings whose signal dependencies changed', async () => {
    const first = signal('first');
    const second = signal('second');
    let firstEvaluations = 0;
    let secondEvaluations = 0;
    const model = {
      readFirst() {
        firstEvaluations += 1;
        return first.value;
      },
      readSecond() {
        secondEvaluations += 1;
        return second.value;
      },
    };
    const compiled = compileTemplate(
      '<p class="first">{{ readFirst() }}</p><p class="second">{{ readSecond() }}</p>',
      'test',
    );

    render(compiled(model), host);
    assert.equal(firstEvaluations, 1);
    assert.equal(secondEvaluations, 1);

    first.value = 'changed';
    await Promise.resolve();

    assert.equal(present(host.querySelector('.first')).textContent, 'changed');
    assert.equal(present(host.querySelector('.second')).textContent, 'second');
    assert.equal(firstEvaluations, 2);
    assert.equal(secondEvaluations, 1, 'an unrelated binding must not be reevaluated');
  });

  it('tracks and disposes the active structural branch independently', async () => {
    const showLeft = signal(false);
    const left = signal('left');
    const right = signal('right');
    let leftEvaluations = 0;
    let rightEvaluations = 0;
    const model = {
      showLeft,
      readLeft() {
        leftEvaluations += 1;
        return left.value;
      },
      readRight() {
        rightEvaluations += 1;
        return right.value;
      },
    };
    const compiled = compileTemplate(
      '<p *if="showLeft" class="left">{{ readLeft() }}</p>' +
        '<p *else class="right">{{ readRight() }}</p>',
      'test',
    );

    render(compiled(model), host);
    assert.equal(leftEvaluations, 0);
    assert.equal(rightEvaluations, 1);

    left.value = 'inactive';
    await Promise.resolve();
    assert.equal(leftEvaluations, 0, 'an inactive branch has no live binding effect');

    showLeft.value = true;
    await Promise.resolve();
    assert.equal(present(host.querySelector('.left')).textContent, 'inactive');
    assert.equal(leftEvaluations, 1);

    right.value = 'detached';
    await Promise.resolve();
    assert.equal(rightEvaluations, 1, 'the removed branch released its binding effect');

    left.value = 'active';
    await Promise.resolve();
    assert.equal(present(host.querySelector('.left')).textContent, 'active');
    assert.equal(leftEvaluations, 2);
  });

  it('binds attributes and mixes static text with interpolation', () => {
    paint('<a [href]="\'/users/\' + id" class="base {{ tone }}">go</a>', { id: '7', tone: 'sky' });
    const anchor = present(host.querySelector('a'));
    assert.equal(anchor.getAttribute('href'), '/users/7');
    assert.equal(anchor.getAttribute('class'), 'base sky');
  });

  it('sanitizes URL bindings and attribute interpolation by protocol', () => {
    paint('<a [href]="target">go</a><img src="{{ image }}">', {
      target: 'java\nscript:alert(1)',
      image: 'data:text/html;base64,PHNjcmlwdD4=',
    });
    assert.equal(present(host.querySelector('a')).getAttribute('href'), 'unsafe:java\nscript:alert(1)');
    assert.equal(
      present(host.querySelector('img')).getAttribute('src'),
      'unsafe:data:text/html;base64,PHNjcmlwdD4=',
    );
  });

  it('sanitizes every candidate in a srcset binding', () => {
    paint('<img [srcset]="sources">', {
      sources: '/small.png 1x, java\nscript:alert(1) 2x',
    });
    assert.equal(
      present(host.querySelector('img')).getAttribute('srcset'),
      'unsafe:/small.png 1x, java\nscript:alert(1) 2x',
    );
  });

  it('allows relative, web and non-active media URLs', () => {
    paint('<a [href]="target">go</a><img [src]="image">', {
      target: '/users/7?tab=profile',
      image: 'data:image/png;base64,iVBORw0KGgo=',
    });
    assert.equal(present(host.querySelector('a')).getAttribute('href'), '/users/7?tab=profile');
    assert.equal(
      present(host.querySelector('img')).getAttribute('src'),
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('requires an explicit resource-URL bypass for embedding sinks', () => {
    assert.throws(
      () => paint('<iframe [src]="frame"></iframe>', { frame: 'about:blank' }),
      'bypassSecurityTrustResourceUrl',
    );

    paint('<iframe [src]="frame"></iframe>', {
      frame: bypassSecurityTrustResourceUrl('about:blank'),
    });
    assert.equal(present(host.querySelector('iframe')).getAttribute('src'), 'about:blank');
  });

  it('keeps URL and resource-URL trusted values in separate contexts', () => {
    assert.throws(
      () =>
        paint('<iframe [src]="frame"></iframe>', {
          frame: bypassSecurityTrustUrl('about:blank'),
        }),
      'trusted for URL',
    );
  });

  it('sanitizes HTML property bindings before assigning them', () => {
    paint('<div [.inner-h-t-m-l]="content"></div>', {
      content:
        '<p class="ok" onclick="steal()">hello <a href="javascript:steal()">there</a></p>' +
        '<script>steal()</script><iframe src="/account"></iframe>',
    });
    const div = present(host.querySelector('div'));
    assert.equal(div.querySelector('script'), null);
    assert.equal(div.querySelector('iframe'), null);
    assert.notOk(present(div.querySelector('p')).hasAttribute('onclick'));
    assert.equal(present(div.querySelector('a')).getAttribute('href'), 'unsafe:javascript:steal()');
    assert.equal(div.textContent, 'hello there');
  });

  it('supports reviewed trusted HTML while keeping the bypass visible', () => {
    paint('<div [.inner-h-t-m-l]="content"></div>', {
      content: bypassSecurityTrustHtml('<strong data-reviewed="true">reviewed</strong>'),
    });
    assert.equal(present(host.querySelector('strong')).getAttribute('data-reviewed'), 'true');
  });

  it('sanitizes style bindings and requires a bypass for dynamic URLs', () => {
    paint('<div [style]="style"></div>', { style: 'color: rebeccapurple' });
    assert.equal(present(host.querySelector('div')).getAttribute('style'), 'color: rebeccapurple');

    paint('<div [style]="style"></div>', { style: 'background: url(javascript:steal())' });
    assert.notOk(present(host.querySelector('div')).hasAttribute('style'));

    paint('<div [style]="style"></div>', {
      style: bypassSecurityTrustStyle('background-image: url(/reviewed.png)'),
    });
    assert.includes(present(host.querySelector('div')).getAttribute('style') ?? '', '/reviewed.png');
  });

  it('refuses event attributes, event properties, outerHTML and prototype bindings', () => {
    assert.throws(() => compileTemplate('<button [onclick]="handler"></button>', 'test'), 'inline event');
    assert.throws(() => compileTemplate('<button [.onclick]="handler"></button>', 'test'), 'event property');
    assert.throws(() => compileTemplate('<div [.outer-h-t-m-l]="html"></div>', 'test'), 'outerHTML');
    assert.throws(() => compileTemplate('<div [.__proto__]="value"></div>', 'test'), 'forbidden');
  });

  it('does not silently stringify a trusted value outside its sink', () => {
    // The throw is the contract under test; bypass wrappers intentionally have
    // no ordinary object stringification.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    assert.throws(() => String(bypassSecurityTrustHtml('<b>reviewed</b>')), 'cannot be converted');
  });

  it('runs the browser suite with Trusted Types enforcement active', () => {
    if (!(Object.hasOwn(globalThis, 'trustedTypes') || 'trustedTypes' in globalThis)) return;
    assert.throws(() => {
      host.innerHTML = '<p>must be TrustedHTML</p>';
    }, 'TrustedHTML');
  });

  it('treats known boolean attributes as boolean bindings', () => {
    paint('<button [disabled]="busy">x</button>', { busy: false });
    assert.notOk(present(host.querySelector('button')).hasAttribute('disabled'));

    paint('<button [disabled]="busy">x</button>', { busy: true });
    assert.ok(present(host.querySelector('button')).hasAttribute('disabled'));
  });

  it('binds properties, converting kebab-case to camelCase', () => {
    paint('<input [.value]="text" [.max-length]="limit" />', { text: 'typed', limit: 4 });
    const input = /** @type {HTMLInputElement} */ (present(host.querySelector('input')));
    assert.equal(input.value, 'typed');
    assert.equal(input.maxLength, 4);
  });

  it('wires events and exposes $event', () => {
    /** @type {string[]} */
    const seen = [];
    paint('<button (click)="record($event.type)">x</button>', {
      /** @param {string} type */
      record(type) {
        seen.push(type);
      },
    });
    present(host.querySelector('button')).click();
    assert.sameArray(seen, ['click']);
  });

  it('assigns to a signal from an event binding', () => {
    const query = signal('');
    paint('<input (input)="query = $event.target.value" />', { query });
    const input = /** @type {HTMLInputElement} */ (present(host.querySelector('input')));
    input.value = 'ada';
    input.dispatchEvent(new Event('input'));
    assert.equal(query.value, 'ada');
  });

  it('renders *if and *else', () => {
    const source = '<p *if="ok">yes</p><p *else>no</p>';
    paint(source, { ok: true });
    assert.equal(host.textContent?.trim(), 'yes');

    paint(source, { ok: false });
    assert.equal(host.textContent?.trim(), 'no');
  });

  it('omits an *if with no *else', () => {
    paint('<div><p *if="ok">yes</p></div>', { ok: false });
    assert.equal(host.querySelector('p'), null);
  });

  it('repeats with *for and exposes $index', () => {
    paint('<ul><li *for="item of items">{{ $index }}:{{ item }}</li></ul>', {
      items: ['a', 'b'],
    });
    const texts = [...host.querySelectorAll('li')].map((li) => li.textContent);
    assert.sameArray(texts, ['0:a', '1:b']);
  });

  it('keeps DOM identity for keyed rows when the list reorders', () => {
    const compiled = compileTemplate(
      '<ul><li *for="user of users; key: user.id">{{ user.name }}</li></ul>',
      'test',
    );
    const first = { id: '1', name: 'Ada' };
    const second = { id: '2', name: 'Grace' };

    render(compiled({ users: [first, second] }), host);
    const adaRow = present(host.querySelector('li'));

    render(compiled({ users: [second, first] }), host);
    const rows = [...host.querySelectorAll('li')];
    assert.equal(rows[1], adaRow, 'the keyed row moved rather than being rebuilt');
    assert.sameArray(
      rows.map((row) => row.textContent),
      ['Grace', 'Ada'],
    );
  });

  it('nests *for and sees outer loop variables', () => {
    paint(
      '<div *for="group of groups"><span *for="n of group.items">{{ group.name }}{{ n }}</span></div>',
      { groups: [{ name: 'a', items: [1, 2] }] },
    );
    const texts = [...host.querySelectorAll('span')].map((span) => span.textContent);
    assert.sameArray(texts, ['a1', 'a2']);
  });

  it('re-reads ordinary host state on every render', () => {
    // The scope object is held for the life of the host, so this is the test
    // that keeps the caching honest: Lit properties are not signals, and a
    // render must still re-evaluate what it cannot know about.
    const model = { name: 'Ada' };
    const compiled = compileTemplate('<p>{{ name }}</p>', 'test');

    render(compiled(model), host);
    assert.equal(present(host.querySelector('p')).textContent, 'Ada');

    model.name = 'Grace';
    render(compiled(model), host);
    assert.equal(present(host.querySelector('p')).textContent, 'Grace');
  });

  it('does no work for a *for row nothing changed about', () => {
    let evaluations = 0;
    const items = signal([{ id: '1' }, { id: '2' }]);
    const model = {
      items,
      /** @param {{ id: string }} item @returns {string} */
      label(item) {
        evaluations += 1;
        return item.id;
      },
    };
    const compiled = compileTemplate(
      '<ul><li *for="item of items; key: item.id">{{ label(item) }}</li></ul>',
      'test',
    );

    render(compiled(model), host);
    assert.equal(evaluations, 2);

    // A new array holding the same items in the same order. The list signal
    // changed, so the *for runs again, but no row's item, position or count did.
    items.value = [...items.value];
    assert.equal(evaluations, 2, 'unchanged rows were not re-evaluated');

    // Growing the list does re-evaluate the existing rows, and should: `$count`
    // and `$last` are in every row's scope, and both just changed.
    items.value = [...items.value, { id: '3' }];
    assert.sameArray(
      [...host.querySelectorAll('li')].map((li) => li.textContent),
      ['1', '2', '3'],
    );
  });

  it('gives a row that reuses a position its own locals', () => {
    const items = signal(['a', 'b']);
    const compiled = compileTemplate('<ul><li *for="item of items">{{ item }}</li></ul>', 'test');
    render(compiled({ items }), host);

    items.value = ['a'];
    items.value = ['a', 'c'];
    assert.sameArray(
      [...host.querySelectorAll('li')].map((li) => li.textContent),
      ['a', 'c'],
    );
  });

  it('gives an event handler the whole locals chain', () => {
    /** @type {string[]} */
    const picked = [];
    paint(
      '<div *for="group of groups">' +
        '<button *for="n of group.items" (click)="pick(group.name, n)"></button></div>',
      {
        groups: [{ name: 'a', items: [1, 2] }],
        /** @param {string} group @param {number} n */
        pick(group, n) {
          picked.push(`${group}${String(n)}`);
        },
      },
    );

    const buttons = [...host.querySelectorAll('button')];
    present(buttons[1]).click();
    assert.sameArray(picked, ['a2']);
  });

  it('survives < inside an interpolation', () => {
    paint('<p>{{ a < b ? "less" : "more" }}</p>', { a: 1, b: 2 });
    assert.equal(present(host.querySelector('p')).textContent, 'less');
  });

  it('escapes interpolated markup rather than parsing it', () => {
    paint('<p>{{ evil }}</p>', { evil: '<img src=x>' });
    assert.equal(host.querySelector('img'), null);
    assert.equal(present(host.querySelector('p')).textContent, '<img src=x>');
  });

  it('rejects a <script> in a template', () => {
    assert.throws(() => compileTemplate('<script>alert(1)</script>', 'test'), '<script>');
  });

  it('rejects an inline on* handler', () => {
    assert.throws(() => compileTemplate('<button onclick="go()">x</button>', 'test'), 'inline event');
  });

  it('rejects *for and *if on the same element', () => {
    assert.throws(
      () => compileTemplate('<li *for="a of b" *if="c">x</li>', 'test'),
      'both *for and *if',
    );
  });

  it('names the template and the expression in a syntax error', () => {
    assert.throws(() => compileTemplate('<p>{{ a + }}</p>', 'users-page.html'), 'users-page.html');
  });
});

/**
 * The registry in front of the compiler: which requests a set of URLs costs.
 *
 * `fetch` is stubbed rather than pointed at fixtures, because the assertion is a
 * *count*. A prefetch that quietly issued a second request per template would
 * render every page correctly and be invisible in any test that only checks the
 * markup — which is the whole failure mode the shared-promise cache exists to
 * prevent. ADR-0014, ADR-0081.
 */
describe('template prefetching', () => {
  /** @type {typeof globalThis.fetch} */
  let realFetch;
  /** @type {string[]} */
  let asked;
  let serial = 0;

  /** @param {string} name @returns {string} */
  const url = (name) => `/lib/test/prefetch/${name}-${String(serial)}.html`;

  beforeEach(() => {
    serial += 1;
    asked = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
      (/** @type {RequestInfo | URL} */ input) => {
        // `loadTemplate` always calls with a string href. Narrowed rather than
        // stringified, because a `Request` has no useful `toString`.
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        asked.push(new URL(href, document.baseURI).pathname);
        return Promise.resolve(
          href.includes('missing')
            ? new Response('', { status: 404, statusText: 'Not Found' })
            : new Response('<p>ok</p>', { status: 200 }),
        );
      }
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('starts every URL at once and lets the later awaits resolve from the cache', async () => {
    const urls = [url('one'), url('two'), url('three')];
    prefetchTemplates(urls);

    // The point of the whole record: nine components in one chunk are nine awaits
    // in sequence, and they cost one round trip between them only if the request
    // was already started and is shared rather than repeated.
    const compiled = await Promise.all(urls.map((each) => loadTemplate(each)));
    assert.equal(compiled.length, 3);
    assert.sameArray(asked, urls);
  });

  it('does not fetch a template twice when it is prefetched and then loaded', async () => {
    const one = url('repeat');
    prefetchTemplates([one, one]);
    await loadTemplate(one);
    await loadTemplate(one);
    assert.sameArray(asked, [one]);
  });

  it('swallows a failing prefetch and raises it at the load that needs it', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    /** @param {PromiseRejectionEvent} event */
    const record = (event) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    addEventListener('unhandledrejection', record);
    try {
      const gone = url('missing');
      prefetchTemplates([gone]);
      // Two turns of the loop: an unhandled rejection is reported after the
      // microtask queue drains, so asserting on the same tick would pass whatever
      // the prefetch did with the rejection.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.sameArray(unhandled, []);

      let raised = '';
      try {
        await loadTemplate(gone);
      } catch (error) {
        raised = error instanceof Error ? error.message : String(error);
      }
      assert.ok(raised.includes('404'), `a missing template must still throw, got ${raised}`);
    } finally {
      removeEventListener('unhandledrejection', record);
    }
  });
});
