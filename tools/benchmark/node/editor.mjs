/**
 * Editor workloads, measuring what the language server costs the editor waiting on
 * it.
 *
 * One module owns the fixture repositories, the cold and warm session states, the sample
 * loops and the correctness a sample has to satisfy before its timing counts. Callers get
 * workload records like any other suite.
 *
 * As one assertion in cli/test/live-analysis.test.mjs the claim would be a single
 * completion under 1000 ms. The suites keep the ordering facts, and the timings are
 * here with a sample policy behind them. ADR-0096.
 *
 * Fixtures are copies of the selected application in a temporary root, one for 1x and
 * ten for 10x, because the srl checkout is a project no consumer has.
 */

import { cp, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startLanguageServer } from '../../../cli/test/support/language-server-client.mjs';

/** @import { BenchmarkSample, NodeWorkloadContext, WorkloadSpec } from '../types.js' */

/** The server's own debounce, from cli/language-server/analysis.mjs. */
const DEBOUNCE = 120;

/** Edits in one burst, written together so they land inside one debounce window. */
const BURST = 10;

/** Published answers to wait for before an interactive sample counts: the compiler is warm. */
const WARM_CHECKS = 3;

/** Documents left stale per interaction block, so a request always arrives to a busy checker. */
const BACKLOG = 5;

/** Built fixtures, by scale. A run pays for each one once. @type {Map<number, Promise<EditorFixture>>} */
const FIXTURES = new Map();

/** @type {string[]} */
const TEMPORARY = [];

process.on('exit', () => {
  for (const root of TEMPORARY) rmSync(root, { recursive: true, force: true });
});

/**
 * @typedef {{
 *   root: string,
 *   documents: Array<{ uri: string, source: string }>,
 *   primary: { uri: string, source: string },
 *   tag: string,
 * }} EditorFixture
 */

/**
 * A repository holding `scale` copies of the selected application. Built once per run.
 *
 * `node_modules` is a symlink, so `@srljs/core` is this checkout's source. The tsconfig
 * extends source/tsconfig.source.json by path, so the prefixes resolve into that source
 * rather than into a declaration tree that exists only after `npm run package`.
 *
 * @param {NodeWorkloadContext} context
 * @param {number} scale
 * @returns {Promise<EditorFixture>}
 */
function fixture(context, scale) {
  const existing = FIXTURES.get(scale);
  if (existing !== undefined) return existing;
  const building = build(context, scale);
  FIXTURES.set(scale, building);
  return building;
}

/**
 * @param {NodeWorkloadContext} context
 * @param {number} scale
 * @returns {Promise<EditorFixture>}
 */
async function build(context, scale) {
  const root = await mkdtemp(join(tmpdir(), 'srl-editor-'));
  TEMPORARY.push(root);
  await symlink(join(context.repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'srl-editor-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: join(context.repo, 'source', 'tsconfig.source.json'),
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['*/src/**/*.js'],
      },
      null,
      2,
    )}\n`,
  );

  for (let copy = 0; copy < scale; copy += 1) {
    const name = copy === 0 ? context.app.name : `${context.app.name}-${String(copy).padStart(2, '0')}`;
    await cp(context.app.dir, join(root, name), { recursive: true });
  }

  const templates = await hostedTemplates(join(root, context.app.name, 'src'));
  if (templates.length === 0) {
    throw new Error(`No template with a host module under ${context.app.name}/src.`);
  }

  /** @type {Array<{ uri: string, source: string }>} */
  const documents = [];
  for (const path of templates) {
    documents.push({ uri: pathToFileURL(path).href, source: await readFile(path, 'utf8') });
  }
  // The largest template is the one every interactive sample edits, with the most
  // bindings and the most
  // work for the checker, and the answer a completion has to be built against.
  const primary = [...documents].sort((first, second) => second.source.length - first.source.length)[0];
  if (primary === undefined) throw new Error('No primary template.');
  const tag = /<([a-z][a-z\d]*-[a-z\d-]+)/u.exec(primary.source)?.[1];
  if (tag === undefined) {
    throw new Error(`No custom element is used in ${primary.uri}, so it cannot drive completion.`);
  }

  return { root, documents, primary, tag };
}

/**
 * Every `.html` beside a `.js` of the same name: a template with a host module, which is
 * the pair the language server has answers for.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function hostedTemplates(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  /** @type {string[]} */
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const path = join(entry.parentPath, entry.name);
    const host = join(dirname(path), `${basename(path, '.html')}.js`);
    if (entries.some((candidate) => join(candidate.parentPath, candidate.name) === host)) {
      found.push(path);
    }
  }
  return found.sort();
}

/**
 * The four requests an editor makes while somebody types, each with what its answer has
 * to contain for the timing to mean anything.
 *
 * @type {ReadonlyArray<{
 *   name: string,
 *   method: string,
 *   text: (fixture: EditorFixture, marker: string) => string,
 *   offset: (text: string, fixture: EditorFixture) => number,
 *   ok: (result: any) => boolean,
 * }>}
 */
const INTERACTIONS = [
  {
    name: 'tag completion',
    method: 'textDocument/completion',
    text: (fx, marker) => `${fx.primary.source}\n<!-- ${marker} -->\n<${fx.tag.slice(0, 3)}`,
    offset: (text) => text.length,
    ok: (result) => Array.isArray(result) && result.length > 0,
  },
  {
    name: 'attribute completion',
    method: 'textDocument/completion',
    text: (fx, marker) => `${fx.primary.source}\n<!-- ${marker} -->\n<${fx.tag} `,
    offset: (text) => text.length,
    ok: (result) => Array.isArray(result) && result.length > 0,
  },
  {
    name: 'host member completion',
    method: 'textDocument/completion',
    text: (fx, marker) => `${fx.primary.source}\n<!-- ${marker} -->\n<p>{{ `,
    offset: (text) => text.length,
    ok: (result) => Array.isArray(result) && result.length > 0,
  },
  {
    name: 'hover on a tag',
    method: 'textDocument/hover',
    text: (fx, marker) => `${fx.primary.source}\n<!-- ${marker} -->`,
    offset: (_text, fx) => fx.primary.source.indexOf(`<${fx.tag}`) + 2,
    ok: (result) => typeof result?.contents?.value === 'string' && result.contents.value.length > 0,
  },
];

/**
 * A session on a fixture, initialized and ready to be asked things.
 *
 * @param {EditorFixture} fx
 * @param {{ onPublish?: (publish: { uri: string, diagnostics: any[], at: number }) => void }} [options]
 */
async function session(fx, options = {}) {
  const client = startLanguageServer({ root: fx.root, timeout: 120_000, onPublish: options.onPublish });
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(fx.root).href,
    capabilities: {},
  });
  client.notify('initialized', {});
  return client;
}

/** @param {ReturnType<typeof startLanguageServer>} client @returns {Promise<number>} */
async function end(client) {
  try {
    await client.request('shutdown');
    return await client.exit();
  } catch {
    client.kill();
    return -1;
  }
}

/** @param {number} ms */
function pause(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * @param {() => boolean} condition
 * @param {string} what
 * @param {number} limit
 */
async function until(condition, what, limit) {
  const deadline = performance.now() + limit;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting until ${what}.`);
    await pause(10);
  }
}

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const newline = before.lastIndexOf('\n');
  return { line: before.split('\n').length - 1, character: before.length - newline - 1 };
}

/**
 * A cold session: a process that has never read this project, answering the first
 * completion and the first diagnostics an editor asks of it.
 *
 * `firstCompletion` is the interactive thread's own cold cost — the program build behind
 * `templateExpressionMembers()` — which ADR-0090 left as the next measurable thing.
 *
 * @param {NodeWorkloadContext} context
 * @param {number} scale
 * @returns {Promise<BenchmarkSample[]>}
 */
async function coldStart(context, scale) {
  const fx = await fixture(context, scale);
  // Host members, not tags: a tag list comes from the project model, while an expression
  // completion is what pays for the interactive thread's own program build.
  const trigger = /** @type {typeof INTERACTIONS[number]} */ (
    INTERACTIONS.find((candidate) => candidate.name === 'host member completion')
  );
  const text = trigger.text(fx, 'cold');
  const position = positionAt(text, trigger.offset(text, fx));
  /** @type {BenchmarkSample[]} */
  const samples = [];

  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const started = performance.now();
    const client = await session(fx);
    const initialized = performance.now();
    client.open(fx.primary.uri, 'html', 1, text);
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri: fx.primary.uri },
      position,
    });
    const completed = performance.now();
    const diagnostics = await client.diagnostics(fx.primary.uri);
    const answered = performance.now();
    const code = await end(client);

    const wrong =
      !trigger.ok(completion.result)
        ? `the first completion answered ${JSON.stringify(completion.result ?? completion.error).slice(0, 200)}`
        : !Array.isArray(diagnostics)
          ? `the first diagnostics were ${JSON.stringify(diagnostics)}`
          : code !== 0
            ? `the server exited ${String(code)}: ${client.stderr().slice(0, 300)}`
            : client.stderr().includes('Error')
              ? `the server reported ${client.stderr().slice(0, 300)}`
              : null;

    /** @type {BenchmarkSample} */
    const sample =
      wrong === null
        ? {
            ok: true,
            duration: answered - started,
            metrics: {
              initialize: initialized - started,
              firstCompletion: completed - initialized,
              firstDiagnostics: answered - completed,
            },
          }
        : { ok: false, detail: wrong };
    if (index >= context.warmup || !sample.ok) samples.push(sample);
    if (!sample.ok) break;
  }
  return samples;
}

/**
 * A warm session answering interactive requests with validation outstanding.
 *
 * One block per interaction: the document is edited into the shape that interaction asks
 * about, the debounce is waited out so validation is running rather than pending, then the
 * block's samples are taken back to back. A check costs tens of milliseconds and a request
 * single digits, so the backlog outlasts the block. A sample answered by a server with
 * nothing left to validate is refused: that is not the state an editor types into.
 *
 * @param {NodeWorkloadContext} context
 * @param {number} scale
 * @returns {Promise<BenchmarkSample[]>}
 */
async function interactive(context, scale) {
  const fx = await fixture(context, scale);
  /** Documents whose latest text has no published answer yet. @type {Set<string>} */
  const queued = new Set();
  const client = await session(fx, { onPublish: (publish) => queued.delete(publish.uri) });
  /** @type {BenchmarkSample[]} */
  const samples = [];

  try {
    for (const document of fx.documents) {
      client.open(document.uri, 'html', 1, document.source);
      queued.add(document.uri);
    }
    // The first check of a session builds the compiler's program, and an editor pays that
    // once. Sampling before it finished would report the cold cost of the first document
    // as the cost of a keystroke: that number is `editor/cold-start`'s to report.
    await until(() => client.publishes.length >= WARM_CHECKS, 'the checker is warm', 120_000);

    const perBlock = Math.ceil(context.samples / INTERACTIONS.length);
    const warmupPerBlock = Math.ceil(context.warmup / INTERACTIONS.length);
    let version = 1;
    let validated = 0;

    for (const [block, interaction] of INTERACTIONS.entries()) {
      const text = interaction.text(fx, String(block));
      version += 1;
      client.change(fx.primary.uri, version, text);
      queued.add(fx.primary.uri);
      // A handful of neighbours per block, so the queue outlives the block's samples
      // instead of draining flat halfway through it.
      for (let offset = 0; offset < BACKLOG; offset += 1) {
        const neighbour = /** @type {{ uri: string, source: string }} */ (
          fx.documents[(block * BACKLOG + offset) % fx.documents.length]
        );
        if (neighbour.uri === fx.primary.uri) continue;
        version += 1;
        client.change(neighbour.uri, version, `${neighbour.source}\n<!-- ${String(block)} -->`);
        queued.add(neighbour.uri);
      }
      // Past the debounce, so a check is running when the block's first request arrives.
      await pause(DEBOUNCE + 40);

      const position = positionAt(text, interaction.offset(text, fx));
      for (let index = 0; index < warmupPerBlock + perBlock; index += 1) {
        const started = performance.now();
        const response = await client.request(interaction.method, {
          textDocument: { uri: fx.primary.uri },
          position,
        });
        const duration = performance.now() - started;
        const busy = queued.size > 0;
        validated = client.publishes.length;

        /** @type {BenchmarkSample} */
        const sample =
          interaction.ok(response.result) && busy
            ? { ok: true, duration }
            : {
                ok: false,
                detail: busy
                  ? `${interaction.name} answered ${JSON.stringify(response.result ?? response.error).slice(0, 200)}`
                  : `${interaction.name} was answered by a server with nothing left to validate`,
              };
        if (index >= warmupPerBlock || !sample.ok) samples.push(sample);
        if (!sample.ok) return samples;
      }
    }

    if (validated === 0) {
      return [{ ok: false, detail: 'no document was validated while the requests were sampled' }];
    }
    // Blocks round up, so the last few of the last block are not needed.
    return samples.slice(0, context.samples);
  } finally {
    await end(client);
  }
}

/**
 * Ten edits written together, then the answer.
 *
 * `validations` is the structural half: one burst inside one debounce window is one check
 * on any machine, which is what makes it the editor fact an absolute budget can hold.
 * ADR-0096.
 *
 * @param {NodeWorkloadContext} context
 * @returns {Promise<BenchmarkSample[]>}
 */
async function editBurst(context) {
  const fx = await fixture(context, 1);
  const client = await session(fx);
  /** @type {BenchmarkSample[]} */
  const samples = [];

  try {
    client.open(fx.primary.uri, 'html', 1, fx.primary.source);
    await client.diagnostics(fx.primary.uri);

    let version = 1;
    for (let index = 0; index < context.warmup + context.samples; index += 1) {
      const before = client.publishes.length;
      /** @type {Buffer[]} */
      const frames = [];
      for (let edit = 0; edit < BURST; edit += 1) {
        version += 1;
        frames.push(
          client.frame({
            jsonrpc: '2.0',
            method: 'textDocument/didChange',
            params: {
              textDocument: { uri: fx.primary.uri, version },
              contentChanges: [{ text: `${fx.primary.source}\n<!-- ${String(index)}.${String(edit)} -->` }],
            },
          }),
        );
      }

      const answer = client.nextDiagnostics(fx.primary.uri);
      const started = performance.now();
      client.write(frames);
      await answer;
      const duration = performance.now() - started;
      // Long enough that a second check for the same burst would have published by now.
      await pause(2 * DEBOUNCE);
      const validations = client.publishes.length - before;

      /** @type {BenchmarkSample} */
      const sample =
        validations >= 1
          ? { ok: true, duration, metrics: { validations } }
          : { ok: false, detail: 'a burst of edits published no diagnostics' };
      if (index >= context.warmup || !sample.ok) samples.push(sample);
      if (!sample.ok) break;
    }
    return samples;
  } finally {
    await end(client);
  }
}

/**
 * A request withdrawn in the same write that sent it.
 *
 * @param {NodeWorkloadContext} context
 * @returns {Promise<BenchmarkSample[]>}
 */
async function cancellation(context) {
  const fx = await fixture(context, 1);
  const client = await session(fx);
  /** @type {BenchmarkSample[]} */
  const samples = [];

  try {
    client.open(fx.primary.uri, 'html', 1, fx.primary.source);
    await client.diagnostics(fx.primary.uri);
    const at = positionAt(fx.primary.source, fx.primary.source.indexOf(`<${fx.tag}`) + 2);

    for (let index = 0; index < context.warmup + context.samples; index += 1) {
      const id = client.nextId();
      const withdrawn = client.expect(id);
      const started = performance.now();
      client.write([
        client.frame({
          jsonrpc: '2.0',
          id,
          method: 'textDocument/hover',
          params: { textDocument: { uri: fx.primary.uri }, position: at },
        }),
        client.frame({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }),
      ]);
      const response = await withdrawn;
      const duration = performance.now() - started;

      /** @type {BenchmarkSample} */
      const sample =
        response.error?.code === -32800
          ? { ok: true, duration }
          : { ok: false, detail: `a withdrawn request was answered ${JSON.stringify(response).slice(0, 200)}` };
      if (index >= context.warmup || !sample.ok) samples.push(sample);
      if (!sample.ok) break;
    }
    return samples;
  } finally {
    await end(client);
  }
}

/**
 * The suite.
 *
 * `origins: ['source']` because an editor session reads an application's sources; the
 * dist origin describes a built artifact, which no language server ever opens.
 *
 * @type {WorkloadSpec[]}
 */
export const EDITOR_WORKLOADS = [
  ...[1, 10].map((scale) => ({
    id: `editor/cold-start-${String(scale)}x`,
    suite: /** @type {'editor'} */ ('editor'),
    title: `Open a template in a fresh server over ${scale === 1 ? 'one application' : `${String(scale)} applications`}`,
    driver: /** @type {'node'} */ ('node'),
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    units: { duration: 'ms', initialize: 'ms', firstCompletion: 'ms', firstDiagnostics: 'ms' },
    origins: /** @type {('source' | 'dist')[]} */ (['source']),
    run: (/** @type {NodeWorkloadContext} */ context) => coldStart(context, scale),
  })),

  ...[1, 10].map((scale) => ({
    id: `editor/interactive-${String(scale)}x`,
    suite: /** @type {'editor'} */ ('editor'),
    title: `Completion and hover with validation outstanding, over ${scale === 1 ? 'one application' : `${String(scale)} applications`}`,
    driver: /** @type {'node'} */ ('node'),
    samples: { local: 120, ci: 100 },
    warmup: { local: 20, ci: 10 },
    origins: /** @type {('source' | 'dist')[]} */ (['source']),
    run: (/** @type {NodeWorkloadContext} */ context) => interactive(context, scale),
  })),

  {
    id: 'editor/edit-burst',
    suite: /** @type {'editor'} */ ('editor'),
    title: `${String(BURST)} edits in one debounce window, to one answer`,
    driver: /** @type {'node'} */ ('node'),
    samples: { local: 20, ci: 12 },
    warmup: { local: 2, ci: 2 },
    units: { duration: 'ms', validations: 'count' },
    origins: /** @type {('source' | 'dist')[]} */ (['source']),
    run: editBurst,
  },

  {
    id: 'editor/cancellation',
    suite: /** @type {'editor'} */ ('editor'),
    title: 'Withdraw a request in the write that sent it',
    driver: /** @type {'node'} */ ('node'),
    samples: { local: 60, ci: 40 },
    warmup: { local: 5, ci: 5 },
    origins: /** @type {('source' | 'dist')[]} */ (['source']),
    run: cancellation,
  },
];
