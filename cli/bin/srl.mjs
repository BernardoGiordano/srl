#!/usr/bin/env node

/**
 * One entry point for the toolchain, so a consumer types `srl build --app web`
 * rather than `node node_modules/@srljs/cli/delivery/build.mjs --app web`.
 *
 * A dispatcher and nothing else. Every tool below owns its own argument parsing and
 * its own exit codes, and each is still runnable by path, so this file adds a name
 * rather than a layer. A subcommand that grew flag handling here would be a second
 * parser to keep in step with the first.
 *
 * The dispatch is an `import()` rather than a spawn, so there is one process, no
 * second Node startup, and an error keeps the stack of the tool that threw. The line
 * below rewriting `process.argv` is what lets that work. Each tool decides whether
 * to run its command block by comparing `process.argv[1]` against its own path, the
 * standard "am I the program?" test, and under this dispatcher the answer is yes.
 * Nothing is being fooled, because the target module is the program being run, and
 * the path handed to it is derived from this file's own URL so that it resolves
 * through the same symlinks the module's `import.meta.url` does.
 */

import { fileURLToPath } from 'node:url';

/**
 * Subcommand -> the module that is the program, relative to `cli/`.
 *
 * Flat. `srl check` is one command, and the words after it name subjects for the check
 * runner to parse, like any other tool's arguments.
 *
 * The vendor refresh and the bundle build are absent on purpose. They act on the
 * library's own committed bytes, are meaningful only inside the srl repository, and
 * are not in this package at all.
 */
const COMMANDS = {
  new: '../scaffold/application.mjs',
  serve: '../dev/serve.mjs',
  build: '../delivery/build.mjs',
  templates: '../delivery/bundle-templates.mjs',
  importmap: '../package/interface.mjs',
  model: '../project-model/index.mjs',
  layout: '../layout.mjs',
  release: '../delivery/release.mjs',
  'remote-release': '../delivery/remote-release.mjs',
  'verify-release': '../delivery/verify-release.mjs',
  'verify-http': '../delivery/verify-http.mjs',
  activate: '../delivery/activate-release.mjs',
  retention: '../delivery/retention.mjs',
  check: '../checks/index.mjs',
  'language-server': '../language-server/server.mjs',
};

const USAGE = `usage: srl <command> [options]

Development
  new <name>                a new application in the repository root: the
                            document with the library's import map pasted and
                            hashed, an entry and a lazy chunk, the stylesheet,
                            the manifest, a locale bundle, and a tsconfig.json
                            extending the published base. Refuses rather than
                            overwrites
  serve [--app <name>] [--port <n>] [--no-watch] [--open]
        [--proxy <prefix>=<origin>]...
                            static server for one application: the library's
                            mounts, history fallback, watch and live reload.
                            --proxy forwards a prefix to a backend instead of
                            serving it from disk, so an application with an API
                            develops on one origin:
                              --proxy /api/=http://127.0.0.1:8001
  model [--app <name>] [--element <tag> | --json]
                            every element, global and template static discovery
                            can see

Checks
  check [<subject>...] [--app <name>] [--json]
                            every check in one process, one report and one exit
                            code. With no subject, all of them:
                              project    element declarations, uses lists,
                                         duplicate tags and stylesheets
                              types      the JavaScript, as tsc --noEmit sees it
                              templates  every template against the same JSDoc
                                         types as the JavaScript
                              importmap  the inline import map against the
                                         installed library: missing or edited
                                         entries, stale hashes, and the
                                         script-src hash a CSP has to allow
                              messages   every message the source names against
                                         the bundles the application ships
                            types and templates need a tsconfig.json at the
                            repository root
  check messages --write    add the unanswered keys to the bundle that should
                            hold them, each holding its key as its message
  check --codes [--json]    every code a check reports, and what it means

  --json prints every finding as one document with severity, code, message,
  file, line and column, instead of a terminal report. The findings and the
  exit code are the same either way

Delivery
  build [--app <name>] [--out <dir>] [--remote <name>]
        [--templates split|bundle]
                            the production artifact: minified, hash-named
                            chunks, a production index.html pinning a sha384
                            for each, and artifact.json describing all of it.
                            Templates are minified and emitted one immutable
                            file each, fetched by the component that needs
                            them; --templates bundle adds the single JSON the
                            manifest seeds from at startup instead
  templates [--app <name>]  the per-application template bundle for a
                            deployment with no build step
  importmap [--write]       print the import-map fragment an application pastes

Release
  release --artifact <dir> --out <dir> --remote-root <path>
  remote-release <prepare | activate | retention> ...
  verify-release <release-dir> <asset-dir>
  verify-http <origin> <artifact.json>
  activate <release-root> <release-id>
  retention <release-root> [--apply]

Other
  language-server             LSP server over stdio, used by VS Code, WebStorm and
                              any editor with a generic LSP client
  layout [--deploy-pairs | --apps]
                            the mount table and the application list, for a
                            consumer that cannot import

The repository worked on is the working directory. Every command takes
\`--app <name>\`, or reads APP; with one application the flag is optional, with
two it is required, because a tool that picks one deploys the wrong thing sooner
or later.

Each command is a module and still runnable by path:
  node node_modules/@srljs/cli/delivery/build.mjs --app web
`;

const [first] = process.argv.slice(2);

if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
  process.stdout.write(USAGE);
  process.exit(first === undefined ? 1 : 0);
}

if (first === '--version' || first === '-v') {
  const manifest = await import('../package.json', { with: { type: 'json' } });
  process.stdout.write(`${manifest.default.version}\n`);
  process.exit(0);
}

const target = COMMANDS[/** @type {keyof typeof COMMANDS} */ (first)];

if (target === undefined) {
  const known = Object.keys(COMMANDS).join(', ');
  process.stderr.write(
    `srl: unknown command "${first}". Known commands: ${known}.\nRun \`srl --help\`.\n`,
  );
  process.exit(1);
}

const module = fileURLToPath(new URL(target, import.meta.url));
process.argv = [process.argv[0] ?? process.execPath, module, ...process.argv.slice(3)];
await import(module);
