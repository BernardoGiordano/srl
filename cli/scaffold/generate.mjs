/**
 * Add to the current project.
 *
 *   srl generate app <name> [--json]
 *   srl generate component <[dir/]tag> [--app <name>] [--styles] [--json]
 *   srl g c <[dir/]tag> ...
 *
 * `srl new` writes a whole project. This command adds one application or one
 * component to a project that exists, and refuses to overwrite anything. ADR-0122.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { error, outputFormat, report } from '../diagnostics/index.mjs';
import { REPO, selectedApp } from '../layout.mjs';
import { emitApplication } from './application.mjs';
import { componentClassName, emitComponent } from './component.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

const KINDS = ['app', 'component'];

/** Short kind names, as in Angular's `ng g c`. */
const KIND_ALIASES = { c: 'component' };

/**
 * The words that are not flags or flag values.
 *
 * @param {readonly string[]} args
 * @returns {string[]}
 */
function positionals(args) {
  return args.filter(
    (argument, index) => !argument.startsWith('-') && args[index - 1] !== '--app',
  );
}

/**
 * Run one command line against the project root, and return what it found with the
 * summary to print.
 *
 * @param {readonly string[]} args the words after `generate`
 * @returns {Promise<{ found: Diagnostic[], summary?: string }>}
 */
async function generate(args) {
  const [written, name] = positionals(args);
  const kind =
    written !== undefined && Object.hasOwn(KIND_ALIASES, written)
      ? KIND_ALIASES[/** @type {keyof typeof KIND_ALIASES} */ (written)]
      : written;

  if (kind === 'app') {
    return {
      found: await emitApplication(REPO, { name }),
      summary: `An application. \`npx --no-install srl serve --app ${name ?? '<name>'}\` runs it.`,
    };
  }

  if (kind === 'component') {
    /** @type {{ name: string, dir: string }} */
    let app;
    try {
      app = await selectedApp();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { found: [error('scaffold/no-application', message)] };
    }
    const tag = name?.split('/').pop() ?? '';
    return {
      found: await emitComponent(REPO, { app, path: name, styles: args.includes('--styles') }),
      summary:
        `A component. A template that names <${tag}> imports \`${componentClassName(tag)}\` ` +
        `and lists it in \`uses\`.`,
    };
  }

  return {
    found: [
      error(
        'scaffold/usage',
        `${kind === undefined ? 'Nothing to generate' : `"${kind}" is not something srl generates`}. ` +
          `Kinds: ${KINDS.join(', ')}, or c for component. ` +
          `For example \`srl generate component user-card\`.`,
      ),
    ],
  };
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { found, summary } = await generate(process.argv.slice(2));
  process.exit(report(found, { format: outputFormat(), summary }));
}
