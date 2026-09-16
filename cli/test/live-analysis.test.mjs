/**
 * What the editor ends up seeing.
 *
 * These drive the scheduler rather than the checker. The failure they exist for is a
 * correct diagnostic that is never published, or published about text the buffer no
 * longer holds. Every assertion is about the queue's outcome, so each test drains it
 * instead of sleeping for longer than the debounce and hoping.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { checkTemplateSource, invalidateCompiler } from '../checks/template-check.mjs';
import { LiveAnalysis } from '../language-server/analysis.mjs';
import { SrlLanguageService } from '../language-server/service.mjs';
import { startLanguageServer } from './support/language-server-client.mjs';

const employees = resolve('example/src/pages/people/employees-page.html');
const employeesHost = resolve('example/src/pages/people/employees-page.js');
const teams = resolve('example/src/pages/people/teams-page.html');
const filter = resolve('source/components/data/ui-dynamic-filter.js');
const server = resolve('example/server/api.mjs');

void test('live analysis publishes every stale document', async (context) => {
  const service = new SrlLanguageService();
  /** @type {Map<string, any[]>} */
  const published = new Map();
  /** @type {string[]} */
  const reports = [];
  const analysis = new LiveAnalysis({
    service,
    publish: (uri, diagnostics) => published.set(uri, diagnostics),
    report: (text) => reports.push(text),
  });
  await analysis.start();
  context.after(() => analysis.dispose());

  const employeesSource = await readFile(employees, 'utf8');
  const teamsSource = await readFile(teams, 'utf8');
  const hostSource = await readFile(employeesHost, 'utf8');

  await context.test('two files opened inside one debounce window both get answers', async () => {
    published.clear();
    analysis.open(uri(employees), 'html', 1, `${employeesSource}\n<p>{{ rows.lenght }}</p>`);
    analysis.open(uri(teams), 'html', 1, `${teamsSource}\n<p>{{ rows.lenght }}</p>`);
    await analysis.settle();

    assert.ok(published.has(uri(employees)), 'the first opened file was never validated');
    assert.ok(published.has(uri(teams)), 'the second opened file was never validated');
    for (const [where, diagnostics] of published) {
      assert.ok(
        diagnostics.some((diagnostic) => /^templates\/ts/u.test(String(diagnostic.code))),
        `${where} reported no type diagnostic for a member that is not there`,
      );
    }
  });

  await context.test('an unsaved host edit republishes its template', async () => {
    analysis.change(uri(employees), 2, employeesSource);
    await analysis.settle();
    assert.deepEqual(published.get(uri(employees)), [], 'the valid template still has findings');

    published.clear();
    analysis.open(uri(employeesHost), 'javascript', 1, hostSource.replace('  rows = ', '  rowsRenamed = '));
    await analysis.settle();

    const diagnostics = published.get(uri(employees));
    assert.ok(diagnostics !== undefined, 'the template was not rechecked after its host changed');
    assert.ok(diagnostics.length > 0, 'a template bound to a renamed host member reported nothing');
  });

  await context.test('closing the host buffer restores the template on disk', async () => {
    published.clear();
    analysis.close(uri(employeesHost));
    await analysis.settle();

    assert.deepEqual(published.get(uri(employeesHost)), [], 'a closed document kept its findings');
    assert.deepEqual(
      published.get(uri(employees)),
      [],
      'the template still reports the closed buffer’s edit',
    );
  });

  await context.test('a superseded check does not publish the text it was about', async () => {
    published.clear();
    analysis.change(uri(employees), 3, `${employeesSource}\n<p>{{ rows.lenght }}</p>`);
    analysis.change(uri(employees), 4, employeesSource);
    await analysis.settle();
    assert.deepEqual(published.get(uri(employees)), [], 'a stale answer reached the editor');
  });

  await context.test('reports nothing but diagnostics', () => {
    assert.deepEqual(reports, []);
  });
});

void test('a change is stale for the documents whose shim reads it', async () => {
  const service = new SrlLanguageService();
  await service.reload();
  service.open(uri(employees), 'html', 1, await readFile(employees, 'utf8'));
  service.open(uri(teams), 'html', 1, await readFile(teams, 'utf8'));

  assert.deepEqual(
    service.dependents(employeesHost).sort(),
    [uri(employees)].sort(),
    'a host edit should reach its own template and no other',
  );
  assert.ok(
    service.dependents(filter).includes(uri(employees)),
    'a template naming <ui-dynamic-filter> depends on the module that declares it',
  );
  assert.deepEqual(
    service.dependents(server),
    [],
    'a module no open template names is not a reason to recheck anything',
  );
});

void test('a discarded compiler is rebuilt with the same answers', () => {
  const source = '<p>{{ missing }}</p>';
  const input = {
    module: employeesHost,
    className: 'EmployeesPage',
    template: employees,
    source,
  };
  const before = checkTemplateSource(input);
  invalidateCompiler();
  const after = checkTemplateSource(input);
  assert.ok(before.length > 0, 'the fixture template should not typecheck');
  assert.deepEqual(
    after.map((diagnostic) => diagnostic.code),
    before.map((diagnostic) => diagnostic.code),
    'the rebuilt compiler disagreed with the one it replaced',
  );
});

void test('the stdio server answers a request before the validation it queued', async () => {
  const client = startLanguageServer({ root: process.cwd() });
  try {
    const employeesSource = await readFile(employees, 'utf8');
    const teamsSource = await readFile(teams, 'utf8');

    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(process.cwd()).href,
      capabilities: {},
    });
    client.notify('initialized', {});

    // Both in one write, so the second open cannot be waiting on the first one's answer.
    client.write([
      client.frame({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: uri(employees),
            languageId: 'html',
            version: 1,
            text: `${employeesSource}\n<p>{{ rows.lenght }}</p>`,
          },
        },
      }),
      client.frame({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: uri(teams),
            languageId: 'html',
            version: 1,
            text: `${teamsSource}\n<p>{{ rows.lenght }}</p>`,
          },
        },
      }),
    ]);

    // Ordering rather than a duration. The completion is asked for after two
    // documents were queued for validation and has to come back before their
    // diagnostics do. What that
    // costs in milliseconds is the editor workload's question, measured against a fixture
    // over a hundred samples rather than asserted once here. ADR-0096.
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri: uri(employees) },
      position: { line: 0, character: 0 },
    });
    assert.ok(Array.isArray(completion.result), 'completion did not answer');
    assert.deepEqual(client.publishes, [], 'the completion waited for validation to finish');

    const first = await client.diagnostics(uri(employees));
    const second = await client.diagnostics(uri(teams));
    assert.ok(
      first.some((diagnostic) => /^templates\/ts/u.test(String(diagnostic.code))),
      'the first opened file was never diagnosed',
    );
    assert.ok(
      second.some((diagnostic) => /^templates\/ts/u.test(String(diagnostic.code))),
      'the second opened file was never diagnosed',
    );

    // Request and withdrawal in one write, so the cancellation is registered before the
    // handler resolves rather than whenever the pipe happens to flush.
    const id = client.nextId();
    const withdrawn = client.expect(id);
    client.write([
      client.frame({
        jsonrpc: '2.0',
        id,
        method: 'textDocument/hover',
        params: { textDocument: { uri: uri(employees) }, position: { line: 0, character: 0 } },
      }),
      client.frame({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }),
    ]);
    assert.equal((await withdrawn).error?.code, -32800, 'a withdrawn request was answered anyway');

    await client.request('shutdown');
    assert.equal(await client.exit(), 0, client.stderr());
  } finally {
    client.kill();
  }
});

/** @param {string} path */
function uri(path) {
  return pathToFileURL(path).href;
}

/**
 * What isolated execution is for.
 *
 * These use a lane that is slow on purpose (`fixtures/slow-lane.mjs`) rather than a large
 * fixture: the property under test is what the protocol thread can do while a check runs,
 * and a fast real check would race every assertion. ADR-0090.
 */
const SLOW_LANE = new URL('./fixtures/slow-lane.mjs', import.meta.url);

void test('a check does not occupy the thread that answers requests', async (context) => {
  process.env.SRL_LANE_DELAY = '400';
  const { analysis, published } = await slow(context);
  analysis.open(uri(employees), 'html', 1, await readFile(employees, 'utf8'));

  let ticks = 0;
  const clock = setInterval(() => {
    ticks += 1;
  }, 10);
  const started = Date.now();
  await analysis.settle();
  clearInterval(clock);

  const waited = Date.now() - started;
  assert.ok(waited >= 350, `the check took ${String(waited)} ms, so it was not the slow one`);
  assert.ok(ticks >= 20, `only ${String(ticks)} timers ran on this thread during a check`);
  assert.equal(published.length, 1, 'the document was not diagnosed once');
});

void test('an edit abandons the check it replaced', async (context) => {
  process.env.SRL_LANE_DELAY = '400';
  const { analysis, published } = await slow(context);
  const source = await readFile(employees, 'utf8');
  analysis.open(uri(employees), 'html', 1, source);
  await inFlight();
  analysis.change(uri(employees), 2, `${source}\n<p>replaced</p>`);
  await analysis.settle();

  assert.equal(published.length, 1, 'the superseded answer reached the editor');
  assert.match(
    String(published[0]?.diagnostics[0]?.message),
    /check 2$/u,
    'the published answer was the one the edit replaced',
  );
});

void test('closing a document abandons its running check', async (context) => {
  process.env.SRL_LANE_DELAY = '400';
  const { analysis, published } = await slow(context);
  analysis.open(uri(employees), 'html', 1, await readFile(employees, 'utf8'));
  await inFlight();
  analysis.close(uri(employees));
  await analysis.settle();

  assert.deepEqual(
    published.map((entry) => entry.diagnostics),
    [[]],
    'a closed document was answered by the check it left behind',
  );
});

void test('a configuration change replaces the validation thread', async (context) => {
  process.env.SRL_LANE_DELAY = '0';
  const { analysis, published } = await slow(context);
  analysis.open(uri(employees), 'html', 1, await readFile(employees, 'utf8'));
  await analysis.settle();
  const first = thread(published);
  assert.ok(first !== undefined, 'nothing was diagnosed');

  published.length = 0;
  analysis.watched([{ uri: uri(employeesHost) }]);
  await analysis.settle();
  assert.equal(thread(published), first, 'a source edit paid for a new compiler thread');

  published.length = 0;
  analysis.watched([{ uri: uri(resolve('tsconfig.json')) }]);
  await analysis.settle();
  assert.notEqual(
    thread(published),
    first,
    'a configuration edit kept the thread built from the tsconfig.json it replaced',
  );
});

void test('disposal ends the validation thread', async () => {
  process.env.SRL_LANE_DELAY = '5000';
  const service = new SrlLanguageService();
  /** @type {Array<{ uri: string, diagnostics: Array<{ message: string }> }>} */
  const published = [];
  const analysis = new LiveAnalysis({
    service,
    publish: (where, diagnostics) =>
      published.push({
        uri: where,
        diagnostics: /** @type {Array<{ message: string }>} */ (diagnostics),
      }),
    lane: SLOW_LANE,
  });
  await analysis.start();
  analysis.open(uri(employees), 'html', 1, await readFile(employees, 'utf8'));
  await inFlight();

  const started = Date.now();
  await analysis.dispose();
  const waited = Date.now() - started;
  assert.ok(waited < 1500, `disposal waited ${String(waited)} ms for a check to finish`);

  published.length = 0;
  await pause(150);
  assert.deepEqual(published, [], 'a disposed analysis published on the way out');
});

/**
 * A live analysis whose checks run in the slow lane.
 *
 * @param {import('node:test').TestContext} context
 */
async function slow(context) {
  const service = new SrlLanguageService();
  /** @type {Array<{ uri: string, diagnostics: Array<{ message: string }> }>} */
  const published = [];
  const analysis = new LiveAnalysis({
    service,
    publish: (where, diagnostics) =>
      published.push({
        uri: where,
        diagnostics: /** @type {Array<{ message: string }>} */ (diagnostics),
      }),
    report: (text) => assert.fail(text),
    lane: SLOW_LANE,
  });
  context.after(() => analysis.dispose());
  await analysis.start();
  published.length = 0;
  return { analysis, published, service };
}

/** Long enough for the debounce to elapse and the lane to be inside a check. */
function inFlight() {
  return pause(260);
}

/** @param {number} ms */
function pause(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/** @param {Array<{ diagnostics: Array<{ message: string }> }>} published @returns {string | undefined} The thread the last answer came from. */
function thread(published) {
  return /^lane (\d+)/u.exec(String(published.at(-1)?.diagnostics[0]?.message))?.[1];
}
