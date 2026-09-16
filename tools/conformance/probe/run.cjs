'use strict';

/**
 * The scenarios, asked of a real VS Code with the packed extension installed. ADR-0097.
 *
 * This runs inside the extension host, so every answer comes from the editor's own
 * providers rather than from a client written here. The plan says which projects are on
 * disk and which scenarios to ask; the results file is the only thing it returns.
 */

const fs = require('node:fs');
const path = require('node:path');

const vscode = require('vscode');

const { census } = require('../servers.cjs');

const plan = JSON.parse(fs.readFileSync(process.env.SRL_CONFORMANCE_PLAN, 'utf8'));

/** How long an answer that needs a cold compiler may take. */
const PATIENCE = 60_000;

/** How long the server is given to publish, or to stay silent. */
const SETTLE = 3_000;

async function run() {
  /** @type {Array<{ id: string, status: string, detail: string }>} */
  const results = [];
  try {
    const extension = vscode.extensions.getExtension(plan.extension);
    if (extension === undefined) throw new Error(`${plan.extension} is not installed`);
    await extension.activate();

    for (const scenario of plan.scenarios) {
      results.push(await one(scenario));
    }
  } catch (cause) {
    results.push({ id: 'probe', status: 'fail', detail: describe(cause) });
  }
  fs.writeFileSync(plan.out, `${JSON.stringify({ results }, null, 2)}\n`);
}

/**
 * An ask answers null when its expectation held, a sentence when it did not, and
 * `{ unavailable }` when this editor cannot be asked at all.
 *
 * @param {any} scenario
 */
async function one(scenario) {
  try {
    const answer = await ASKS[scenario.ask](scenario);
    if (answer === null) return { id: scenario.id, status: 'pass', detail: '' };
    if (typeof answer === 'object') return { id: scenario.id, status: 'unavailable', detail: answer.unavailable };
    return { id: scenario.id, status: 'fail', detail: answer };
  } catch (cause) {
    return { id: scenario.id, status: 'fail', detail: describe(cause) };
  }
}

/* ── The asks ──────────────────────────────────────────────────────────── */

/** Each returns null when the expectation held, or the sentence that says it did not. */
const ASKS = {
  async servers(scenario) {
    for (const root of scenario.add ?? []) await addFolder(root);
    for (const opening of scenario.open ?? []) await open(opening.root, opening.document);
    return await serving(scenario.expect);
  },

  async restart(scenario) {
    const before = census(plan.roots);
    for (let time = 0; time < scenario.times; time += 1) {
      await vscode.commands.executeCommand(plan.restartCommand);
    }
    const wrong = await serving(scenario.expect);
    if (wrong !== null) return wrong;
    const after = census(plan.roots);
    return after.total === before.total
      ? null
      : `${String(before.total)} server(s) before ${String(scenario.times)} restarts, ${String(after.total)} after`;
  },

  async diagnostics(scenario) {
    const document = await open(scenario.root ?? 'one', scenario.document);
    const revert = scenario.edit === undefined ? null : await edit(document, scenario.edit);
    try {
      // A completion is a round trip, so once it has answered the server has this
      // buffer.
      await ask('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 0));
      const found = await attempt(
        () => published(document.uri),
        (messages) => matches(messages.join('\n'), scenario.expect),
        scenario.expect.empty === true ? SETTLE : PATIENCE,
      );
      return verdict(found.join('\n'), scenario.expect, `diagnostics: ${found.join(' | ') || 'none'}`);
    } finally {
      if (revert !== null) await revert();
    }
  },

  async completion(scenario) {
    const document = await open(scenario.root ?? 'one', scenario.document);
    const at = locate(document, scenario.at);
    const labels = await attempt(
      async () => {
        const list = await ask('vscode.executeCompletionItemProvider', document.uri, at);
        return (list?.items ?? []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
      },
      (found) => matches(found.join('\n'), scenario.expect),
      PATIENCE,
    );
    return verdict(labels.join('\n'), scenario.expect, `${String(labels.length)} completion(s)`);
  },

  async hover(scenario) {
    const document = await open(scenario.root ?? 'one', scenario.document);
    const at = locate(document, scenario.at);
    const text = await attempt(
      async () => {
        const hovers = (await ask('vscode.executeHoverProvider', document.uri, at)) ?? [];
        return hovers
          .flatMap((hover) => hover.contents)
          .map((part) => (typeof part === 'string' ? part : (part.value ?? '')))
          .join('\n');
      },
      (found) => matches(found, scenario.expect),
      PATIENCE,
    );
    return verdict(text, scenario.expect, `hover: ${text.slice(0, 120) || 'nothing'}`);
  },

  async definition(scenario) {
    const document = await open(scenario.root ?? 'one', scenario.document);
    const at = locate(document, scenario.at);
    const wanted = path.join(plan.roots[scenario.root ?? 'one'], scenario.expect.file);
    const targets = await attempt(
      async () => {
        const found = (await ask('vscode.executeDefinitionProvider', document.uri, at)) ?? [];
        return found.map((one) => (one.targetUri ?? one.uri).fsPath);
      },
      (found) => found.some((file) => file === wanted),
      PATIENCE,
    );
    return targets.some((file) => file === wanted)
      ? null
      : `definition went to ${targets.join(', ') || 'nothing'} rather than ${wanted}`;
  },

  async rename(scenario) {
    const document = await open(scenario.root ?? 'one', scenario.document);
    const at = locate(document, scenario.at);
    const wanted = scenario.expect.files.map((file) => path.join(plan.roots[scenario.root ?? 'one'], file));
    const edited = await attempt(
      async () => {
        const workspaceEdit = await ask('vscode.executeDocumentRenameProvider', document.uri, at, scenario.to);
        return (workspaceEdit?.entries() ?? []).map(([uri]) => uri.fsPath).sort();
      },
      (found) => wanted.every((file) => found.includes(file)),
      PATIENCE,
    );
    const missing = wanted.filter((file) => !edited.includes(file));
    return missing.length === 0 ? null : `rename edited ${edited.join(', ') || 'nothing'}, not ${missing.join(', ')}`;
  },

  async watch(scenario) {
    const root = plan.roots[scenario.root ?? 'one'];
    const target = path.join(root, scenario.write.document);
    const source = fs.readFileSync(target, 'utf8');
    if (!source.includes(scenario.write.replace)) {
      throw new Error(`no ${JSON.stringify(scenario.write.replace)} in ${target}`);
    }
    // Written with the editor closed over this file, so the server learns about it
    // through the watchers it registered or not at all.
    fs.writeFileSync(target, source.replace(scenario.write.replace, scenario.write.with));

    const document = await open(scenario.root ?? 'one', scenario.document);
    const at = locate(document, scenario.at);
    const labels = await attempt(
      async () => {
        const list = await ask('vscode.executeCompletionItemProvider', document.uri, at);
        return (list?.items ?? []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
      },
      (found) => matches(found.join('\n'), scenario.expect),
      PATIENCE,
    );
    return verdict(labels.join('\n'), scenario.expect, `${String(labels.length)} completion(s) after the disk change`);
  },

  async trace(scenario) {
    // Window scope, because a language client reads `<id>.trace.server` without a
    // resource, so the level belongs to the window even though the channel it writes is
    // per folder.
    await vscode.workspace
      .getConfiguration('srl')
      .update('trace.server', 'verbose', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand(plan.restartCommand);

    const document = await open('one', scenario.document);
    await ask('vscode.executeCompletionItemProvider', document.uri, locate(document, scenario.at));

    const text = await attempt(() => traced(), (found) => matches(found, scenario.expect), 30_000);
    if (text === '') return { unavailable: 'this editor persists no output channel this run can read' };
    return verdict(text, scenario.expect, 'the trace log does not record the request');
  },
};

/* ── Evidence ──────────────────────────────────────────────────────────── */

/** @param {any} expect */
async function serving(expect) {
  const wanted = expect.serving ?? [];
  const silent = expect.silent ?? [];
  const found = await attempt(
    () => census(plan.roots),
    (taken) => wanted.every((root) => taken.byRoot[root] === 1) && silent.every((root) => (taken.byRoot[root] ?? 0) === 0),
    PATIENCE,
  );
  const wrong = [
    ...wanted.filter((root) => found.byRoot[root] !== 1).map((root) => `${root} has ${String(found.byRoot[root] ?? 0)}`),
    ...silent.filter((root) => (found.byRoot[root] ?? 0) > 0).map((root) => `${root} has ${String(found.byRoot[root])}`),
  ];
  return wrong.length === 0 ? null : `one server per served project was expected: ${wrong.join(', ')}`;
}

/** The srl diagnostics published for a document. @param {any} uri */
function published(uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.source === 'srl')
    .map((diagnostic) => diagnostic.message);
}

/** Whatever the client wrote to its trace log, if this editor keeps one on disk. */
function traced() {
  /** @type {string[]} */
  const found = [];
  // The channel is written under a directory named for the extension, a file named for
  // the channel, or both, depending on the version. Match the path rather than
  // guess.
  const walk = (/** @type {string} */ directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/srl/iu.test(full) && /\.log$/iu.test(entry.name)) found.push(fs.readFileSync(full, 'utf8'));
    }
  };
  try {
    walk(plan.logs);
  } catch {
    return '';
  }
  return found.join('\n');
}

/* ── The editor ────────────────────────────────────────────────────────── */

/** @param {string} root @param {string} relative */
async function open(root, relative) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(plan.roots[root], relative)));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

/** Apply an unsaved edit, and hand back the undo. @param {any} document @param {any} change */
async function edit(document, change) {
  const text = document.getText();
  const at = text.indexOf(change.replace);
  if (at < 0) throw new Error(`no ${JSON.stringify(change.replace)} in ${document.uri.fsPath}`);
  const range = new vscode.Range(document.positionAt(at), document.positionAt(at + change.replace.length));
  const applied = new vscode.WorkspaceEdit();
  applied.replace(document.uri, range, change.with);
  await vscode.workspace.applyEdit(applied);
  return async () => {
    const undo = new vscode.WorkspaceEdit();
    undo.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      text,
    );
    await vscode.workspace.applyEdit(undo);
  };
}

/** @param {string} root */
async function addFolder(root) {
  const uri = vscode.Uri.file(plan.roots[root]);
  if (vscode.workspace.getWorkspaceFolder(uri) !== undefined) return;
  const landed = new Promise((done) => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      subscription.dispose();
      done(undefined);
    });
  });
  if (!vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri })) {
    throw new Error(`VS Code refused to add ${uri.fsPath} to the window`);
  }
  await landed;
}

/** @param {any} document @param {any} anchor */
function locate(document, anchor) {
  const text = document.getText();
  const needle = anchor.after ?? anchor.on;
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${JSON.stringify(needle)} in ${document.uri.fsPath}`);
  return document.positionAt(anchor.after === undefined ? at + Math.ceil(needle.length / 2) : at + needle.length);
}

/** @param {string} command @param {...any} args */
function ask(command, ...args) {
  return vscode.commands.executeCommand(command, ...args);
}

/* ── Waiting ───────────────────────────────────────────────────────────── */

/**
 * Take `answer` until `enough` accepts it or the patience runs out, and hand back the
 * last one either way, so a failure says what the editor actually said.
 */
async function attempt(answer, enough, patience) {
  const until = Date.now() + patience;
  let found = await answer();
  while (!enough(found) && Date.now() < until) {
    await new Promise((done) => setTimeout(done, 250));
    found = await answer();
  }
  return found;
}

/** @param {string} text @param {any} expect */
function matches(text, expect) {
  if (expect.empty === true) return text.trim() === '';
  return (
    (expect.includes ?? []).every((wanted) => text.includes(wanted)) &&
    (expect.excludes ?? []).every((refused) => !text.includes(refused))
  );
}

/** @param {string} text @param {any} expect @param {string} what */
function verdict(text, expect, what) {
  if (matches(text, expect)) return null;
  if (expect.empty === true) return `${what}, and none was expected`;
  const missing = (expect.includes ?? []).filter((wanted) => !text.includes(wanted));
  const present = (expect.excludes ?? []).filter((refused) => text.includes(refused));
  return [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    present.length > 0 ? `offered ${present.join(', ')}` : '',
    `(${what})`,
  ]
    .filter(Boolean)
    .join('; ');
}

function describe(cause) {
  return cause instanceof Error ? `${cause.message}` : String(cause);
}

module.exports = { run };
