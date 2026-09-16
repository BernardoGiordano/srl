'use strict';

const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { locate } = require('./server-path.cjs');
const { SrlSessions } = require('./session.cjs');

/**
 * Turn VS Code events into session starts, stops, and restarts. `session.cjs` owns
 * the lifecycle.
 */
const sessions = new SrlSessions({
  vscode,
  locate,
  createClient: ({ id, name, serverOptions, clientOptions }) =>
    new LanguageClient(id, name, { ...serverOptions, transport: TransportKind.stdio }, clientOptions),
});

/** @param {import('vscode').ExtensionContext} context */
async function activate(context) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      for (const folder of event.removed) await sessions.stop(folder.uri.toString());
      for (const folder of event.added) await sessions.start(folder);
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      await sessions.configurationChanged(event, vscode.workspace.workspaceFolders ?? []);
    }),
    vscode.commands.registerCommand('srl.restartLanguageServer', () =>
      sessions.restart(vscode.workspace.workspaceFolders ?? []),
    ),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) await sessions.start(folder);
}

async function deactivate() {
  await sessions.stopAll();
}

module.exports = { activate, deactivate };
