#!/usr/bin/env node

/**
 * srl Language Server Protocol adapter.
 *
 * No protocol dependency: stdio framing and JSON-RPC dispatch are small, while every
 * language feature lives in `service.mjs`. Both VS Code and WebStorm start this file
 * from the project's own `@srljs/cli`, so editor semantics match installed srl semantics.
 * ADR-0090.
 */

import { SrlLanguageService } from './service.mjs';

const service = new SrlLanguageService();
let buffer = Buffer.alloc(0);
let shutdown = false;
let nextRequest = 1;
/** @type {NodeJS.Timeout | undefined} */
let validationTimer;
/** @type {NodeJS.Timeout | undefined} */
let reloadTimer;

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
  try {
    const result = await dispatch(message.method, message.params ?? {});
    if (message.id !== undefined && message.id !== null) respond(message.id, result);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (message.id !== undefined && message.id !== null) respondError(message.id, -32603, error);
    else process.stderr.write(`srl language server: ${message.method}: ${error}\n`);
  }
}

/** @param {string} method @param {any} params */
async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      try {
        await service.reload();
      } catch (cause) {
        notify('window/showMessage', {
          type: 1,
          message: `srl language server could not read this project: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
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
        serverInfo: { name: 'srl', version: '0.7.0' },
      };
    }
    case 'initialized':
      request('client/registerCapability', {
        registrations: [
          {
            id: 'srl-source-watch',
            method: 'workspace/didChangeWatchedFiles',
            registerOptions: {
              watchers: [
                { globPattern: '**/*.html', kind: 7 },
                { globPattern: '**/*.js', kind: 7 },
                { globPattern: '**/*.mjs', kind: 7 },
                { globPattern: '**/{package,tsconfig}.json', kind: 7 },
              ],
            },
          },
        ],
      });
      scheduleValidation();
      return null;
    case 'shutdown':
      shutdown = true;
      return null;
    case 'exit':
      process.exit(shutdown ? 0 : 1);
      return null;
    case 'textDocument/didOpen':
      service.open(
        params.textDocument.uri,
        params.textDocument.languageId,
        params.textDocument.version,
        params.textDocument.text,
      );
      scheduleValidation(params.textDocument.uri);
      return null;
    case 'textDocument/didChange': {
      const change = params.contentChanges.at(-1);
      if (change !== undefined) {
        service.change(params.textDocument.uri, params.textDocument.version, change.text);
        scheduleValidation(params.textDocument.uri);
      }
      return null;
    }
    case 'textDocument/didSave':
      if (params.text !== undefined) {
        const current = service.documents.get(params.textDocument.uri);
        service.change(params.textDocument.uri, current?.version ?? 0, params.text);
      }
      if (/\.(?:m?js|json|html)$/u.test(params.textDocument.uri)) scheduleReload();
      else scheduleValidation(params.textDocument.uri);
      return null;
    case 'textDocument/didClose':
      service.close(params.textDocument.uri);
      notify('textDocument/publishDiagnostics', {
        uri: params.textDocument.uri,
        diagnostics: [],
      });
      return null;
    case 'workspace/didChangeWatchedFiles':
      scheduleReload();
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
    case '$/setTrace':
    case '$/cancelRequest':
    case 'workspace/didChangeConfiguration':
      return null;
    default:
      if (params.id !== undefined) throw new Error(`Method not found: ${method}`);
      return null;
  }
}

/** @param {string} [only] */
function scheduleValidation(only) {
  if (validationTimer !== undefined) clearTimeout(validationTimer);
  validationTimer = setTimeout(() => void validateOpen(only), 120);
}

function scheduleReload() {
  if (reloadTimer !== undefined) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    void service
      .reload()
      .then(() => validateOpen())
      .catch((cause) =>
        notify('window/showMessage', {
          type: 1,
          message: `srl project refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
  }, 120);
}

/** @param {string} [only] */
async function validateOpen(only) {
  const uris = only === undefined ? [...service.documents.keys()] : [only];
  for (const uri of uris) {
    const diagnostics = await service.diagnostics(uri);
    notify('textDocument/publishDiagnostics', { uri, diagnostics });
  }
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

