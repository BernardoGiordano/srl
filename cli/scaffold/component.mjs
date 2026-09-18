/**
 * The shape of a component: a module, its template and, on request, its stylesheet.
 *
 *   srl generate component user-card               <app>/src/components/user-card.js
 *   srl generate component pages/users-page        <app>/src/pages/users-page.js
 *
 * The last segment is the tag. Segments before it are directories under `<app>/src/`,
 * and a bare tag goes to `components/`. ADR-0122.
 *
 *   `componentFiles(facts)`      pure. Path to contents.
 *   `emitComponent(root, …)`    the adapter. It refuses a tag the application already
 *                               defines and any file that exists, then writes.
 */

import { join, relative, sep } from 'node:path';

import { error } from '../diagnostics/index.mjs';
import { readProject } from '../project-model/index.mjs';
import { NAME, writeFiles } from './files.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

/**
 * @typedef {object} ComponentFacts
 * @property {string} dir the component's directory, relative to the project root
 * @property {string} tag
 * @property {boolean} styles whether it gets a stylesheet of its own
 */

/** Where a bare tag goes, under `<app>/src/`. */
const DEFAULT_DIR = 'components';

/** The custom element name rule `defineComponent` enforces, without a trailing hyphen. */
const TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u;

/** Hyphenated names the HTML specification keeps for SVG and MathML. */
const RESERVED_TAGS = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-format',
  'font-face-name',
  'font-face-src',
  'font-face-uri',
  'missing-glyph',
]);

/**
 * The class name for a tag, so `user-card` becomes `UserCard`.
 *
 * @param {string} tag
 * @returns {string}
 */
export function componentClassName(tag) {
  return tag
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/**
 * The component, as paths relative to the project root and the bytes at each.
 *
 * @param {ComponentFacts} facts
 * @returns {Map<string, string>}
 */
export function componentFiles(facts) {
  const { tag } = facts;
  const name = componentClassName(tag);
  const file = /** @param {string} extension @returns {string} */ (extension) =>
    `${facts.dir}/${tag}.${extension}`;

  const module = `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';

/**
 * \`<${tag} label="…">\`. A template that names this tag imports \`${name}\` and lists it
 * in its \`uses\`.
 */
export class ${name} extends SignalElement {
  static properties = {
    label: { type: String },
  };

  label = '';
}

await defineComponent({
  tag: '${tag}',
  element: ${name},
  module: import.meta.url,${facts.styles ? '\n  styles: true,' : ''}
});
`;

  /** @type {Map<string, string>} */
  const files = new Map([
    [file('js'), module],
    [file('html'), `<p>{{ label }}</p>\n`],
  ]);

  // Scoped to this component's markup, with `:host` for the element itself.
  if (facts.styles) files.set(file('css'), `:host {\n  display: block;\n}\n`);
  return files;
}

/**
 * Write a new component into an application, and say what was written.
 *
 * @param {string} root the project root
 * @param {{
 *   app: { name: string, dir: string },
 *   path?: string,
 *   styles?: boolean,
 * }} options
 * @returns {Promise<Diagnostic[]>}
 */
export async function emitComponent(root, options) {
  const { app, path } = options;
  const group = app.name;

  if (path === undefined) {
    return [
      error('scaffold/name', 'No component given. Name its tag: `srl generate component user-card`.', {
        group,
      }),
    ];
  }

  const segments = path.split('/');
  const tag = segments.pop() ?? '';
  const dirs = segments.length === 0 ? [DEFAULT_DIR] : segments;

  const badDir = dirs.find((segment) => !NAME.test(segment));
  if (badDir !== undefined) {
    return [
      error(
        'scaffold/name',
        `"${badDir}" is not a directory name. Each directory before the tag is one lowercase ` +
          `kebab-case segment under ${app.name}/src/: \`srl generate component pages/users-page\`.`,
        { group },
      ),
    ];
  }

  if (!TAG.test(tag) || RESERVED_TAGS.has(tag)) {
    return [
      error(
        'scaffold/tag',
        `"${tag}" is not a custom element name a component can take. A tag starts with a ` +
          `lowercase letter, has at least one hyphen, and is not one the HTML specification ` +
          `reserves: \`srl generate component user-card\`.`,
        { group },
      ),
    ];
  }

  const model = await readProject(app);
  const existing = model.elements.get(tag);
  if (existing !== undefined) {
    return [
      error(
        'scaffold/tag-taken',
        `<${tag}> is already defined here, and a tag is one component's identity. Pick another tag.`,
        { file: existing.module, group },
      ),
    ];
  }

  const dir = relative(root, join(app.dir, 'src', ...dirs)).split(sep).join('/');
  return writeFiles(root, componentFiles({ dir, tag, styles: options.styles === true }), { group });
}
