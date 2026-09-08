import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { SrlLanguageService } from '../language-server/service.mjs';

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

  await context.test('returns semantic tokens, document links, outline, and workspace symbols', async () => {
    service.change(uri, 7, original);
    assert.ok((await service.semanticTokens(uri)).data.length > 0);
    assert.ok((await service.documentLinks(uri)).length > 0);
    assert.ok((await service.documentSymbols(uri)).length > 0);
    assert.ok((await service.workspaceSymbols('ui-table')).length > 0);
  });
});

void test('stdio server speaks framed JSON-RPC', async () => {
  const server = resolve('cli/language-server/server.mjs');
  const child = spawn(process.execPath, [server], {
    cwd: process.cwd(),
    env: { ...process.env, SRL_ROOT: process.cwd() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  let stderr = '';
  /** @type {Map<string | number, (message: any) => void>} */
  const waiting = new Map();
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const separator = buffer.indexOf('\r\n\r\n');
      if (separator === -1) break;
      const header = buffer.subarray(0, separator).toString('ascii');
      const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
      const end = separator + 4 + length;
      if (buffer.length < end) break;
      const message = JSON.parse(buffer.subarray(separator + 4, end).toString('utf8'));
      buffer = buffer.subarray(end);
      const resolveMessage = waiting.get(message.id);
      if (resolveMessage !== undefined) {
        waiting.delete(message.id);
        resolveMessage(message);
      }
    }
  });

  const response = request(1, 'initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(process.cwd()).href,
    capabilities: {},
  });
  assert.equal((await response).result.serverInfo.name, 'srl');
  assert.equal((await request(2, 'shutdown', null)).result, null);
  send({ jsonrpc: '2.0', method: 'exit' });
  const [code] = await new Promise((resolveExit) => child.once('exit', (...args) => resolveExit(args)));
  assert.equal(code, 0, stderr);

  /** @param {string | number} id @param {string} method @param {unknown} params */
  function request(id, method, params) {
    const response = new Promise((resolveMessage, reject) => {
      waiting.set(id, resolveMessage);
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for ${method}. ${stderr}`)),
        10_000,
      );
      timeout.unref();
    });
    send({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  /** @param {unknown} message */
  function send(message) {
    const body = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${String(body.length)}\r\n\r\n`);
    child.stdin.write(body);
  }
});

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length - 1;
  const newline = before.lastIndexOf('\n');
  return { line, character: before.length - newline - 1 };
}
