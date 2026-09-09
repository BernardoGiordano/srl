/**
 * The generated-block machinery every documentation check shares.
 *
 *   <!-- generated:elements -->  … <!-- /generated:elements -->
 *
 * A page carries hand-written prose and, between markers, blocks a tool owns. The rule
 * is the same wherever it is used: prose is written, blocks are derived, and a block that
 * no longer matches what its generator produces is drift rather than a difference of
 * opinion. Two tools now own blocks — the project index and the performance guide — and
 * the marker grammar has to mean one thing on both pages, so it lives here rather than in
 * whichever check needed it first.
 *
 * WHAT IT REFUSES
 *
 * A missing marker, a duplicate marker, an unterminated block, and a generated name the
 * calling tool does not produce. All four mean the document and its generator disagree
 * about what is generated, which is the failure this exists to make loud.
 *
 * Every refusal is a `Diagnostic`, never printed here: reporting belongs to the calling
 * tool through cli/diagnostics, so a suite can assert which marker was wrong rather than
 * that something was. ADR-0072.
 */

import { error, info } from '../../cli/diagnostics/index.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */

const OPEN = /<!-- generated:([a-z-]+) -->/gu;

/**
 * Split a document into its generated blocks.
 *
 * A marker this cannot make sense of is a diagnostic rather than a throw, and the
 * blocks it did read are still returned: a document with two broken markers should
 * report both in one run.
 *
 * @param {string} text
 * @param {string} where
 * @returns {{ found: Array<{ name: string, start: number, end: number, body: string }>, diagnostics: Diagnostic[] }}
 */
export function blocks(text, where) {
  /** @type {Array<{ name: string, start: number, end: number, body: string }>} */
  const found = [];
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const seen = new Set();
  OPEN.lastIndex = 0;
  for (let match = OPEN.exec(text); match !== null; match = OPEN.exec(text)) {
    const name = match[1] ?? '';
    if (seen.has(name)) {
      diagnostics.push(
        error('docs/duplicate-marker', `<!-- generated:${name} --> appears twice.`, { file: where }),
      );
      continue;
    }
    seen.add(name);
    const close = `<!-- /generated:${name} -->`;
    const end = text.indexOf(close, match.index);
    if (end === -1) {
      diagnostics.push(
        error('docs/unterminated-marker', `<!-- generated:${name} --> is never closed.`, {
          file: where,
        }),
      );
      continue;
    }
    found.push({
      name,
      start: match.index + match[0].length,
      end,
      body: text.slice(match.index + match[0].length, end).trim(),
    });
  }
  return { found, diagnostics };
}

/**
 * Hold a document against the blocks its generator produces.
 *
 * @param {string} text
 * @param {Map<string, string>} expected
 * @param {{ file: string, write: boolean, command: string }} options
 * @returns {{ out: string | null, drifted: string[], diagnostics: Diagnostic[] }}
 */
export function rewriteGenerated(text, expected, options) {
  const where = options.file;
  const { found: present, diagnostics } = blocks(text, where);

  for (const block of present) {
    if (!expected.has(block.name)) {
      diagnostics.push(
        error(
          'docs/unknown-section',
          `<!-- generated:${block.name} --> is not a section this tool generates.`,
          { file: where },
        ),
      );
    }
  }
  for (const name of expected.keys()) {
    if (!present.some((block) => block.name === name)) {
      diagnostics.push(
        error(
          'docs/missing-marker',
          `no <!-- generated:${name} --> block. Add the markers where the table belongs.`,
          { file: where },
        ),
      );
    }
  }

  // A document whose markers do not describe the sections its tool owns cannot be
  // rewritten into one that does, so nothing is returned to write.
  if (diagnostics.length > 0) return { out: null, drifted: [], diagnostics };

  let out = text;
  /** @type {string[]} */
  const drifted = [];
  // Backwards, so an earlier replacement cannot move a later block's offsets.
  for (const block of [...present].reverse()) {
    const body = /** @type {string} */ (expected.get(block.name));
    if (body !== block.body) drifted.push(block.name);
    out = `${out.slice(0, block.start)}\n\n${body}\n\n${out.slice(block.end)}`;
  }
  drifted.reverse();

  if (drifted.length === 0) {
    diagnostics.push(info('docs/current', 'generated sections are current', { file: where }));
  } else if (options.write) {
    diagnostics.push(info('docs/rewritten', `rewrote ${drifted.join(', ')}`, { file: where }));
  } else {
    diagnostics.push(
      error(
        'docs/generated-drift',
        `${drifted.join(', ')} no longer match what generates them.\n` +
          `    Run \`${options.command}\` and commit the result.`,
        { file: where },
      ),
    );
  }

  return { out, drifted, diagnostics };
}

/**
 * A markdown table, header row included.
 *
 * @param {string[]} head
 * @param {string[][]} rows
 * @returns {string}
 */
export function table(head, rows) {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}
