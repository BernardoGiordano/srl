import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
      state: ['internal'],
      observedAttributes: ['empty-label', 'label'],
      events: [
        {
          name: 'items-change',
          event: /** @type {const} */ ('CustomEvent'),
          detail: { kind: /** @type {const} */ ('property'), name: 'items' },
        },
      ],
    },
  ],
]);

/**
 * The findings as sentences.
 *
 * The seam answers with `Diagnostic[]`, each carrying a code, a file, a line and a
 * column, which is what an editor underlines. Most of these cases are about the
 * wording, so they read the messages, and the two below this pin the rest of the
 * shape.
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
  assert.match(
    check('<test-child [.internal]="rows"></test-child>').join('\n'),
    /internal reactive state, not a public input/u,
  );
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

void test('types custom event detail from Element metadata', () => {
  assert.deepEqual(
    check('<test-child (items-change)="choose($event.detail.length)"></test-child>'),
    [],
  );
  assert.match(
    check('<test-child (items-change)="choose($event.detail.missing)"></test-child>').join('\n'),
    /missing/u,
  );
});

void test('refuses what the runtime refuses, from the shared dialect', () => {
  // Three rules template.js enforces, checked here too.
  assert.match(
    check('<p *for="row of rows" *if="busy">{{ row.name }}</p>').join('\n'),
    /both \*for and \*if/u,
  );
  assert.match(check('<button onclick="choose(1)"></button>').join('\n'), /forbidden/u);
  assert.match(check('<img [.srcset]="rows">').join('\n'), /TrustedUrl/u);
  assert.deepEqual(check('<img [.srcset]="label">'), []);
});

void test('refuses reserved member names in every operation, as the evaluator does', () => {
  // Parity rather than decoration. Emitted as ordinary TypeScript,
  // `(host).__proto__ = ...` would pass the checker while the evaluator refused the
  // read.
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
  // The gap this closes. A property binding to a removed name is always a type error,
  // while `empty-label="No rows"` on an element that observes nothing sets a string on
  // the DOM and renders nothing, so renaming a public property leaves every caller
  // compiling.
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

  // Native elements keep every attribute, because nothing here knows what <input>
  // accepts.
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
  // Accepting any tag defined anywhere in the repository would let a template name a
  // component its application never imported.
  assert.deepEqual(checkWithUses('<test-child></test-child>', ['test-child']), []);
  assert.match(
    checkWithUses('<test-child></test-child>', []).join('\n'),
    /Add `TemplateCheckChild` to its `uses`/u,
  );
  assert.deepEqual(checkWithUses('<x-content></x-content>', []), [], 'the projection marker');
});

void test('a negated numeric literal keeps its literal type', () => {
  // TypeScript gives a numeric literal type to `-` applied directly to a numeric
  // literal and to nothing else, so `-1` is `-1` and `-(1)` is `number`. The
  // parenthesised form would make a handler typed `(id, direction: 1 | -1)` reject
  // `move(1, -1)` while accepting `move(1, 1)`, a checker bug that reads as a bug in
  // the template and one every move-up and move-down pair in an application hits.
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
  // The TypeScript error number rather than the sentence beside it, because the
  // wording of "Property does not exist" is TypeScript's to change and the number is
  // not. 2551 is the did-you-mean variant, which is what a near-miss like `lenght`
  // produces.
  assert.equal(found?.code, 'templates/ts2551');
  assert.equal(found?.file, 'fixture.html');
  // The second line of the template, not a position in the generated shim.
  assert.equal(found?.line, 2);
  assert.ok((found?.column ?? 0) > 1);
});

void test('each dialect refusal carries a code of its own', () => {
  // A quick fix, a filter or a test names the problem by code, so two problems never
  // share one and no caller has to read the sentence to tell them apart.
  const cases = /** @type {Array<[string, string]>} */ ([
    ['templates/for-with-if', '<p *for="row of rows" *if="busy"></p>'],
    ['templates/else-without-if', '<p *else></p>'],
    ['templates/invalid-for', '<p *for="rows"></p>'],
    ['templates/invalid-for-clause', '<p *for="row of rows; sorted"></p>'],
    ['templates/template-without-fragment', '<div><template></template></div>'],
    ['templates/fragment-without-owner', '<template *fragment="cell(row)"></template>'],
    ['templates/inline-handler', '<button onclick="choose(1)"></button>'],
    ['templates/inline-handler', '<button [onclick]="choose"></button>'],
    ['templates/empty-binding', '<p []="busy"></p>'],
    ['templates/refused-property', '<div [.outer-h-t-m-l]="trustedHtml"></div>'],
    ['templates/state-binding', '<test-child [.internal]="rows"></test-child>'],
    ['templates/state-binding', '<test-child><template *fragment="internal(row)"></template></test-child>'],
    ['templates/fragment-outside-template', '<test-child><p *fragment="cell(row)"></p></test-child>'],
    ['templates/invalid-fragment', '<test-child><template *fragment="cell"></template></test-child>'],
    ['templates/fragment-on-sink', '<div><template *fragment="inner-h-t-m-l(row)"></template></div>'],
    [
      'templates/duplicate-fragment',
      '<test-child><template *fragment="typed-cell(row)"></template>' +
        '<template *fragment="typed-cell(row)"></template></test-child>',
    ],
    ['templates/property-without-attribute', '<test-child items="x"></test-child>'],
    ['templates/unknown-attribute', '<test-child labell="x"></test-child>'],
    ['templates/expression', '<p>{{ rows.constructor }}</p>'],
    ['templates/unknown-element', '<mystery-widget></mystery-widget>'],
  ]);

  for (const [code, source] of cases) {
    const codes = checkTemplateSource({
      module,
      className: 'TemplateCheckHost',
      template: 'fixture.html',
      source,
      elements: child,
    })
      .map((diagnostic) => diagnostic.code)
      .filter((found) => !/^templates\/ts\d+$/u.test(found));
    assert.deepEqual(codes, [code], source);
  }

  const [missing] = checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source: '<test-child></test-child>',
    elements: child,
    available: new Set(),
  });
  assert.equal(missing?.code, 'templates/missing-use');
  assert.equal(missing?.line, 1);
});

void test('an unsaved JavaScript buffer overrides the file on disk', async () => {
  const source = await readFile(module, 'utf8');
  const changed = source.replace("  label = '';", "  renamed = '';");
  const diagnostics = checkTemplateSource({
    module,
    className: 'TemplateCheckHost',
    template: 'fixture.html',
    source: '<p>{{ label }}</p>',
    elements: child,
    files: new Map([[module, changed]]),
  });

  assert.match(diagnostics.map((diagnostic) => diagnostic.message).join('\n'), /label/u);
});

/**
 * `*fragment` bodies are checked in the page that wrote them, against the property
 * they are assigned to. Two things have to hold. The locals get real types, and the
 * body is not silently skipped, because a checker that walked past a `<template>`
 * would report nothing at all and look like it passed.
 */
void test('checks a fragment body against the property it is assigned to', () => {
  assert.deepEqual(
    check(`
      <test-child>
        <template *fragment="cell(row of rows)">{{ row.name }}</template>
      </test-child>
    `),
    [],
  );
  assert.deepEqual(
    check(`
      <test-child>
        <template *fragment="typed-cell(row)">{{ row.name }}</template>
      </test-child>
    `),
    [],
  );
});

void test('reports a bad member of a fragment local', () => {
  assert.match(
    check(`
      <test-child>
        <template *fragment="cell(row of rows)">{{ row.missing }}</template>
      </test-child>
    `).join('\n'),
    /missing/u,
  );
  assert.match(
    check(`
      <test-child>
        <template *fragment="typed-cell(row)">{{ row.missing }}</template>
      </test-child>
    `).join('\n'),
    /missing/u,
  );
});

void test('leaves an unannotated local with the type the property declares', () => {
  assert.match(
    check(`
      <test-child>
        <template *fragment="cell(row)">{{ row.name }}</template>
      </test-child>
    `).join('\n'),
    /unknown/u,
  );
});

void test('checks the iterable a fragment local is annotated with', () => {
  assert.match(
    check(`
      <test-child>
        <template *fragment="cell(row of missingRows)">{{ row.name }}</template>
      </test-child>
    `).join('\n'),
    /missingRows/u,
  );
});

void test('reports a fragment named after a property the element does not have', () => {
  assert.match(
    check(`
      <test-child>
        <template *fragment="missing-cell(row of rows)">{{ row.name }}</template>
      </test-child>
    `).join('\n'),
    /missingCell/u,
  );
  assert.match(
    check(`
      <test-child>
        <template *fragment="caption(row of rows)">{{ row.name }}</template>
      </test-child>
    `).join('\n'),
    /not assignable/u,
  );
});

void test('refuses a fragment on an element that is not a template', () => {
  assert.match(
    check('<test-child><p *fragment="cell(row)">x</p></test-child>').join('\n'),
    /Only <template> may declare one/u,
  );
});

void test('refuses a template that declares no fragment, wherever it sits', () => {
  assert.match(
    check('<test-child><template>{{ label }}</template></test-child>').join('\n'),
    /<template> has no \*fragment/u,
  );
  assert.match(check('<template>{{ label }}</template>').join('\n'), /has no \*fragment/u);
  assert.match(
    check('<template *fragment="cell(row)">{{ label }}</template>').join('\n'),
    /no element to belong to/u,
  );
});

void test('refuses an unreadable or repeated fragment head', () => {
  assert.match(
    check('<test-child><template *fragment="cell row"></template></test-child>').join('\n'),
    /invalid \*fragment expression/u,
  );
  assert.match(
    check(
      '<test-child><template *fragment="cell(a)"></template>' +
        '<template *fragment="cell(b)"></template></test-child>',
    ).join('\n'),
    /duplicate \*fragment cell/u,
  );
});

void test('refuses a fragment named after internal state or a text sink', () => {
  assert.match(
    check('<test-child><template *fragment="internal(row)"></template></test-child>').join('\n'),
    /internal reactive state/u,
  );
  assert.match(
    check('<test-child><template *fragment="inner-h-t-m-l(row)"></template></test-child>').join('\n'),
    /text sink/u,
  );
});

void test('sees enclosing loop locals inside a fragment body, and shadows them', () => {
  assert.deepEqual(
    check(`
      <div *for="row of rows; key: row.id">
        <test-child>
          <template *fragment="cell(item of rows)">{{ row.name }} {{ item.name }} {{ $index }}</template>
        </test-child>
      </div>
    `),
    [],
  );
  assert.match(
    check(`
      <div *for="row of rows; key: row.id">
        <test-child>
          <template *fragment="cell(row)">{{ row.name }}</template>
        </test-child>
      </div>
    `).join('\n'),
    /unknown/u,
  );
});
