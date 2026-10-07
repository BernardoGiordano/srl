/**
 * A Model Context Protocol server over stdio, so an agent asks the toolchain directly
 * instead of parsing a terminal.
 *
 *   srl mcp
 *
 * An adapter, like the language server's editor launchers. Each tool calls a module
 * the CLI already has and returns its answer as structured content and as JSON text.
 * ADR-0127.
 *
 *   check       `checkProject()` from `cli/checks/`, the run `srl check --json` makes
 *   codes       the diagnostic catalogue, what `srl check --codes` prints
 *   elements    every element an application's model sees
 *   element     one element's inputs, attributes, events, projection and users
 *   docs        `llms.txt`, or one page of the documentation the packages ship
 *
 * The transport is the protocol's stdio framing, one JSON-RPC message per line. Stdout
 * carries messages and nothing else, so console output from any module goes to stderr.
 *
 * Every answer carries project text, such as file names, element names and template
 * source. An untrusted repository can word that text as instructions to the agent.
 * The editor guide says so, and nothing here filters it. ADR-0131.
 */

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUBJECTS, checkProject } from '../checks/index.mjs';
import { catalogEntries } from '../diagnostics/catalog.mjs';
import { counts, hasErrors } from '../diagnostics/index.mjs';
import { REPO, apps, exists } from '../layout.mjs';
import { PACKAGE } from '../package/interface.mjs';
import { projectIndex, readProject } from '../project-model/index.mjs';

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** @typedef {{ jsonrpc: '2.0', id?: string | number | null, method?: string, params?: Record<string, unknown> }} Message */
/** @typedef {{ name: string, description: string, inputSchema: object, run: (args: Record<string, unknown>) => Promise<unknown> }} Tool */

/** A tool call that cannot run as asked. The caller sees it as a tool error. */
class ToolError extends Error {}

/**
 * The application a call names, or the only one there is.
 *
 * @param {unknown} name
 */
async function pickApp(name) {
  const all = await apps();
  if (typeof name === 'string') {
    const found = all.find((app) => app.name === name);
    if (found === undefined) {
      throw new ToolError(`No application "${name}". Applications: ${all.map((app) => app.name).join(', ')}.`);
    }
    return found;
  }
  const [only] = all;
  if (only === undefined) throw new ToolError(`No application with an index.html in ${REPO}.`);
  if (all.length > 1) {
    throw new ToolError(`Name an application with "app": ${all.map((app) => app.name).join(', ')}.`);
  }
  return only;
}

/**
 * Where the shipped documentation is. An installed package carries a copy, and a
 * checkout has the tree it is copied from.
 *
 * @returns {Promise<{ docs: string, index: string | null }>}
 */
async function documentation() {
  const shipped = join(PACKAGE, 'docs');
  const index = join(PACKAGE, 'llms.txt');
  if (await exists(shipped)) return { docs: shipped, index: (await exists(index)) ? index : null };
  return { docs: join(REPO, 'docs'), index: null };
}

const APP = { type: 'string', description: 'The application directory. Optional when the project has one.' };

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'check',
    description:
      'Run srl check: types, templates, the import map, messages and the project model, in one ' +
      'process. Returns every finding with its severity, stable code, file, line and column.',
    inputSchema: {
      type: 'object',
      properties: {
        subjects: { type: 'array', items: { enum: [...SUBJECTS] }, description: 'Narrow the run. All by default.' },
        app: APP,
      },
    },
    run: async (args) => {
      const subjects = Array.isArray(args.subjects)
        ? SUBJECTS.filter((subject) => /** @type {unknown[]} */ (args.subjects).includes(subject))
        : undefined;
      const selected = typeof args.app === 'string' ? [await pickApp(args.app)] : undefined;
      const found = await checkProject({ subjects, apps: selected });
      return { ok: !hasErrors(found), counts: counts(found), diagnostics: found };
    },
  },
  {
    name: 'codes',
    description: 'Every diagnostic code srl check and srl serve report, with one sentence on what it means.',
    inputSchema: { type: 'object', properties: {} },
    run: () => Promise.resolve({ codes: Object.fromEntries(catalogEntries()) }),
  },
  {
    name: 'elements',
    description: 'Every custom element the application can use: tag, class and module.',
    inputSchema: { type: 'object', properties: { app: APP } },
    run: async (args) => {
      const index = projectIndex(await readProject(await pickApp(args.app)));
      return {
        schemaVersion: index.schemaVersion,
        elements: index.elements.map(({ tag, className, module }) => ({ tag, className, module })),
      };
    },
  },
  {
    name: 'element',
    description:
      'One element: its inputs and their attributes, events, projection names, template, the ' +
      'elements it uses and the elements that use it.',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Such as ui-table.' }, app: APP },
      required: ['tag'],
    },
    run: async (args) => {
      if (typeof args.tag !== 'string') throw new ToolError('"tag" must be a string.');
      const tag = args.tag.toLowerCase();
      const index = projectIndex(await readProject(await pickApp(args.app)));
      const element = index.elements.find((candidate) => candidate.tag === tag);
      if (element === undefined) throw new ToolError(`No element <${tag}>. The elements tool lists them.`);
      const usedBy = index.elements.filter((candidate) => candidate.uses.includes(tag)).map((candidate) => candidate.tag);
      return { schemaVersion: index.schemaVersion, element, usedBy };
    },
  },
  {
    name: 'docs',
    description:
      'The srl documentation for the installed version. With no path, the llms.txt index of every ' +
      'guide, reference page and decision record. With a path such as guide/templates.md, that page.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative to docs/, such as reference/template-dialect.md.' } },
    },
    run: async (args) => {
      const { docs, index } = await documentation();
      if (args.path === undefined) {
        if (index !== null) return { path: 'llms.txt', text: await readFile(index, 'utf8') };
        return { path: 'README.md', text: await readFile(join(docs, 'README.md'), 'utf8') };
      }
      if (typeof args.path !== 'string') throw new ToolError('"path" must be a string.');
      const file = resolve(docs, normalize(args.path.replace(/^docs\//u, '')));
      if (!file.startsWith(docs + sep) || !file.endsWith('.md')) {
        throw new ToolError(`"${args.path}" is not a page under docs/.`);
      }
      if (!(await exists(file))) throw new ToolError(`No page ${relative(docs, file)}.`);
      return { path: relative(docs, file).split(sep).join('/'), text: await readFile(file, 'utf8') };
    },
  },
];

/**
 * The answer to one message, or null for a notification, which gets none.
 *
 * @param {Message} message
 * @returns {Promise<object | null>}
 */
export async function answer(message) {
  const { id, method, params = {} } = message;
  const notification = id === undefined;

  /** @param {object} result */
  const ok = (result) => (notification ? null : { jsonrpc: '2.0', id, result });
  /** @param {number} code @param {string} text */
  const fail = (code, text) => (notification ? null : { jsonrpc: '2.0', id, error: { code, message: text } });

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const version =
        typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      return ok({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'srl', title: 'srl toolchain', version: String(manifest.version) },
        instructions:
          `Project root: ${REPO}. Call check after each edit and fix every finding whose ` +
          'severity is error. Codes are stable, and the codes tool explains each one.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (tool === undefined) return fail(-32602, `Unknown tool: ${String(params.name)}`);
      const args = /** @type {Record<string, unknown>} */ (
        typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
      );
      try {
        const result = /** @type {Record<string, unknown>} */ (await tool.run(args));
        return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

/**
 * Serve one client on stdin and stdout until stdin closes.
 *
 * Requests are answered in arrival order, so a slow check delays the answers behind it
 * rather than interleaving with them.
 */
export async function serveStdio() {
  // Stdout is the transport. Anything a module prints goes to stderr instead.
  console.log = console.error;
  console.info = console.error;

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    /** @type {Message} */
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const reply = await answer(message);
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await serveStdio();
}
