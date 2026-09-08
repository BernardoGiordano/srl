'use strict';

const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { locate } = require('./server-path.cjs');
const { SrlSessions } = require('./session.cjs');

/**
 * The VS Code half of ADR-0090's thin launcher: it turns editor events into start, stop
 * and restart. Which resources a session owns, when it may run and what it reports are
 * `session.cjs`, so this file holds no cleanup or ordering knowledge. ADR-0094.
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
