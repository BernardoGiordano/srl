import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { SrlLanguageService } from '../language-server/service.mjs';
import { startLanguageServer } from './support/language-server-client.mjs';

const template = resolve('example/src/pages/people/employees-page.html');
const uri = pathToFileURL(template).href;
const litHost = resolve('source/components/data/ui-dynamic-filter.js');
const litHostUri = pathToFileURL(litHost).href;

void test('language service exposes the srl template contract', async (context) => {
  const service = new SrlLanguageService();
  await service.reload();
  const original = await readFile(template, 'utf8');

  await context.test('publishes typed diagnostics from unsaved markup', async () => {
    const source = `${original}\n<p>{{ rows.lenght }}</p>`;
    service.open(uri, 'html', 1, source);
    const diagnostics = await service.diagnostics(uri);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'templates/ts2551'));
  });

  await context.test('completes elements, attributes, and host members', async () => {
    let source = '<ui';
    service.change(uri, 2, source);
    const tags = await service.completion(uri, { line: 0, character: source.length });
    assert.ok(tags.some((item) => item.filterText === 'ui-table'));

    source = '<ui-table ';
    service.change(uri, 3, source);
    const attributes = await service.completion(uri, { line: 0, character: source.length });
    assert.ok(attributes.some((item) => item.label === '[.rows]'));
    assert.ok(attributes.some((item) => item.label === '*for'));

    source = '{{ ro';
    service.change(uri, 4, source);
    const members = await service.completion(uri, { line: 0, character: source.length });
    assert.ok(members.some((item) => item.label === 'rows'));
    assert.ok(members.some((item) => item.label === 'rowKey'));
  });

  await context.test('navigates, finds references, and renames custom tags', async () => {
    service.change(uri, 5, original);
    const at = original.indexOf('ui-table') + 2;
    const position = positionAt(original, at);
    const definitions = await service.definition(uri, position);
    assert.match(definitions[0]?.uri ?? '', /ui-table\.js$/u);
    const references = await service.references(uri, position, true);
    assert.ok(references.length > 2);
    const renamed = await service.rename(uri, position, 'ui-grid');
    assert.ok(Object.values(renamed?.changes ?? {}).flat().length > 2);
  });

  await context.test('renames tag uses written in handwritten Lit templates', async () => {
    const litSource = [
      "import { html } from 'lit';",
      "import { UiDateRange } from '../inputs/ui-date-range.js';",
      '// <ui-date-range> named in a comment',
      "const label = '<ui-date-range>';",
      'const view = html`<ui-date-range .range=${range}></ui-date-range>`;',
      '',
    ].join('\n');
    service.open(litHostUri, 'javascript', 1, litSource);
    const markup = litSource.indexOf('html`<ui-date-range') + 'html`<'.length;
    const position = positionAt(litSource, markup + 1);

    const references = await service.references(litHostUri, position, false);
    assert.deepEqual(
      references.filter((reference) => reference.uri === litHostUri).map((reference) => reference.range.start.line),
      [4, 4],
    );

    const renamed = await service.rename(litHostUri, position, 'ui-date-window');
    const edits = renamed?.changes[litHostUri] ?? [];
    assert.equal(edits.length, 2, 'a comment, a string or an import specifier was edited');
    assert.ok(Object.keys(renamed?.changes ?? {}).some((file) => /ui-date-range\.js$/u.test(file)));
    service.close(litHostUri);
  });

  await context.test('reads handwritten Lit templates in Lit grammar', async () => {
    const litSource = [
      "import { html } from 'lit';",
      'const view = html`<ui-table *for="row of rows" (click)=${pick}></ui-table>`;',
      '',
    ].join('\n');
    service.open(litHostUri, 'javascript', 2, litSource);

    const tags = await service.completion(litHostUri, positionAt(litSource, litSource.indexOf('<ui-table') + 3));
    assert.ok(tags.some((item) => item.filterText === 'ui-table'));

    // `*for` and `(click)` are plain attribute names here. Lit has neither directive,
    // so the offer is Lit's own binding syntax over the same element surface.
    const bindings = await service.completion(litHostUri, positionAt(litSource, litSource.indexOf('*for') + 1));
    assert.ok(bindings.some((item) => item.label === '.rows'));
    assert.ok(bindings.some((item) => item.label === '@click'));
    assert.equal(
      bindings.some((item) => ['*for', '*if', '[.rows]', '(click)'].includes(String(item.label))),
      false,
    );

    // A module's outline is its declarations, which the JavaScript service already owns.
    assert.deepEqual(await service.documentSymbols(litHostUri), []);

    // Tag identity is the one thing both authored forms share, so navigation still answers.
    const onTag = positionAt(litSource, litSource.indexOf('ui-table') + 2);
    assert.match((await service.definition(litHostUri, onTag))[0]?.uri ?? '', /ui-table\.js$/u);
    assert.match((await service.hover(litHostUri, onTag))?.contents.value ?? '', /UiTable/u);
    service.close(litHostUri);
  });

  await context.test('describes Lit bindings and leaves substitutions to TypeScript', async () => {
    const litSource = [
      "import { html } from 'lit';",
      'const view = html`<ui-date-range .range=${current} @range-confirm=${apply}></ui-date-range>`;',
      '',
    ].join('\n');
    service.open(litHostUri, 'javascript', 3, litSource);

    const onProperty = positionAt(litSource, litSource.indexOf('.range=') + 2);
    assert.match((await service.hover(litHostUri, onProperty))?.contents.value ?? '', /UiDateRange\.range/u);
    assert.match((await service.definition(litHostUri, onProperty))[0]?.uri ?? '', /ui-date-range\.js$/u);

    const onEvent = positionAt(litSource, litSource.indexOf('@range-confirm') + 2);
    assert.match((await service.hover(litHostUri, onEvent))?.contents.value ?? '', /UiDateRange` event/u);

    // A substitution is the module's own JavaScript. A second completion list over the
    // one TypeScript already gives there would be worse than none.
    assert.deepEqual(
      await service.completion(litHostUri, positionAt(litSource, litSource.indexOf('${current}') + 2)),
      [],
    );

    const coloured = decodeTokens(litSource, (await service.semanticTokens(litHostUri)).data);
    assert.deepEqual(
      coloured.map((token) => token.text),
      ['ui-date-range', '.range', '@range-confirm', 'ui-date-range'],
    );
    service.close(litHostUri);
  });

  await context.test('offers the uses quick fix for a tag written in inline Lit markup', async () => {
    const litSource = [
      "import { html } from 'lit';",
      "import { UiCombobox } from '../inputs/ui-combobox.js';",
      'class UiDynamicFilter {}',
      'const view = html`<ui-table></ui-table>`;',
      'await defineComponent({',
      "  tag: 'ui-dynamic-filter',",
      '  element: UiDynamicFilter,',
      '  module: import.meta.url,',
      '  uses: [UiCombobox],',
      '});',
      '',
    ].join('\n');
    service.open(litHostUri, 'javascript', 4, litSource);

    const diagnostics = await service.diagnostics(litHostUri);
    const diagnostic = diagnostics.find((candidate) => /Add `UiTable` to its `uses`/u.test(candidate.message));
    assert.ok(diagnostic, 'markup built in JavaScript depends on `uses` exactly as a template file does');

    const actions = await service.codeActions(litHostUri, diagnostic.range, [diagnostic]);
    const edits = actions[0]?.edit.changes[litHostUri] ?? [];
    assert.ok(edits.some((edit) => edit.newText.includes('import { UiTable }')));
    assert.ok(edits.some((edit) => edit.newText.includes('UiCombobox, UiTable')));
    service.close(litHostUri);
  });

  await context.test('claims no uses entry from a bare customElements.define', async () => {
    // `uses` is a `defineComponent` list. This module registers its elements directly and
    // its imports are what make the tags it names exist, so nothing here is missing.
    const defined = resolve('source/lib/test/navigation/router.test.js');
    const definedUri = pathToFileURL(defined).href;
    const definedSource = await readFile(defined, 'utf8');
    assert.match(definedSource, /html`[^`]*<x-route-outlet>/u, 'the fixture no longer writes inline markup');

    service.open(definedUri, 'javascript', 1, definedSource);
    const diagnostics = await service.diagnostics(definedUri);
    assert.deepEqual(diagnostics.filter((candidate) => candidate.code === 'templates/dialect'), []);
    service.close(definedUri);
  });

  await context.test('follows Lit tag uses through aliases, svg and nesting', async () => {
    const litSource = [
      "import { html as h, svg } from 'lit';",
      'const badge = svg`<ui-date-range></ui-date-range>`;',
      'const row = h`<div>${h`<ui-date-range></ui-date-range>`}</div>`;',
      '',
    ].join('\n');
    service.open(litHostUri, 'javascript', 5, litSource);
    const position = positionAt(litSource, litSource.indexOf('<ui-date-range') + 2);
    const references = await service.references(litHostUri, position, false);
    assert.deepEqual(
      references.filter((reference) => reference.uri === litHostUri).map((reference) => reference.range.start.line),
      [1, 1, 2, 2],
    );
    service.close(litHostUri);
  });

  await context.test('offers a uses/import quick fix', async () => {
    const source = `${original}\n<ui-dialog></ui-dialog>`;
    service.change(uri, 6, source);
    const diagnostics = await service.diagnostics(uri);
    const diagnostic = diagnostics.find((candidate) => /Add `UiDialog` to its `uses`/u.test(candidate.message));
    assert.ok(diagnostic);
    const actions = await service.codeActions(uri, diagnostic.range, [diagnostic]);
    assert.equal(actions.length, 1);
    const edits = Object.values(actions[0]?.edit.changes ?? {}).flat();
    assert.ok(edits.some((edit) => edit.newText.includes('import { UiDialog }')));
    assert.ok(edits.some((edit) => edit.newText.includes('UiDialog')));
  });

  await context.test('reports a message key no bundle declares, from the buffer', async () => {
    const source = original.replace("t('people.empty')", "t('people.emtpy')");
    assert.notEqual(source, original, 'the fixture template names that key');
    service.change(uri, 7, source);

    const diagnostics = await service.diagnostics(uri);
    const unknown = diagnostics.find((candidate) => candidate.code === 'messages/unknown-key');
    assert.ok(unknown?.message.includes('people.emtpy'));
    assert.ok(unknown?.message.includes('Did you mean "people.empty"?'));

    const line = source.split('\n')[unknown?.range.start.line ?? 0] ?? '';
    assert.equal(
      line.slice(unknown?.range.start.character ?? 0).startsWith('people.emtpy'),
      true,
      'placed at the literal, not at the call',
    );
  });

  await context.test('returns semantic tokens, document links, outline, and workspace symbols', async () => {
    service.change(uri, 8, original);
    assert.ok((await service.semanticTokens(uri)).data.length > 0);
    assert.ok((await service.documentLinks(uri)).length > 0);
    assert.ok((await service.documentSymbols(uri)).length > 0);
    assert.ok((await service.workspaceSymbols('ui-table')).length > 0);
  });
});

void test('stdio server speaks framed JSON-RPC', async (context) => {
  await context.test('answers initialize and shuts down', async () => {
    const server = startLanguageServer();
    const initialize = await server.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(process.cwd()).href,
      capabilities: {},
    });
    assert.equal(initialize.result.serverInfo.name, 'srl');
    assert.equal((await server.request('shutdown')).result, null);
    assert.equal(await server.exit(), 0);
    assert.equal(server.stderr().includes('Error'), false, server.stderr());
  });

  await context.test('answers an unknown request with Method not found', async () => {
    const server = startLanguageServer();
    await server.request('initialize', { processId: process.pid, capabilities: {} });
    const response = await server.request('textDocument/inlayHint', {});
    assert.equal(response.result, undefined);
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /textDocument\/inlayHint/u);
    // A notification for the same unknown method is ignored rather than answered.
    server.notify('$/unknownNotification', {});
    assert.equal((await server.request('shutdown')).result, null);
    assert.equal(await server.exit(), 0);
    assert.equal(server.stderr().includes('Error'), false, server.stderr());
  });

  await context.test('watches its own project, once, and only where the client can', async () => {
    const capable = startLanguageServer({
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
      },
    });
    await capable.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(process.cwd()).href,
      capabilities: capable.capabilities,
    });
    capable.notify('initialized', {});
    const registration = await capable.serverRequest('client/registerCapability');
    const [registered] = registration.params.registrations;
    assert.equal(registered.method, 'workspace/didChangeWatchedFiles');
    const base = pathToFileURL(process.cwd()).href;
    /** @type {unknown[]} */
    const globs = registered.registerOptions.watchers.map(
      (/** @type {{ globPattern: unknown }} */ watcher) => watcher.globPattern,
    );
    assert.deepEqual(globs, [
      { baseUri: base, pattern: '**/*.html' },
      { baseUri: base, pattern: '**/*.js' },
      { baseUri: base, pattern: '**/*.mjs' },
      { baseUri: base, pattern: '**/{package,tsconfig}.json' },
    ]);
    assert.equal((await capable.request('shutdown')).result, null);
    assert.equal(await capable.exit(), 0);
    assert.equal(capable.stderr().includes('Error'), false, capable.stderr());

    const plain = startLanguageServer();
    await plain.request('initialize', { processId: process.pid, capabilities: {} });
    plain.notify('initialized', {});
    assert.equal((await plain.request('shutdown')).result, null);
    assert.equal(plain.serverRequests.length, 0, 'registered watchers the client cannot take');
    assert.equal(await plain.exit(), 0);
  });
});

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length - 1;
  const newline = before.lastIndexOf('\n');
  return { line, character: before.length - newline - 1 };
}

/**
 * Semantic tokens as the text they cover, so a test reads what was coloured rather than
 * the relative line and character deltas the protocol sends.
 *
 * @param {string} source @param {number[]} data
 */
function decodeTokens(source, data) {
  const lines = source.split('\n');
  const tokens = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    const [deltaLine = 0, deltaCharacter = 0, length = 0, type = 0] = data.slice(index, index + 5);
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;
    tokens.push({ text: (lines[line] ?? '').slice(character, character + length), type });
  }
  return tokens;
}
