/**
 * Collapse every `.html` template one application can reach into one
 * templates.json.
 *
 * Optional, and it is worth being precise about what it does and does not do.
 *
 * It compiles nothing. The runtime compiler in
 * source/lib/core/template/template.js is the only compiler, in development and in
 * production, and it runs over the same bytes either way. This cannot change how a
 * template renders, which is what makes it safe to skip. With templates.json absent
 * the application fetches each `.html` individually and behaves identically.
 *
 * What it does is turn N requests into one. Twelve templates over HTTP/2 on a fast
 * connection is not worth optimising. Twelve over a high-latency link, or a hundred
 * in a real application, is.
 *
 * This is the path for a deployment with no build step. `srl build` does not use it,
 * because an artifact emits one minified, immutable file per template and lets each
 * component fetch its own (ADR-0081), and `--templates bundle` is where the
 * one-request trade lives there. Nothing here minifies, because nothing here
 * verifies, and the proof that makes minification safe is the build's (ADR-0070).
 *
 *   node cli/delivery/bundle-templates.mjs [--app example]
 *
 * Then set `"templateBundle": "/templates.json"` in that application's
 * app.manifest.json. Its main.js seeds the template cache from it before the first
 * component loads.
 *
 * It is per application because the keys are the URLs the browser will ask for, and
 * only an application knows where every file is mounted. ADR-0042.
 *
 * Zero dependencies. Re-run it when a template changes. It is idempotent and takes a
 * few milliseconds.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { selectedApp } from '../layout.mjs';
import { readProject, shippedTemplates } from '../project-model/index.mjs';

const app = await selectedApp();
const OUTPUT = join(app.dir, 'templates.json');

/**
 * Which templates an application ships is a project fact, not a directory listing:
 * cli/project-model/ owns the rule and the verifier's staleness check reads the same
 * list. ADR-0042.
 *
 * Keys are the URLs `new URL('./x.html', import.meta.url)` resolves to once served, which
 * is what seedTemplates resolves against document.baseURI to match. The model builds them
 * with the same mount table the dev server and the deployment use, so a shared
 * component's template is keyed /components/… and not by its path on disk.
 */
const model = await readProject(app);

/** @type {Record<string, string>} */
const bundle = {};
let bytes = 0;

for (const template of shippedTemplates(model)) {
  const url = String(template.url);
  const contents = await readFile(template.path, 'utf8');
  bundle[url] = contents;
  bytes += Buffer.byteLength(contents);
  console.log(
    '  %s %s bytes%s',
    url.padEnd(52),
    String(Buffer.byteLength(contents)).padStart(6),
    template.claimedBy === null ? '  (claimed by no definition)' : '',
  );
}

const count = Object.keys(bundle).length;
if (count === 0) {
  console.error('No .html templates found for %s.', app.name);
  process.exit(1);
}

await writeFile(OUTPUT, `${JSON.stringify(bundle)}\n`);
console.log(
  '\n  %d template(s), %d bytes of markup -> %s/templates.json\n' +
    '  Set "templateBundle": "/templates.json" in %s/app.manifest.json to use it.',
  count,
  bytes,
  app.name,
  app.name,
);
