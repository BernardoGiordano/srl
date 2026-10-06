import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `srl mcp` as an agent meets it: one process on stdio, one JSON-RPC message per line.
 * ADR-0127.
 */

const BIN = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'srl.mjs');

/**
 * Send messages in order and collect one answer per request.
 *
 * @param {object[]} messages
 * @returns {Promise<Map<unknown, Record<string, any>>>}
 */
async function exchange(messages) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();

  /** @type {Map<unknown, Record<string, any>>} */
  const answers = new Map();
  for await (const line of lines) {
    const reply = JSON.parse(line);
    answers.set(reply.id, reply);
  }
  return answers;
}

void test('the server negotiates, lists its tools and answers each call as structured content', async () => {
  const call = (/** @type {number} */ id, /** @type {string} */ name, /** @type {object} */ args) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const answers = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'suite', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, 'element', { tag: 'ui-table', app: 'example' }),
    call(4, 'check', { subjects: ['project'], app: 'example' }),
    call(5, 'docs', {}),
    call(6, 'docs', { path: '../package.json' }),
    call(7, 'nothing', {}),
    { jsonrpc: '2.0', id: 8, method: 'resources/list' },
  ]);

  // A notification gets no answer, and every request gets exactly one.
  assert.deepEqual([...answers.keys()].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);

  const init = answers.get(1)?.result;
  assert.equal(init.protocolVersion, '2025-03-26', 'a supported version is answered with itself');
  assert.deepEqual(init.capabilities, { tools: {} });
  assert.equal(init.serverInfo.name, 'srl');

  assert.deepEqual(
    answers.get(2)?.result.tools.map((/** @type {{ name: string }} */ tool) => tool.name),
    ['check', 'codes', 'elements', 'element', 'docs'],
  );

  const element = answers.get(3)?.result;
  assert.equal(element.isError, false);
  assert.equal(element.structuredContent.schemaVersion, 1);
  assert.equal(element.structuredContent.element.tag, 'ui-table');
  assert.ok(element.structuredContent.element.events.length > 0);
  assert.deepEqual(JSON.parse(element.content[0].text), element.structuredContent);

  const check = answers.get(4)?.result.structuredContent;
  assert.equal(check.ok, true);
  assert.ok(check.diagnostics.every((/** @type {{ code: string }} */ finding) => finding.code.startsWith('project/')));

  assert.match(answers.get(5)?.result.structuredContent.text, /# |Template dialect|template-dialect/u);

  // A path outside docs/ is a tool error, not a file.
  assert.equal(answers.get(6)?.result.isError, true);
  assert.equal(answers.get(7)?.error.code, -32602);
  assert.equal(answers.get(8)?.error.code, -32601);
});
