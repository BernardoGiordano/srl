'use strict';

/**
 * Own one language client per VS Code workspace folder. Dependencies are injected
 * so tests can drive the lifecycle without opening VS Code.
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
/** Serialize lifecycle tasks per folder. @type {Map<string, Promise<void>>} */
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
   * Start a folder's server or report its missing declared toolchain.
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
   * Stop a folder's client and release its watchers.
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
   * Restart open folders, stop removed ones, and check for newly installed tools.
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
   * Restart affected folders when their Node executable setting changes.
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
   * Start one folder's language client. Use the `srl` id for trace settings and a
   * folder-specific output channel. Absolute glob strings keep multi-root document
   * selectors scoped to their own folders after protocol conversion.
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
   * Run lifecycle tasks in order for one folder.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  #queue(key, task) {
    const previous = this.#work.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    // Keep the queue moving while returning failures to callers.
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
 * Turn a folder path into a glob prefix with forward slashes.
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
