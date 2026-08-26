/**
 * The production template transform: what it removes, what it refuses to touch,
 * and the equivalence it proves before returning bytes.
 *
 * Every case here is a rendering that would change if the transform were one step
 * greedier, which is the only interesting property a minifier has.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { minifyTemplate, templateShape } from '../delivery/template-html.mjs';

void test('indentation and comments go, structure and words stay', () => {
  assert.equal(
    minifyTemplate('<div class="card">\n  <!-- why -->\n  <p>Hello</p>\n</div>\n'),
    '<div class="card"> <p>Hello</p> </div>',
  );
});

void test('a run of whitespace is collapsed, never deleted', () => {
  // `a<span> </span>b` and `a<span></span>b` are two renderings, and only the
  // author knows which one was meant.
  assert.equal(minifyTemplate('a<span> </span>b'), 'a<span> </span>b');
  assert.equal(minifyTemplate('<p>one\n\n   two</p>'), '<p>one two</p>');
});

void test('a comment between two words leaves one space, not two', () => {
  assert.equal(minifyTemplate('<p>one <!-- note --> two</p>'), '<p>one two</p>');
});

void test('class is collapsed as the token list it is', () => {
  assert.equal(
    minifyTemplate('<div\n  class="mt-2\n    flex   gap-3"\n>x</div>'),
    '<div class="mt-2 flex gap-3">x</div>',
  );
});

void test('a non-breaking space is not whitespace', () => {
  assert.equal(minifyTemplate('<p>10&nbsp;&nbsp;kg</p>'), '<p>10&nbsp;&nbsp;kg</p>');
  // Two spaces are one space; two non-breaking spaces are two characters, and
  // parse5 writes them back as the entity they arrived as.
  assert.equal(minifyTemplate('<p>10 \u00a0 kg</p>'), '<p>10 &nbsp; kg</p>');
});

void test('pre, textarea, script and style keep every byte', () => {
  for (const tag of ['pre', 'textarea', 'script', 'style']) {
    const source = `<${tag}>  a\n\n  b  </${tag}>`;
    assert.equal(minifyTemplate(source), source, tag);
  }
  assert.equal(minifyTemplate('<pre>a<!--kept-->b</pre>'), '<pre>a<!--kept-->b</pre>');
});

void test('an element that declares its whitespace significant keeps it', () => {
  // Tailwind's `whitespace-pre-line` renders the newline around an interpolation.
  // Collapsing it would silently delete a line break the page currently shows.
  const preLine = '<p class="mt-2 whitespace-pre-line">\n  {{ item.detail }}\n</p>';
  assert.equal(minifyTemplate(preLine), preLine);

  const inlineStyle = '<p style="white-space: pre-wrap">\n  a  b\n</p>';
  assert.equal(minifyTemplate(inlineStyle), inlineStyle);

  const arbitrary = '<p class="[white-space:pre]">\n  a  b\n</p>';
  assert.equal(minifyTemplate(arbitrary), arbitrary);

  // Preservation inherits, so a child of a preserving element is left alone too.
  assert.equal(
    minifyTemplate('<div class="whitespace-pre"><span>  a  </span></div>'),
    '<div class="whitespace-pre"><span>  a  </span></div>',
  );
});

void test('whitespace-nowrap and whitespace-normal still collapse', () => {
  assert.equal(
    minifyTemplate('<p class="whitespace-nowrap">a\n  b</p>'),
    '<p class="whitespace-nowrap">a b</p>',
  );
});

void test('an interpolation survives the HTML parser byte for byte', () => {
  // `{{ a < b }}` in text content would otherwise be parsed as a tag named `b`.
  assert.equal(minifyTemplate('<p>{{ a < b }}   {{ c }}</p>'), '<p>{{ a < b }} {{ c }}</p>');
  assert.equal(
    minifyTemplate('<ui-card *if="left < right" [label]="a  +  b"></ui-card>'),
    '<ui-card *if="left < right" [label]="a  +  b"></ui-card>',
  );
});

void test('directive and binding attributes are untouched', () => {
  const source =
    '<li\n  *for="item of items; key: item.id"\n  (click)="select(item)"\n  [class]="tone"\n>{{ item.name }}</li>';
  assert.equal(
    minifyTemplate(source),
    '<li *for="item of items; key: item.id" (click)="select(item)" [class]="tone">{{ item.name }}</li>',
  );
});

void test('the shape of a template is the shape of its minified form', () => {
  const source = [
    '<section class="grid\n  gap-4">',
    '  <!-- a comment that costs bytes -->',
    '  <h2>{{ title }}</h2>',
    '  <table>',
    '    <tr><td>{{ row.name }}</td></tr>',
    '  </table>',
    '  <pre>  kept  </pre>',
    '  <img src="/a.png" alt="">',
    '</section>',
  ].join('\n');
  assert.deepEqual(templateShape(source), templateShape(minifyTemplate(source)));
});

void test('an equivalence failure is a thrown error, not silent bytes', () => {
  // The proof is the reason this transform is allowed to change what production
  // serves, so it has to be a proof of something: a shape that lost a node must
  // not compare equal to one that kept it.
  assert.notDeepEqual(templateShape('<p>a</p><p>b</p>'), templateShape('<p>a</p>'));
  assert.notDeepEqual(templateShape('<p>a b</p>'), templateShape('<p>ab</p>'));
  assert.notDeepEqual(templateShape('<p class="x">a</p>'), templateShape('<p>a</p>'));
  assert.notDeepEqual(templateShape('<pre>a  b</pre>'), templateShape('<pre>a b</pre>'));
});
