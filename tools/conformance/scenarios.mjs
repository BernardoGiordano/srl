/**
 * What an installed editor has to do, stated once for every editor. ADR-0097.
 *
 * A scenario is data, not code: an `ask` an adapter knows how to make, the document and
 * position it is made at, and what the answer has to contain. Positions are found by
 * searching the fixture's own text, so a scaffold that gains a line does not move them.
 */

/** @import { Scenario } from './types.js' */

/** The primary project's application directory, as `srl new` writes it. */
const APP = 'app';

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: 'session.start',
    title: 'the installed project starts one language server, rooted at itself',
    kind: 'session',
    ask: 'servers',
    expect: { serving: ['one'] },
  },
  {
    id: 'session.silent-roots',
    title: 'a project that declares srl without installing it, and one that is not srl, start none',
    kind: 'session',
    ask: 'servers',
    open: [
      { root: 'declared', document: 'index.html' },
      { root: 'plain', document: 'index.html' },
    ],
    expect: { serving: ['one'], silent: ['declared', 'plain'] },
  },
  {
    id: 'session.multi-root',
    title: 'a second project in the same window gets its own server, not a shared one',
    kind: 'session',
    ask: 'servers',
    add: ['two'],
    expect: { serving: ['one', 'two'] },
  },
  {
    id: 'session.restart',
    title: 'three restarts leave the same servers running and no orphans behind',
    kind: 'session',
    ask: 'restart',
    times: 3,
    expect: { serving: ['one', 'two'] },
  },
  {
    id: 'diagnostics.clean',
    title: 'the scaffolded template reports nothing',
    kind: 'language',
    ask: 'diagnostics',
    document: `${APP}/src/main.html`,
    expect: { empty: true },
  },
  {
    id: 'diagnostics.unsaved',
    title: 'an unsaved edit is checked, and names the member that does not exist',
    kind: 'language',
    ask: 'diagnostics',
    document: `${APP}/src/main.html`,
    edit: { replace: '{{ count }}', with: '{{ nowhere }}' },
    expect: { includes: ['nowhere'] },
  },
  {
    id: 'completion.member',
    title: 'completion inside an interpolation offers the component the template belongs to',
    kind: 'language',
    ask: 'completion',
    document: `${APP}/src/main.html`,
    at: { after: '{{ ' },
    expect: { includes: ['count', 'increment'] },
  },
  {
    id: 'hover.member',
    title: 'hover over a bound member says what it is',
    kind: 'language',
    ask: 'hover',
    document: `${APP}/src/main.html`,
    at: { on: 'count' },
    expect: { includes: ['count'] },
  },
  {
    id: 'definition.member',
    title: 'go to definition from a template lands in the class beside it',
    kind: 'language',
    ask: 'definition',
    document: `${APP}/src/main.html`,
    at: { on: 'count' },
    expect: { file: `${APP}/src/main.js` },
  },
  {
    id: 'rename.tag',
    title: 'renaming a tag edits the template that uses it and the declaration that names it',
    kind: 'language',
    ask: 'rename',
    document: `${APP}/src/main.html`,
    at: { on: 'app-detail' },
    to: 'app-panel',
    expect: { files: [`${APP}/src/main.html`, `${APP}/src/detail.js`] },
  },
  {
    id: 'lit.isolation',
    title: 'a Lit template in JavaScript gets no srl suggestions',
    kind: 'language',
    ask: 'completion',
    document: `${APP}/src/widget.js`,
    at: { after: '<div ' },
    expect: { excludes: ['*if', '*for', '(click)'] },
  },
  {
    id: 'javascript.coexistence',
    title: "the editor's own JavaScript service still answers in a served project",
    kind: 'language',
    ask: 'completion',
    document: `${APP}/src/main.js`,
    at: { after: '    this.' },
    expect: { includes: ['increment'] },
  },
  {
    id: 'watch.disk-change',
    title: 'a member added on disk, outside the editor, reaches the next completion',
    kind: 'language',
    ask: 'watch',
    write: { document: `${APP}/src/detail.js`, replace: "  get title() {", with: '  get subtitle() {\n    return 1;\n  }\n\n  get title() {' },
    document: `${APP}/src/detail.html`,
    at: { after: '{{ ' },
    expect: { includes: ['subtitle'] },
  },
  {
    id: 'trace.protocol',
    title: 'srl.trace.server records the protocol for the folder it belongs to',
    kind: 'session',
    ask: 'trace',
    document: `${APP}/src/main.html`,
    at: { after: '{{ ' },
    expect: { includes: ['textDocument/completion'] },
  },
  {
    id: 'session.no-orphan',
    title: 'no language server survives the editor that started it',
    kind: 'session',
    ask: 'orphans',
    expect: { silent: ['one', 'two', 'declared', 'plain'] },
  },
];

/** @param {string[]} ids @returns {Scenario[]} */
export function only(ids) {
  const wanted = new Set(ids);
  return SCENARIOS.filter((scenario) => wanted.has(scenario.id));
}
