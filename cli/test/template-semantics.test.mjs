import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

import { SrlLanguageService } from '../language-server/service.mjs';

const template = resolve('example/src/pages/people/employees-page.html');
const host = resolve('example/src/pages/people/employees-page.js');
const tableHost = resolve('source/components/data/ui-table.js');
const templateUri = pathToFileURL(template).href;
const hostUri = pathToFileURL(host).href;
const tableHostUri = pathToFileURL(tableHost).href;

void test('one template semantic snapshot drives completion context', async (context) => {
  const service = new SrlLanguageService();
  await service.reload();
  let version = 1;

  /** @param {string} source @param {number} [at] */
  const complete = async (source, at = source.length) => {
    service.change(templateUri, version, source);
    version += 1;
    return service.completion(templateUri, positionAt(source, at));
  };

  await context.test('completes bare tags and native input bindings', async () => {
    const tags = await complete('<');
    assert.ok(tags.some((item) => item.filterText === 'ui-table'));

    const input = await complete('<input ');
    const labels = new Set(input.map((item) => item.label));
    assert.ok(labels.has('[value]'));
    assert.ok(labels.has('[.value]'));
    assert.ok(labels.has('[?disabled]'));
  });

  await context.test('asks the compiler for nested host and event members', async () => {
    const rows = await complete('{{ rows.');
    assert.ok(rows.some((item) => item.label === 'length'));
    assert.ok(!rows.some((item) => item.label === 'rowKey'));

    const event = await complete('<button (click)="$event.');
    assert.ok(event.some((item) => item.label === 'target'));
    assert.ok(event.some((item) => item.label === 'currentTarget'));
    assert.ok(!event.some((item) => item.label === 'rows'));
  });

  await context.test('offers public inputs and typed custom events from Element metadata', async () => {
    const avatar = await complete('<ui-avatar ');
    const avatarLabels = new Set(avatar.map((item) => item.label));
    assert.ok(avatarLabels.has('[.src]'));
    assert.ok(!avatarLabels.has('[.broken]'), 'internal state leaked as caller input');

    const combobox = await complete('<ui-combobox ');
    assert.ok(combobox.some((item) => item.label === '(selection-change)'));

    const detail = await complete('<ui-combobox (selection-change)="$event.detail.');
    assert.ok(detail.some((item) => item.label === 'length'));
    assert.ok(detail.some((item) => item.label === 'map'));
  });

  await context.test('completes projection names declared by the parent template', async () => {
    const source = '<app-card><span slot=""></span></app-card>';
    const at = source.indexOf('slot="') + 'slot="'.length;
    const slots = await complete(source, at);
    assert.deepEqual(slots.map((item) => item.label), ['actions', 'toolbar']);
  });

  await context.test('invalidates typed members when an open host changes', async () => {
    const original = await readFile(host, 'utf8');
    const changed = original.replace('rows = this.#employees.value;', 'rows = 1;');
    service.open(hostUri, 'javascript', 1, changed);
    const number = await complete('{{ rows.');
    assert.ok(number.some((item) => item.label === 'toFixed'));
    assert.ok(!number.some((item) => item.label === 'length'));
    service.close(hostUri);
  });

  await context.test('keeps loop locals inside their element scope', async () => {
    const source =
      '<div *for="person of rows; index as position"><span>{{ person. }}</span></div>' +
      '<p>{{ per }}</p>';
    const memberAt = source.indexOf('person.') + 'person.'.length;
    const person = await complete(source, memberAt);
    assert.ok(person.some((item) => item.label === 'name'));

    const outsideAt = source.lastIndexOf('per') + 'per'.length;
    const outside = await complete(source, outsideAt);
    assert.ok(!outside.some((item) => item.label === 'person'));
    assert.ok(!outside.some((item) => item.label === 'position'));
    assert.ok(!outside.some((item) => item.label === '$index'));
  });

  await context.test('types fragment locals from the annotation, then from the property', async () => {
    const annotated =
      '<ui-table-column><template *fragment="cell(person of rows)">{{ person. }}' +
      '</template></ui-table-column>';
    const person = await complete(annotated, annotated.indexOf('person. ') + 'person.'.length);
    assert.ok(person.some((item) => item.label === 'name'));
    assert.ok(person.some((item) => item.label === 'email'));

    // Without the annotation the column can only offer `unknown`, so the compiler
    // has no members to give and the answer must be empty rather than the host's.
    const bare =
      '<ui-table-column><template *fragment="cell(person)">{{ person. }}' +
      '</template></ui-table-column>';
    const unknownRow = await complete(bare, bare.indexOf('person. ') + 'person.'.length);
    assert.ok(!unknownRow.some((item) => item.label === 'name'));
  });

  await context.test('keeps fragment locals inside the fragment', async () => {
    const source =
      '<ui-table-column><template *fragment="cell(person of rows)">{{ person.name }}' +
      '</template></ui-table-column><p>{{ per }}</p>';
    const outside = await complete(source, source.lastIndexOf('per') + 'per'.length);
    assert.ok(!outside.some((item) => item.label === 'person'));
  });

  await context.test('completes the iterable a fragment local is annotated with', async () => {
    const source = '<ui-table-column><template *fragment="cell(person of ro';
    const annotation = await complete(source);
    assert.ok(annotation.some((item) => item.label === 'rows'));
    assert.ok(!annotation.some((item) => item.label === 'person'));
  });

  await context.test('keeps quotes and comparisons in expression context', async () => {
    const quoted = '<p [title]="t(\'people.title\', rows.length < ro';
    const inAttribute = await complete(quoted);
    assert.ok(inAttribute.some((item) => item.label === 'rows'));
    assert.ok(!inAttribute.some((item) => item.label === '*for'));

    const compared = '<p>{{ rows.length < ro';
    const inText = await complete(compared);
    assert.ok(inText.some((item) => item.label === 'rows'));
  });
});

void test('tag rename edits symbols only and starts from either declaration', async () => {
  const service = new SrlLanguageService();
  await service.reload();
  const source =
    '<ui-table></ui-table>' +
    '<!-- <ui-table></ui-table> -->' +
    '<script>const sample = "<ui-table></ui-table>";</script>';
  service.open(templateUri, 'html', 1, source);

  const at = positionAt(source, source.indexOf('ui-table') + 2);
  const renamed = await service.rename(templateUri, at, 'ui-grid');
  const templateEdits = renamed?.changes?.[templateUri] ?? [];
  assert.equal(templateEdits.length, 2);
  const result = applyEdits(source, templateEdits);
  assert.match(result, /^<ui-grid><\/ui-grid>/u);
  assert.match(result, /<!-- <ui-table><\/ui-table> -->/u);
  assert.match(result, /"<ui-table><\/ui-table>"/u);

  await assert.rejects(
    service.rename(templateUri, at, 'ui-dialog'),
    /<ui-dialog> is already registered/u,
  );

  const tableHostSource = await readFile(tableHost, 'utf8');
  service.open(tableHostUri, 'javascript', 1, tableHostSource);
  const declaration = tableHostSource.lastIndexOf("tag: 'ui-table'");
  const declarationAt = tableHostSource.indexOf("'ui-table'", declaration) + 2;
  const prepared = await service.prepareRename(
    tableHostUri,
    positionAt(tableHostSource, declarationAt),
  );
  assert.equal(prepared?.placeholder, 'ui-table');
  const fromDeclaration = await service.rename(
    tableHostUri,
    positionAt(tableHostSource, declarationAt),
    'ui-grid',
  );
  assert.ok(fromDeclaration?.changes?.[tableHostUri]?.some((edit) => edit.newText === 'ui-grid'));
  assert.ok(Object.keys(fromDeclaration?.changes ?? {}).some((uri) => uri.endsWith('.html')));
});

void test('uses quick fix preserves a valid trailing-comma array', async () => {
  const service = new SrlLanguageService();
  await service.reload();
  const templateSource = '<ui-dialog></ui-dialog>';
  const originalHost = await readFile(host, 'utf8');
  const hostSource = originalHost.replace('UiDynamicFilter, UiAvatar],', 'UiDynamicFilter, UiAvatar,],');
  assert.notEqual(hostSource, originalHost);
  service.open(hostUri, 'javascript', 1, hostSource);
  service.open(templateUri, 'html', 1, templateSource);

  const diagnostics = await service.diagnostics(templateUri);
  const diagnostic = diagnostics.find((candidate) => candidate.code === 'templates/missing-use');
  assert.ok(diagnostic);
  const actions = await service.codeActions(templateUri, diagnostic.range, [diagnostic]);
  assert.equal(actions.length, 1);
  const edits = actions[0]?.edit.changes?.[hostUri] ?? [];
  const edited = applyEdits(hostSource, edits);
  assert.match(edited, /import \{ UiDialog \}/u);

  const tree = ts.createSourceFile(host, edited, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {ts.ArrayLiteralExpression | undefined} */
  let uses;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'uses') ||
        (ts.isStringLiteralLike(node.name) && node.name.text === 'uses')) &&
      ts.isArrayLiteralExpression(node.initializer)
    ) uses = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(uses);
  assert.ok(uses.elements.some((element) => ts.isIdentifier(element) && element.text === 'UiDialog'));
  assert.ok(!uses.elements.some((element) => ts.isOmittedExpression(element)));
  assert.equal(uses.elements.hasTrailingComma, true);
});

/** @param {string} source @param {Array<{ range: { start: { line: number, character: number }, end: { line: number, character: number } }, newText: string }>} edits */
function applyEdits(source, edits) {
  return [...edits]
    .map((edit) => ({
      start: offsetAt(source, edit.range.start),
      end: offsetAt(source, edit.range.end),
      text: edit.newText,
    }))
    .sort((left, right) => right.start - left.start)
    .reduce(
      (value, edit) => `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`,
      source,
    );
}

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length - 1;
  const newline = before.lastIndexOf('\n');
  return { line, character: before.length - newline - 1 };
}

/** @param {string} source @param {{ line: number, character: number }} position */
function offsetAt(source, position) {
  let line = 0;
  let offset = 0;
  while (line < position.line) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(source.length, offset + position.character);
}
