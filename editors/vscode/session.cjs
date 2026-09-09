'use strict';

/**
 * The srl language sessions of one VS Code window.
 *
 * A session is one workspace folder's client, the resources that live exactly as long as
 * it, and the settings that decide how it starts. That used to be spread across activate,
 * start and stop: a file watcher created beside the client and disposed only when the
 * client failed to start, a restart that raced its own stop, and a trace setting the
 * client never read because its id did not match the contributed key. Callers now say
 * start, stop or restart, and hold no cleanup knowledge of their own. ADR-0094.
 *
 * Everything the editor supplies is injected, so the lifecycle can be driven by a test
 * without VS Code running: `vscode` for windows and configuration, `createClient` for the
 * language client, and `locate` for what a folder offers.
 */
class SrlSessions {
  /** @type {any} */
  #vscode;
  /** @type {(options: any) => any} */
  #createClient;
  /** @type {(root: string) => { server: string | null, declared: boolean }} */
  #locate;
  /** Running clients, by workspace-folder key. @type {Map<string, any>} */
  #clients = new Map();
  /** One task at a time per folder, so a start cannot overtake its own stop. @type {Map<string, Promise<void>>} */
  #work = new Map();

  /**
   * @param {object} dependencies
   * @param {any} dependencies.vscode
   * @param {(options: any) => any} dependencies.createClient
   * @param {(root: string) => { server: string | null, declared: boolean }} dependencies.locate
   */
  constructor({ vscode, createClient, locate }) {
    this.#vscode = vscode;
    this.#createClient = createClient;
    this.#locate = locate;
  }

  /** The folders currently served. @returns {string[]} */
  get keys() {
    return [...this.#clients.keys()];
  }

  /**
   * Serve one workspace folder. A folder already served, or holding no srl toolchain, is
   * left alone; a folder whose project asked for srl and has none installed is reported,
   * because that is the one case its owner can fix.
   *
   * @param {any} folder
   * @returns {Promise<'running' | 'absent' | 'reported'>} What the folder was told, so a
   *   caller reporting on the window as a whole does not say it twice.
   */
  start(folder) {
    const key = String(folder.uri.toString());
    return this.#queue(key, async () => {
      if (this.#clients.has(key)) return 'running';
      const root = String(folder.uri.fsPath);
      const { server, declared } = this.#locate(root);
      if (server === null) {
        if (!declared) return 'absent';
        this.#vscode.window.showWarningMessage(
          `srl language server not found in ${folder.name}. Install the project's ` +
            'dependencies, then run "srl: Restart Language Server".',
        );
        return 'reported';
      }
      const client = this.#createClient(this.#options(folder, root, server));
      this.#clients.set(key, client);
      try {
        await client.start();
        return 'running';
      } catch (cause) {
        this.#clients.delete(key);
        this.#vscode.window.showErrorMessage(
          `srl language server failed for ${folder.name}: ${describe(cause)}`,
        );
        return 'reported';
      }
    });
  }

  /**
   * Stop one folder's session and release everything it owns. The client disposes the
   * watchers it registered for the server, so stopping is the whole of the cleanup.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  stop(key) {
    return this.#queue(key, async () => {
      const client = this.#clients.get(key);
      if (client === undefined) return;
      this.#clients.delete(key);
      try {
        await client.stop();
      } catch (cause) {
        this.#vscode.window.showErrorMessage(
          `srl language server did not stop cleanly: ${describe(cause)}`,
        );
      }
    });
  }

  /**
   * Restart every session in the window and pick up folders that gained a toolchain since
   * the last attempt. Sessions for folders that are gone are stopped rather than left
   * running against a directory nobody has open.
   *
   * A restart that leaves the window with nothing running says so, unless a folder has
   * already said something more specific. Restarting used to be the one command that
   * could do nothing at all and report nothing at all.
   *
   * @param {readonly any[]} folders
   * @returns {Promise<void>}
   */
  async restart(folders) {
    const keys = new Set([
      ...this.#clients.keys(),
      ...folders.map((folder) => String(folder.uri.toString())),
    ]);
    await Promise.all([...keys].map((key) => this.stop(key)));
    const outcomes = await Promise.all(folders.map((folder) => this.start(folder)));
    if (this.#clients.size === 0 && !outcomes.includes('reported')) {
      this.#vscode.window.showWarningMessage(
        'No srl language server is running in this window. Open a project that installs @srljs/cli.',
      );
    }
  }

  /**
   * Apply a settings change. `srl.nodePath` chooses the executable the server runs under,
   * which is read when the process is spawned, so the folders it changed for are
   * restarted rather than left running under the previous interpreter.
   *
   * @param {{ affectsConfiguration(section: string, scope?: any): boolean }} event
   * @param {readonly any[]} folders
   * @returns {Promise<void>}
   */
  async configurationChanged(event, folders) {
    const affected = folders.filter((folder) => event.affectsConfiguration('srl.nodePath', folder.uri));
    await Promise.all(
      affected.map(async (folder) => {
        await this.stop(String(folder.uri.toString()));
        await this.start(folder);
      }),
    );
  }

  /** Stop every session. @returns {Promise<void>} */
  async stopAll() {
    await Promise.all(this.keys.map((key) => this.stop(key)));
  }

  /**
   * How one folder's server is started and what it is asked about.
   *
   * The client id is the extension's settings section rather than a per-folder name: a
   * language client reads its trace level from `<id>.trace.server`, so an id of `srl-0`
   * looked for `srl-0.trace.server`, which nothing contributes and nobody can set. The
   * output channel keeps the folder in its name, which is what a multi-root window
   * actually needs to tell two servers apart.
   *
   * No `synchronize.fileEvents` here: the server registers the watchers it needs, scoped
   * to the project it serves, and the client owns and disposes them.
   *
   * The selector's patterns are absolute glob strings rather than `RelativePattern`s. A
   * language client round-trips this selector through the protocol before it registers
   * the editor's providers with it, and a `RelativePattern` does not survive that trip:
   * it converts to `undefined`, which leaves each folder's providers claiming every
   * folder's files. Two srl projects in one window then answered each other's requests —
   * a rename in one edited the other's files. A string is matched against the document's
   * absolute path and comes back as itself. ADR-0097.
   *
   * @param {any} folder
   * @param {string} root
   * @param {string} server
   */
  #options(folder, root, server) {
    const node = this.#vscode.workspace.getConfiguration('srl', folder.uri).get('nodePath', 'node');
    return {
      id: 'srl',
      name: `srl (${folder.name})`,
      serverOptions: {
        command: node,
        args: [server],
        options: { cwd: root, env: { ...process.env, SRL_ROOT: root } },
      },
      clientOptions: {
        documentSelector: [
          { scheme: 'file', language: 'html', pattern: `${within(folder)}/**/*.html` },
          { scheme: 'file', language: 'javascript', pattern: `${within(folder)}/**/*.{js,mjs}` },
        ],
        workspaceFolder: folder,
        outputChannelName: `srl Language Server (${folder.name})`,
      },
    };
  }

  /**
   * Run `task` after whatever this folder was already doing. Start, stop and restart all
   * mutate the same client, and a restart issued while a start is still in flight used to
   * leave the window with a stopped session it believed was running.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  #queue(key, task) {
    const previous = this.#work.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    // The stored chain swallows failures so one folder's error cannot strand the next
    // task queued behind it. The returned promise still carries it to the caller.
    this.#work.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

/**
 * The folder's path as a glob prefix. Separators are `/` on every platform: a glob is
 * matched against the path, and a Windows backslash reads as an escape.
 *
 * @param {any} folder
 * @returns {string}
 */
function within(folder) {
  return String(folder.uri.fsPath).replaceAll('\\', '/');
}

/** @param {unknown} cause */
function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

module.exports = { SrlSessions };
