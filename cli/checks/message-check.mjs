/**
 * Every message an application's source names, against the bundles it ships.
 *
 *   node cli/checks/message-check.mjs [--app <name>] [--json] [--write]
 *
 * Two failures, and both reach a user rather than a build:
 *
 *  1. A reference nothing answers. `t('orders.titel')` renders `orders.titel` in the
 *     page, in every language, and every catalog-against-catalog comparison passes: the
 *     translations agree with each other perfectly, and none of them has the key the
 *     source asked for.
 *  2. A placeholder a call does not fill. `{name}` is kept verbatim when no parameter
 *     matches it, so the sentence ships with a brace in it.
 *
 * Reported and not refused: a catalog entry no source names, a computed key and the
 * family it claims, and how much of each locale is translated. A key may be one release
 * ahead of the screen that will show it, and a catalog is also written by hand.
 *
 * `--write` adds the unanswered keys to the default-locale bundle that should hold them,
 * with the key as the message, and leaves every existing line alone. It is an authoring
 * step rather than a fix: the entry exists, the sentence is still somebody's to write.
 *
 * Nothing here interprets a catalog. cli/message-catalog/ owns what a key is, which
 * bundle answers for a file and what a reference resolves to, so this check, the
 * repository verifier and the editor agree by construction rather than by review.
 * ADR-0117.
 */

import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { error, info, outputFormat, report } from '../diagnostics/index.mjs';
import { REPO, apps, selectedApp } from '../layout.mjs';
import {
  messageFindings,
  missingMessages,
  readMessages,
  writeMissingMessages,
} from '../message-catalog/index.mjs';
import { readProject } from '../project-model/index.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

/** @param {string} path */
function show(path) {
  return relative(REPO, path).split(sep).join('/');
}

/**
 * One application, or all of them. `--app` is the same flag every other tool takes and
 * cli/layout.mjs is what reads it.
 *
 * @returns {Promise<{ selected: Array<{ name: string, dir: string }>, diagnostics: Diagnostic[] }>}
 */
async function selection() {
  if (process.argv.includes('--app')) return { selected: [await selectedApp()], diagnostics: [] };
  const all = await apps();
  if (all.length > 0) return { selected: all, diagnostics: [] };
  return {
    selected: [],
    diagnostics: [
      error(
        'messages/no-application',
        `No application with an index.html was found in ${show(REPO)}. An application is any ` +
          `directory in the repository root with an index.html; if this repository keeps its own ` +
          `elsewhere, point SRL_ROOT at the root that holds them.`,
      ),
    ],
  };
}

/**
 * Check every selected application's messages.
 *
 * @param {{ write?: boolean }} [options] `write` adds unanswered keys to the bundle that
 *   should hold them before reporting, so the run says what it wrote rather than what it
 *   would have written.
 * @returns {Promise<Diagnostic[]>}
 */
export async function checkMessages(options = {}) {
  const { selected, diagnostics } = await selection();
  /** @type {Diagnostic[]} */
  const found = [...diagnostics];

  for (const app of selected) {
    const model = await readProject(app);
    let messages = await readMessages(app, model);

    if (options.write === true) {
      const written = await writeMissingMessages(messages);
      for (const bundle of written) {
        found.push(
          info(
            'messages/written',
            `${show(bundle.path)} gained ${String(bundle.added.length)} key(s):\n      ` +
              `${bundle.added.join('\n      ')}\n` +
              `    Each one holds its key as its message. Write the sentence, then translate it.`,
            { group: app.name, file: bundle.path },
          ),
        );
      }
      if (written.length > 0) messages = await readMessages(app, model);
    }

    for (const { bundle, conflicts } of missingMessages(messages)) {
      if (conflicts.length === 0) continue;
      found.push(
        error(
          'messages/occupied-key',
          `${String(conflicts.length)} key(s) cannot be written into this bundle, because a ` +
            `message already stands where their parent would go:\n      ` +
            `${conflicts.join('\n      ')}\n` +
            `    Rename one of the two: a key is either a message or a group of them.`,
          { group: app.name, file: bundle.defaultPath },
        ),
      );
    }

    found.push(...messageFindings(messages));
  }

  return found;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exit(
    report(await checkMessages({ write: process.argv.includes('--write') }), {
      format: outputFormat(),
      summary: 'Every message reference resolves to a key a bundle declares.',
    }),
  );
}
