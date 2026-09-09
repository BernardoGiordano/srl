'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SrlSessions } = require('../session.cjs');

test('a session owns its client, its settings, and its own restart', async (context) => {
  await context.test('starts one client per folder under the contributed settings section', async () => {
    const world = build();
    await world.sessions.start(folder('app'));

    assert.equal(world.created.length, 1);
    const [created] = world.created;
    // `<id>.trace.server` is the key a language client reads, and `srl.trace.server` is
    // the key the package contributes. An id of `srl-0` reaches neither.
    assert.equal(created.id, 'srl');
    assert.equal(created.serverOptions.command, 'node');
    assert.deepEqual(created.serverOptions.options.cwd, '/app');
    assert.equal(created.serverOptions.options.env.SRL_ROOT, '/app');
    assert.match(created.clientOptions.outputChannelName, /app/u);
    // Absolute globs, not `RelativePattern`s: the client round-trips this selector
    // through the protocol, which drops a relative pattern and leaves every folder's
    // providers claiming every folder's files. ADR-0097.
    assert.deepEqual(
      created.clientOptions.documentSelector.map((filter) => filter.pattern),
      ['/app/**/*.html', '/app/**/*.{js,mjs}'],
    );
    // The server registers the watchers it needs, scoped to its own project. A second
    // watcher here is the duplicate reload the adapter used to cause.
    assert.equal(created.clientOptions.synchronize, undefined);
    assert.equal(world.sessions.keys.length, 1);
  });

  await context.test('serves a folder once, however many times it is asked', async () => {
    const world = build();
    const folders = [folder('app'), folder('app')];
    await Promise.all(folders.map((one) => world.sessions.start(one)));
    assert.equal(world.created.length, 1);
  });

  await context.test('says nothing about a folder that is not an srl project', async () => {
    const world = build({ locate: () => ({ server: null, declared: false }) });
    await world.sessions.start(folder('notes'));
    assert.deepEqual(world.warnings, []);
    assert.deepEqual(world.errors, []);
    assert.equal(world.created.length, 0);
  });

  await context.test('names the missing toolchain when the project asked for srl', async () => {
    const world = build({ locate: () => ({ server: null, declared: true }) });
    await world.sessions.start(folder('app'));
    assert.equal(world.warnings.length, 1);
    assert.match(world.warnings[0] ?? '', /Restart Language Server/u);
    assert.equal(world.created.length, 0);
  });

  await context.test('reports a failed start and keeps no session for it', async () => {
    const world = build({ failStart: true });
    await world.sessions.start(folder('app'));
    assert.equal(world.errors.length, 1);
    assert.match(world.errors[0] ?? '', /node is not on PATH/u);
    assert.deepEqual(world.sessions.keys, []);

    world.failStart = false;
    await world.sessions.start(folder('app'));
    assert.equal(world.created.length, 2);
    assert.equal(world.sessions.keys.length, 1);
  });

  await context.test('stopping is the whole of the cleanup', async () => {
    const world = build();
    const one = folder('app');
    await world.sessions.start(one);
    await world.sessions.stop(one.uri.toString());
    assert.deepEqual(world.sessions.keys, []);
    assert.deepEqual(world.log, ['start app', 'stop app']);

    // A folder with no session left is not an error, and must not stop a client twice.
    await world.sessions.stop(one.uri.toString());
    assert.deepEqual(world.log, ['start app', 'stop app']);
  });

  await context.test('a restart never overlaps its own stop', async () => {
    const world = build();
    const folders = [folder('app'), folder('site')];
    await Promise.all(folders.map((one) => world.sessions.start(one)));
    await world.sessions.restart(folders);

    assert.equal(world.created.length, 4);
    assert.equal(world.sessions.keys.length, 2);
    assert.deepEqual(world.log.filter((entry) => entry.endsWith('app')), [
      'start app',
      'stop app',
      'start app',
    ]);
  });

  await context.test('a restart that leaves nothing running says so once', async () => {
    const world = build({ locate: () => ({ server: null, declared: false }) });
    await world.sessions.restart([folder('notes')]);
    assert.deepEqual(world.warnings, [
      'No srl language server is running in this window. Open a project that installs @srljs/cli.',
    ]);

    // A folder that already got the specific message is not told the general one too.
    const declared = build({ locate: () => ({ server: null, declared: true }) });
    await declared.sessions.restart([folder('app')]);
    assert.equal(declared.warnings.length, 1);
    assert.match(declared.warnings[0] ?? '', /not found in app/u);
  });

  await context.test('a restart picks up a folder that gained a toolchain', async () => {
    let server = null;
    const world = build({ locate: () => ({ server, declared: true }) });
    const one = folder('app');
    await world.sessions.start(one);
    assert.deepEqual(world.sessions.keys, []);

    server = '/app/node_modules/@srljs/cli/language-server/server.mjs';
    await world.sessions.restart([one]);
    assert.equal(world.sessions.keys.length, 1);
    assert.equal(world.warnings.length, 1, 'the second attempt repeated the first warning');
  });

  await context.test('a restart stops a session whose folder is gone', async () => {
    const world = build();
    const folders = [folder('app'), folder('site')];
    await Promise.all(folders.map((one) => world.sessions.start(one)));
    await world.sessions.restart([folders[0]]);
    assert.deepEqual(world.sessions.keys, ['file:///app']);
    assert.deepEqual(world.log.filter((entry) => entry.endsWith('site')), ['start site', 'stop site']);
  });

  await context.test('a node path change restarts only the folder it changed for', async () => {
    const world = build();
    const folders = [folder('app'), folder('site')];
    await Promise.all(folders.map((one) => world.sessions.start(one)));

    await world.sessions.configurationChanged(
      { affectsConfiguration: (section, scope) => section === 'srl.nodePath' && scope.fsPath === '/app' },
      folders,
    );
    assert.deepEqual(world.log.filter((entry) => entry.endsWith('site')), ['start site']);
    assert.deepEqual(world.log.filter((entry) => entry.endsWith('app')), [
      'start app',
      'stop app',
      'start app',
    ]);
  });

  await context.test('an unrelated settings change starts and stops nothing', async () => {
    const world = build();
    const one = folder('app');
    await world.sessions.start(one);
    await world.sessions.configurationChanged({ affectsConfiguration: () => false }, [one]);
    assert.deepEqual(world.log, ['start app']);
  });

  await context.test('stopAll leaves the window with no session', async () => {
    const world = build();
    const folders = [folder('app'), folder('site')];
    await Promise.all(folders.map((one) => world.sessions.start(one)));
    await world.sessions.stopAll();
    assert.deepEqual(world.sessions.keys, []);
    assert.equal(world.log.filter((entry) => entry.startsWith('stop')).length, 2);
  });
});

/** @param {string} name */
function folder(name) {
  const uri = `file:///${name}`;
  return { index: 0, name, uri: { toString: () => uri, fsPath: `/${name}` } };
}

/**
 * A window the sessions can run in: the pieces of VS Code they touch, a client that
 * records its own lifecycle, and the answers `locate` gives.
 *
 * @param {{ locate?: () => { server: string | null, declared: boolean }, failStart?: boolean }} [options]
 */
function build(options = {}) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const created = [];
  const world = {
    warnings,
    errors,
    log,
    created,
    failStart: options.failStart === true,
    /** @type {any} */
    sessions: null,
  };

  const vscode = {
    window: {
      /** @param {string} text */
      showWarningMessage: (text) => warnings.push(text),
      /** @param {string} text */
      showErrorMessage: (text) => errors.push(text),
    },
    workspace: {
      getConfiguration: () => ({
        /** @param {string} _key @param {string} fallback */
        get: (_key, fallback) => fallback,
      }),
    },
    RelativePattern: class {
      /** @param {any} base @param {string} pattern */
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
  };

  world.sessions = new SrlSessions({
    vscode,
    locate:
      options.locate ??
      (() => ({ server: '/app/node_modules/@srljs/cli/language-server/server.mjs', declared: true })),
    /** @param {any} clientOptions */
    createClient: (clientOptions) => {
      created.push(clientOptions);
      const name = String(clientOptions.clientOptions.workspaceFolder.name);
      return {
        start: () => {
          if (world.failStart) return Promise.reject(new Error('node is not on PATH'));
          log.push(`start ${name}`);
          return Promise.resolve();
        },
        stop: () => {
          log.push(`stop ${name}`);
          return Promise.resolve();
        },
      };
    },
  });
  return world;
}
