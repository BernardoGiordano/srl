/**
 * Turn an application's index.html into its production form, on stdout.
 *
 *   node tools/delivery/production-html.mjs application > staged/index.html
 *
 * Every index.html in this repository ships in development mode: Tailwind v4 is
 * loaded as a browser script and compiles the stylesheet from a MutationObserver
 * on every page load, and the <link> to the compiled app.css sits commented out
 * beside it. That is the right default for a clone and the wrong thing to serve —
 * it costs every visitor a build the CLI already did, and it rules out the
 * Content-Security-Policy the deployed config carries. ADR-0041.
 *
 * A transform at deploy time rather than an edit before it, so neither state
 * depends on remembering. Both substitutions are required and each is asserted:
 * dropping the JIT without linking app.css renders a page with no stylesheet,
 * which answers HTTP 200 and is unusable, so a miss exits non-zero.
 *
 * The import map is deliberately not touched. Its exact text is hashed into the
 * deployed CSP, so a transform that reformatted it — even by a space — would block
 * the map and take module resolution down with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const app = process.argv[2];
if (app === undefined || app === '') {
  process.stderr.write('Usage: node tools/delivery/production-html.mjs <app>\n');
  process.exit(2);
}

const source = join(REPO, app, 'index.html');
let html = readFileSync(source, 'utf8');

/**
 * Replace once, and fail if the pattern did not match.
 *
 * @param {RegExp} pattern
 * @param {string} replacement
 * @param {string} what What the caller was trying to do, for the error.
 */
function edit(pattern, replacement, what) {
  const next = html.replace(pattern, replacement);
  if (next === html) {
    process.stderr.write(
      `production-html: could not ${what} in ${app}/index.html.\n` +
        `    The tag this rewrites has moved or changed shape. Serving the file unedited\n` +
        `    would deploy either the browser JIT or no stylesheet at all, so this stops.\n`,
    );
    process.exit(1);
  }
  html = next;
}

// 1. Drop the Tailwind browser JIT. Written across several lines in every
//    application, hence [\s\S] rather than . — and anchored on the src, so a
//    different vendored script on either side of it is left alone.
edit(
  /^[ \t]*<script\s+src="\/lib\/vendor\/tailwind-browser\.js"[\s\S]*?<\/script>\n/mu,
  '',
  'remove the Tailwind browser script',
);

// 2. Link the compiled stylesheet, by uncommenting the line that is already
//    there. `npm run css:space` writes it; deploy-space.sh runs that first.
edit(
  /<!--\s*(<link rel="stylesheet" href="\/app\.css"\s*\/>)\s*-->/u,
  '$1',
  'uncomment the app.css stylesheet link',
);

/*
 * Left in place on purpose: the <style type="text/tailwindcss"> block.
 *
 * Without the JIT loaded no parser claims that type, so the browser ignores it
 * whole — it is inert rather than wrong. Its content is duplicated in src/app.css
 * and therefore already inside the compiled app.css, so removing it would save a
 * couple of kilobytes on the wire and cost a third regex over a hand-edited file.
 * Not a trade worth making for bytes that gzip to nearly nothing.
 */

process.stdout.write(html);
