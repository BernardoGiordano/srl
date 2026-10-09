/**
 * The application stylesheet, inlined into the page for the Tailwind browser compiler.
 *
 * Development compiles Tailwind in the page from `<style type="text/tailwindcss">`
 * blocks, and that compiler cannot follow an `@import` to a file. The build compiles
 * `src/app.css` with the Tailwind CLI. Without this module an application writes its
 * theme, custom variants and base rules twice, once in each place, and the two drift.
 *
 *   <style type="text/tailwindcss" data-source="src/app.css"></style>
 *
 * The development server fills an empty block that names a stylesheet in the
 * application with that stylesheet, on the way out. The file on disk keeps the empty
 * block, and the build removes it as it removes every Tailwind input block. ADR-0137.
 *
 * What the browser compiler cannot read is rewritten, and nothing else is.
 *
 *   `@import 'tailwindcss' …`  is dropped. The compiler adds it to an input with no
 *                              import, and Chrome's preload scanner would otherwise
 *                              request `/tailwindcss` from the raw block.
 *   `@import './x.css'`        inlines the file, when it is inside the application.
 *   any other import           is dropped. index.html links the library's sheets.
 *   `@source 'path'`           is dropped, because the compiler scans the page.
 *
 * Zero dependencies, like the rest of `cli/dev/`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** An empty Tailwind input block. Group 1 holds its attributes. */
const BLOCK = /<style\b([^>]*\btype=(["'])text\/tailwindcss\2[^>]*)>\s*<\/style>/giu;

/** The stylesheet a block names, relative to the application directory. */
const SOURCE = /\bdata-source=(["'])([^"']+)\1/u;

/** One `@import` statement. Group 2 is the specifier. */
const IMPORT = /@import\s+(["'])([^"']+)\1[^;]*;/gu;

/** An `@source` that names a path. `@source inline(…)` adds classes and stays. */
const SOURCE_PATH = /^[ \t]*@source\s+(?:not\s+)?(["'])[^"']*\1[^;]*;[ \t]*\n?/gmu;

/**
 * The entry document with every named Tailwind block filled, or `null` when it names
 * none, so the caller can serve the file unchanged.
 *
 * @param {string} html
 * @param {string} appDir
 * @returns {Promise<string | null>}
 */
export async function inlineTailwindSource(html, appDir) {
  const blocks = [...html.matchAll(BLOCK)].filter((match) => SOURCE.test(match[1] ?? ''));
  if (blocks.length === 0) return null;

  let out = '';
  let last = 0;
  for (const block of blocks) {
    const attributes = block[1] ?? '';
    const named = SOURCE.exec(attributes)?.[2] ?? '';
    const css = await stylesheet(inside(appDir, join(appDir, named.replace(/^\/+/u, ''))), appDir, new Set());
    out += `${html.slice(last, block.index)}<style${attributes}>\n${css.replace(/<\/style/giu, '<\\/style')}\n</style>`;
    last = block.index + block[0].length;
  }
  return out + html.slice(last);
}

/**
 * One stylesheet with its in-application imports inlined.
 *
 * @param {string} file
 * @param {string} appDir
 * @param {Set<string>} seen Files already on the import path, so a cycle stops.
 * @returns {Promise<string>}
 */
async function stylesheet(file, appDir, seen) {
  if (seen.has(file)) return `/* ${relative(appDir, file)} is already inlined above. */`;
  const source = await readFile(file, 'utf8');
  const next = new Set(seen).add(file);

  /** @type {string[]} */
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(IMPORT)) {
    parts.push(source.slice(last, match.index));
    last = match.index + match[0].length;
    const specifier = match[2] ?? '';

    if (specifier === 'tailwindcss') continue;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = resolve(dirname(file), specifier);
      if (within(appDir, target)) {
        parts.push(await stylesheet(target, appDir, next));
        continue;
      }
    }
    parts.push(`/* ${specifier} is not inlined in development. index.html links what the page needs. */`);
  }
  parts.push(source.slice(last));
  return parts.join('').replace(SOURCE_PATH, '');
}

/**
 * @param {string} appDir
 * @param {string} file
 * @returns {string}
 */
function inside(appDir, file) {
  if (!within(appDir, file)) {
    throw new Error(`data-source names ${file}, which is outside the application ${appDir}.`);
  }
  return file;
}

/**
 * @param {string} dir
 * @param {string} file
 * @returns {boolean}
 */
function within(dir, file) {
  const path = relative(dir, file);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}
