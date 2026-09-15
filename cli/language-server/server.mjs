#!/usr/bin/env node

/**
 * srl Language Server Protocol adapter.
 *
 * No protocol dependency: stdio framing and JSON-RPC dispatch are small, while every
 * language feature lives in `service.mjs`. Both VS Code and WebStorm start this file
 * from the project's own `@srljs/cli`, so editor semantics match installed srl semantics.
 * ADR-0090.
 *
 * Dispatch answers messages; it does not decide when analysis runs, or where. Document
 * lifetime, staleness, scheduling and the thread a check executes on belong to
 * `analysis.mjs`, so a message handler is a single call with no ordering knowledge in it.
 * This thread does no typechecking, which is what keeps a completion answerable while a
 * template is being validated. ADR-0090, ADR-0090.
 *
 * What it asks of the client it asks once, and only where the client says it can answer:
 * the watchers for this project are registered here rather than also beside each editor
 * adapter, and an unimplemented method is refused rather than answered. ADR-0090.
 */

import { pathToFileURL } from 'node:url';

import { REPO } from '../layout.mjs';
import { LiveAnalysis } from './analysis.mjs';
import { SrlLanguageService } from './service.mjs';

const service = new SrlLanguageService();
const analysis = new LiveAnalysis({
  service,
  publish: (uri, diagnostics) => notify('textDocument/publishDiagnostics', { uri, diagnostics }),
  report: (text) => notify('window/showMessage', { type: 1, message: text }),
});
let buffer = Buffer.alloc(0);
let shutdown = false;
let nextRequest = 1;
/** What the client said it can do, read once from `initialize`. @type {any} */
let clientCapabilities = {};
/** Requests being answered. @type {Set<string | number>} */
const pending = new Set();
/** Requests the client withdrew before an answer was written. @type {Set<string | number>} */
const cancelled = new Set();

/**
 * A failure that names the code the protocol reserves for it. Without one every failure
 * is an internal error, and a client cannot tell a method this server does not implement
 * from a method that implements it and threw.
 */
class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  readMessages();
});
process.stdin.on('end', () => process.exit(shutdown ? 0 : 1));
process.stdin.resume();

process.on('uncaughtException', (cause) => {
  process.stderr.write(`srl language server: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
});
process.on('unhandledRejection', (cause) => {
  process.stderr.write(`srl language server: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
});

function readMessages() {
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator === -1) return;
    const header = buffer.subarray(0, separator).toString('ascii');
    const length = Number(/(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
    if (!Number.isFinite(length)) {
      buffer = buffer.subarray(separator + 4);
      continue;
    }
    const end = separator + 4 + length;
    if (buffer.length < end) return;
    const body = buffer.subarray(separator + 4, end).toString('utf8');
    buffer = buffer.subarray(end);
    try {
      void receive(JSON.parse(body));
    } catch (cause) {
      process.stderr.write(`srl language server: invalid JSON-RPC message: ${String(cause)}\n`);
    }
  }
}

/** @param {{ id?: string | number | null, method?: string, params?: any }} message */
async function receive(message) {
  if (message.method === undefined) return;
  const id = message.id;
  const answerable = id !== undefined && id !== null;
  if (answerable) pending.add(id);
  try {
    const result = await dispatch(message.method, message.params ?? {}, answerable);
    if (!answerable) return;
    // A withdrawn request gets the answer the protocol reserves for one. A client that
    // asked to forget a request should not have to work out which reply to ignore.
    if (cancelled.has(id)) respondError(id, -32800, 'Request cancelled');
    else respond(id, result);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const code = cause instanceof RpcError ? cause.code : -32603;
    if (answerable) respondError(id, cancelled.has(id) ? -32800 : code, error);
    else process.stderr.write(`srl language server: ${message.method}: ${error}\n`);
  } finally {
    if (answerable) {
      pending.delete(id);
      cancelled.delete(id);
    }
  }
}

/** @param {string} method @param {any} params @param {boolean} answerable */
async function dispatch(method, params, answerable) {
  switch (method) {
    case 'initialize': {
      clientCapabilities = params.capabilities ?? {};
      await analysis.start();
      return {
        capabilities: {
          positionEncoding: 'utf-16',
          textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
          completionProvider: { triggerCharacters: ['<', ' ', '[', '(', '.', '*', '{'] },
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: { prepareProvider: true },
          semanticTokensProvider: {
            legend: {
              tokenTypes: [
                'namespace', 'type', 'class', 'enum', 'interface', 'struct',
                'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
                'event', 'function', 'method', 'macro', 'keyword', 'modifier',
                'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
              ],
              tokenModifiers: [],
            },
            full: true,
          },
          documentLinkProvider: { resolveProvider: false },
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          codeActionProvider: { codeActionKinds: ['quickfix'] },
        },
        serverInfo: { name: 'srl', version: '0.9.0' },
      };
    }
    case 'initialized': {
      const registration = sourceWatchRegistration();
      if (registration === null) {
        process.stderr.write(
          'srl language server: the client does not register file watchers, so edits made ' +
            'outside its open buffers refresh only on restart\n',
        );
      } else {
        request('client/registerCapability', { registrations: [registration] });
      }
      return null;
    }
    case 'shutdown':
      shutdown = true;
      // Answered after the validation thread is gone, so `exit` cannot arrive while a
      // compiler is still holding this project open.
      await analysis.dispose();
      return null;
    case 'exit':
      process.exit(shutdown ? 0 : 1);
      return null;
    case 'textDocument/didOpen':
      analysis.open(
        params.textDocument.uri,
        params.textDocument.languageId,
        params.textDocument.version,
        params.textDocument.text,
      );
      return null;
    case 'textDocument/didChange': {
      const change = params.contentChanges.at(-1);
      if (change !== undefined) {
        analysis.change(params.textDocument.uri, params.textDocument.version, change.text);
      }
      return null;
    }
    case 'textDocument/didSave':
      analysis.save(params.textDocument.uri, params.text);
      return null;
    case 'textDocument/didClose':
      analysis.close(params.textDocument.uri);
      return null;
    case 'workspace/didChangeWatchedFiles':
      analysis.watched(params.changes ?? []);
      return null;
    case 'textDocument/completion':
      return service.completion(params.textDocument.uri, params.position);
    case 'textDocument/hover':
      return service.hover(params.textDocument.uri, params.position);
    case 'textDocument/definition':
      return service.definition(params.textDocument.uri, params.position);
    case 'textDocument/references':
      return service.references(
        params.textDocument.uri,
        params.position,
        params.context?.includeDeclaration === true,
      );
    case 'textDocument/prepareRename':
      return service.prepareRename(params.textDocument.uri, params.position);
    case 'textDocument/rename':
      return service.rename(params.textDocument.uri, params.position, params.newName);
    case 'textDocument/semanticTokens/full':
      return service.semanticTokens(params.textDocument.uri);
    case 'textDocument/documentLink':
      return service.documentLinks(params.textDocument.uri);
    case 'textDocument/documentSymbol':
      return service.documentSymbols(params.textDocument.uri);
    case 'workspace/symbol':
      return service.workspaceSymbols(params.query ?? '');
    case 'textDocument/codeAction':
      return service.codeActions(
        params.textDocument.uri,
        params.range,
        params.context?.diagnostics ?? [],
      );
    case '$/cancelRequest':
      if (pending.has(params.id)) cancelled.add(params.id);
      return null;
    case '$/setTrace':
    case 'workspace/didChangeConfiguration':
      return null;
    default:
      // A notification is ignored, as the protocol requires; a request is answered with
      // the code that says so. `params.id` was read here, and a request carries its id
      // on the message rather than in its parameters, so every unknown method was
      // answered `null` — a client cannot negotiate against a server that pretends.
      if (answerable) throw new RpcError(-32601, `Method not found: ${method}`);
      return null;
  }
}

/**
 * The files this server reads, as a watch registration the client owns, or null when the
 * client cannot take one.
 *
 * Watching is asked for once, here, rather than also being set up beside each client: the
 * VS Code adapter used to add a folder watcher of its own, so one edit reloaded a project
 * twice, and a global glob meant every root in a multi-root window reloaded for every
 * other root's edit. The patterns are rooted at this server's own project when the client
 * supports a relative pattern, which is what keeps one root's edit out of another root's
 * model. ADR-0090.
 */
function sourceWatchRegistration() {
  const watched = clientCapabilities.workspace?.didChangeWatchedFiles;
  if (watched?.dynamicRegistration !== true) return null;
  const baseUri = watched.relativePatternSupport === true ? pathToFileURL(REPO).href : null;
  const patterns = ['**/*.html', '**/*.js', '**/*.mjs', '**/{package,tsconfig}.json'];
  return {
    id: 'srl-source-watch',
    method: 'workspace/didChangeWatchedFiles',
    registerOptions: {
      watchers: patterns.map((pattern) => ({
        globPattern: baseUri === null ? pattern : { baseUri, pattern },
        kind: 7,
      })),
    },
  };
}

/** @param {string | number} id @param {unknown} result */
function respond(id, result) {
  write({ jsonrpc: '2.0', id, result: result ?? null });
}

/** @param {string | number} id @param {number} code @param {string} message */
function respondError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

/** @param {string} method @param {unknown} params */
function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

/** @param {string} method @param {unknown} params */
function request(method, params) {
  write({ jsonrpc: '2.0', id: nextRequest, method, params });
  nextRequest += 1;
}

/** @param {unknown} message */
function write(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${String(body.length)}\r\n\r\n`);
  process.stdout.write(body);
}

