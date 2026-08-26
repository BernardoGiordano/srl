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

/**
 * The findings as sentences.
 *
 * The seam answers with `Diagnostic[]` — a code, a file, a line and a column each,
 * which is what an editor underlines. What most of these cases are about is the
 * wording, so they read the messages; the two below this pin the rest of the shape.
 *
 * @param {string} source
 * @returns {string[]}
 */
function check(source) {
  return checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source,
    elements: child,
  }).map((diagnostic) => diagnostic.message);
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
  }).map((diagnostic) => diagnostic.message);
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

void test('a negated numeric literal keeps its literal type', () => {
  // TypeScript gives a numeric literal type to `-` applied directly to a numeric
  // literal and to nothing else: `-1` is `-1`, and `-(1)` is `number`. Emitting the
  // parenthesised form made a handler typed `(id, direction: 1 | -1)` reject
  // `move(1, -1)` while accepting `move(1, 1)` — a checker bug that reads as a bug
  // in the template, and one every move-up/move-down pair in an application hits.
  assert.deepEqual(check('<button (click)="move(1, -1)"></button>'), []);
  assert.deepEqual(check('<button (click)="move(1, 1)"></button>'), []);

  // Everything else the operator applies to still goes through the general path.
  assert.deepEqual(check('<span>{{ -rows.length }}</span>'), []);
});

void test('a finding carries the code, file, line and column an editor needs', () => {
  const source = ['<p>{{ label }}</p>', '<p>{{ rows.lenght }}</p>', ''].join('\n');
  const [found, ...rest] = checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source,
    elements: child,
  });

  assert.deepEqual(rest, [], 'one bad member is one finding');
  assert.equal(found?.severity, 'error');
  // The TypeScript error number, not the sentence beside it: the wording of
  // "Property does not exist" is TypeScript's to change and this is not. 2551 is
  // the did-you-mean variant, which is what a near-miss like `lenght` produces.
  assert.equal(found?.code, 'templates/ts2551');
  assert.equal(found?.file, 'fixture.html');
  // The second line of the template, not a position in the generated shim.
  assert.equal(found?.line, 2);
  assert.ok((found?.column ?? 0) > 1);
});

void test('a dialect refusal is a finding of its own kind', () => {
  const [found] = checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source: '<button [onclick]="choose"></button>',
    elements: child,
  });

  assert.equal(found?.code, 'templates/dialect');
  assert.equal(found?.line, 1);
  assert.match(String(found?.message), /forbidden/u);
});
