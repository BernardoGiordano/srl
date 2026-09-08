'use strict';

const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { findServer } = require('./server-path.cjs');

/** @type {Map<string, import('vscode-languageclient/node').LanguageClient>} */
const clients = new Map();

/** @param {import('vscode').ExtensionContext} context */
async function activate(context) {
  for (const folder of vscode.workspace.workspaceFolders ?? []) await start(folder);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      for (const folder of event.removed) await stop(folder.uri.toString());
      for (const folder of event.added) await start(folder);
    }),
    vscode.commands.registerCommand('srl.restartLanguageServer', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      await Promise.all([...clients.keys()].map((key) => stop(key)));
      for (const folder of folders) await start(folder);
    }),
  );
}

/** @param {import('vscode').WorkspaceFolder} folder */
async function start(folder) {
  const key = folder.uri.toString();
  if (clients.has(key)) return;
  const root = folder.uri.fsPath;
  const server = findServer(root);
  if (server === null) return;

  const node = vscode.workspace.getConfiguration('srl', folder.uri).get('nodePath', 'node');
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '**/*.{html,js,mjs,json}'),
  );
  const client = new LanguageClient(
    `srl-${folder.index}`,
    `srl (${folder.name})`,
    {
      command: node,
      args: [server],
      transport: TransportKind.stdio,
      options: {
        cwd: root,
        env: { ...process.env, SRL_ROOT: root },
      },
    },
    {
      documentSelector: [
        { scheme: 'file', language: 'html', pattern: new vscode.RelativePattern(folder, '**/*.html') },
        { scheme: 'file', language: 'javascript', pattern: new vscode.RelativePattern(folder, '**/*.{js,mjs}') },
      ],
      synchronize: { fileEvents: watcher },
      workspaceFolder: folder,
      outputChannelName: `srl Language Server (${folder.name})`,
    },
  );
  clients.set(key, client);
  try {
    await client.start();
  } catch (cause) {
    clients.delete(key);
    watcher.dispose();
    void vscode.window.showErrorMessage(
      `srl language server failed for ${folder.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** @param {string} key */
async function stop(key) {
  const client = clients.get(key);
  if (client === undefined) return;
  clients.delete(key);
  await client.stop();
}

async function deactivate() {
  await Promise.all([...clients.keys()].map((key) => stop(key)));
}

module.exports = { activate, deactivate };
