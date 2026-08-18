import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkTemplateSource, parseTemplate } from '../checks/template-check.mjs';

const module = fileURLToPath(new URL('./fixtures/template-check-component.mjs', import.meta.url));
const child = new Map([
  [
    'test-child',
    {
      module,
      className: 'TemplateCheckChild',
      exported: true,
      properties: ['items'],
      observedAttributes: ['empty-label', 'label'],
    },
  ],
]);

/** @param {string} source */
function check(source) {
  return checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source,
    elements: child,
  });
}

/** As `check`, with the component's `uses` list resolved to the tags it allows. */
function checkWithUses(/** @type {string} */ source, /** @type {string[]} */ available) {
  return checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source,
    elements: child,
    available: new Set(available),
  });
}

void test('accepts typed members, loop locals, events, booleans and custom properties', () => {
  assert.deepEqual(
    check(`
      <button [?disabled]="busy" (click)="choose(1)">{{ rows.length }}</button>
      <p *for="row of rows; key: row.id">{{ row.name }}</p>
      <test-child [.items]="rows"></test-child>
    `),
    [],
  );
});

void test('reports unknown component members and loop-local properties', () => {
  assert.match(check('<p>{{ rows.lenght }}</p>').join('\n'), /lenght/u);
  assert.match(check('<p *for="row of rows">{{ row.missing }}</p>').join('\n'), /missing/u);
});

void test('checks boolean and custom-element property assignments', () => {
  assert.match(check('<button [?disabled]="label"></button>').join('\n'), /boolean/u);
  assert.match(check('<test-child [.items]="label"></test-child>').join('\n'), /not assignable/u);
  assert.match(check('<test-child [.missing]="rows"></test-child>').join('\n'), /missing/u);
});

void test('checks security-sensitive property contexts and forbidden sinks', () => {
  assert.deepEqual(
    check(`
      <div [.inner-h-t-m-l]="trustedHtml"></div>
      <iframe [.src]="trustedResourceUrl"></iframe>
    `),
    [],
  );
  assert.match(check('<iframe [.src]="label"></iframe>').join('\n'), /TrustedResourceUrl/u);
  assert.match(check('<button [onclick]="choose"></button>').join('\n'), /forbidden/u);
  assert.match(check('<button [.onclick]="choose"></button>').join('\n'), /forbidden/u);
  assert.match(check('<div [.outer-h-t-m-l]="trustedHtml"></div>').join('\n'), /forbidden/u);
});

void test('types native event targets', () => {
  assert.match(check('<input (change)="choose($event.target.value)">').join('\n'), /string/u);
});

void test('refuses what the runtime refuses, from the shared dialect', () => {
  // Three rules the checker used to ignore while template.js enforced them.
  assert.match(
    check('<p *for="row of rows" *if="busy">{{ row.name }}</p>').join('\n'),
    /both \*for and \*if/u,
  );
  assert.match(check('<button onclick="choose(1)"></button>').join('\n'), /forbidden/u);
  assert.match(check('<img [.srcset]="rows">').join('\n'), /TrustedUrl/u);
  assert.deepEqual(check('<img [.srcset]="label">'), []);
});

void test('refuses reserved member names in every operation, as the evaluator does', () => {
  // Parity, not decoration: the checker used to emit `(host).__proto__ = ...`
  // as ordinary TypeScript while the evaluator refused only the read.
  for (const source of [
    '<p>{{ rows.constructor }}</p>',
    '<button (click)="rows.__proto__ = rows"></button>',
    `<button (click)="rows['__proto__'] = rows"></button>`,
    '<button (click)="choose({ __proto__: rows })"></button>',
  ]) {
    assert.match(check(source).join('\n'), /may not access/u, source);
  }
  assert.deepEqual(check('<button (click)="choose(rows.length)"></button>'), []);
});

void test('reports unknown tags and keeps comparisons inside interpolations as expressions', () => {
  assert.match(check('<mystery-widget></mystery-widget>').join('\n'), /unknown element/u);
  assert.equal(parseTemplate('<p>{{ rows.length < 3 }}</p>', 'fixture.html').length, 1);
  assert.deepEqual(check('<p>{{ rows.length < 3 }}</p>'), []);
});

void test('an attribute a custom element does not observe is an error', () => {
  // The gap this closes: a property binding to a removed name was always a type error,
  // while `empty-label="No rows"` on an element that observes nothing set a string on the
  // DOM and rendered nothing. Renaming a public property left every caller compiling.
  assert.deepEqual(check('<test-child label="x" [label]="label"></test-child>'), []);
  assert.deepEqual(
    check('<test-child class="p-2" id="a" hidden aria-label="x" data-id="1"></test-child>'),
    [],
    'global, ARIA and data attributes belong to every element',
  );

  // The trap itself: Lit's default attribute for `emptyLabel` is `emptylabel`, so the
  // kebab spelling everything else in the dialect uses is the one that has to be declared.
  assert.match(
    check('<test-child emptylabel="x"></test-child>').join('\n'),
    /Did you mean empty-label/u,
  );
  assert.match(check('<test-child labell="x"></test-child>').join('\n'), /--element test-child/u);
  assert.match(check('<test-child [labell]="label"></test-child>').join('\n'), /does not observe/u);
  assert.match(check('<test-child [?labell]="busy"></test-child>').join('\n'), /does not observe/u);
  assert.match(
    check('<test-child items="x"></test-child>').join('\n'),
    /property with no attribute.*\[\.items\]/su,
    'a property that is not reachable as an attribute says how to reach it',
  );

  // Native elements keep every attribute: nothing here knows what <input> accepts.
  assert.deepEqual(check('<input placeholder="x" list="ids">'), []);

  // The projection marker is the dialect's, and `name` is the bucket it projects.
  assert.deepEqual(check('<x-content name="header"></x-content>'), []);
  assert.match(check('<x-content nme="header"></x-content>').join('\n'), /does not observe/u);

  // An element whose surface no tool could read is skipped rather than guessed at.
  const opaque = new Map([
    ['test-child', { module, className: 'TemplateCheckChild', exported: true, observedAttributes: null }],
  ]);
  assert.deepEqual(
    checkTemplateSource({
      module,
      className: 'TemplateCheckHost',
      template: 'fixture.html',
      source: '<test-child labell="x"></test-child>',
      elements: opaque,
    }),
    [],
  );
});

void test('an element the component does not import is an error naming the class to add', () => {
  // The checker used to accept any tag defined anywhere in the repository, so a
  // template could name a component its application never imported.
  assert.deepEqual(checkWithUses('<test-child></test-child>', ['test-child']), []);
  assert.match(
    checkWithUses('<test-child></test-child>', []).join('\n'),
    /Add `TemplateCheckChild` to its `uses`/u,
  );
  assert.deepEqual(checkWithUses('<x-content></x-content>', []), [], 'the projection marker');
});
