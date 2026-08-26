#!/usr/bin/env node

/**
 * One entry point for the toolchain, so a consumer types `srl build --app web`
 * rather than `node node_modules/@srljs/cli/delivery/build.mjs --app web`.
 *
 * A dispatcher and nothing else. Every tool below already owns its own argument
 * parsing and its own exit codes, and each is still runnable by path — this file
 * adds a name, not a layer. A subcommand that grew flag handling here would be a
 * second parser to keep in step with the first.
 *
 * The dispatch is an `import()`, not a spawn: one process, no second Node startup,
 * and an error keeps the stack of the tool that threw. What makes that work is the
 * line below rewriting `process.argv` — each tool decides whether to run its
 * command block by comparing `process.argv[1]` against its own path, which is the
 * standard "am I the program?" test, and under this dispatcher the answer is yes.
 * Nothing is being fooled: the target module *is* the program being run, and the
 * path handed to it is derived from this file's own URL so that it resolves through
 * the same symlinks the module's `import.meta.url` does.
 */

import { fileURLToPath } from 'node:url';

/**
 * Subcommand -> the module that is the program, relative to `cli/`.
 *
 * Flat rather than grouped, with `check` the one exception: the two checks are a
 * pair a repository runs together in CI and neither is a verb on its own.
 *
 * Absent on purpose: the vendor refresh and the bundle build. Those act on the
 * library's own committed bytes, are meaningful only inside the srl repository, and
 * are not in this package at all.
 */
const COMMANDS = {
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
  'check templates': '../checks/template-check.mjs',
  'check importmap': '../checks/importmap-check.mjs',
};

const USAGE = `usage: srl <command> [options]

Development
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
  check importmap [--app <name>]
                            an application's inline import map against the
                            installed library: missing entries, hand-edited
                            ones, hashes that no longer match their bytes, and
                            the script-src hash a CSP has to allow
  check templates           type-check every template against the same JSDoc
                            types as the JavaScript. Needs a tsconfig.json at
                            the repository root

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

const [first, second] = process.argv.slice(2);

if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
  process.stdout.write(USAGE);
  process.exit(first === undefined ? 1 : 0);
}

if (first === '--version' || first === '-v') {
  const manifest = await import('../package.json', { with: { type: 'json' } });
  process.stdout.write(`${manifest.default.version}\n`);
  process.exit(0);
}

// `check` takes a second word, and the pair is one key. Consuming both from argv is
// what lets the tool see the flags it expects and nothing it does not.
const key = first === 'check' ? `check ${second ?? ''}`.trim() : first;
const consumed = first === 'check' ? 2 : 1;
const target = COMMANDS[/** @type {keyof typeof COMMANDS} */ (key)];

if (target === undefined) {
  const known = Object.keys(COMMANDS).join(', ');
  process.stderr.write(
    first === 'check'
      ? `srl check needs a subject: ${second === undefined ? 'none given' : `"${second}"`} is ` +
          `not one. Try \`srl check importmap\` or \`srl check templates\`.\n`
      : `srl: unknown command "${first}". Known commands: ${known}.\nRun \`srl --help\`.\n`,
  );
  process.exit(1);
}

const module = fileURLToPath(new URL(target, import.meta.url));
process.argv = [process.argv[0] ?? process.execPath, module, ...process.argv.slice(2 + consumed)];
await import(module);
