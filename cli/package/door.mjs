/**
 * The door: which of a module's exports the registry consumer is offered.
 *
 * A bundle is a barrel over every module under a specifier prefix, and the barrel
 * is derived rather than written so that a layer added once reaches every consumer
 * (ADR-0033, ADR-0066). Derived *from what* was "every top-level export", and a
 * module exports a name for two different reasons: because an application is meant
 * to call it, and because the module next door — or a suite, or the template
 * checker — has to reach in. So `import '@srljs/core'` autocompleted to 144 names,
 * several of which the source itself documents as test-only or internal, and a
 * consumer had no way to tell which five modules they were actually meant to use.
 *
 * The derivation stays and gains one input: a module marks an export `@internal`
 * and it stops being part of the door. Per name and declared beside the
 * declaration, the way `srl.bundles.exclude` is per directory and declared in the
 * manifest — so a new layer still reaches everyone by default, while a name written
 * for a test does not. ADR-0077.
 *
 * `@internal` is not `private`. The browser consumer loads modules by path and sees
 * every export it always did, `cli/checks/template-check.mjs` still imports the
 * dialect from `@srljs/core/lib/core/template/dialect.js`, and nothing inside the
 * library changes: bundle members resolve each other by file, not through the
 * barrel. It is the flat namespace of the bundle that is curated, because that is
 * the only surface on which a name reads as a promise.
 *
 * Parsing only — no disk, no resolution, no manifest — so the rule is a function of
 * a string and tests without a build.
 */

import ts from 'typescript';

/**
 * What one module offers and what it keeps back.
 *
 * `names` is every top-level export in source order and `internal` is the subset
 * marked; both are returned rather than only the difference, because the guard that
 * a sibling bundle can still resolve its imports has to be able to say which of the
 * two a missing name was.
 *
 * @typedef {{ names: string[], internal: string[] }} ModuleDoor
 */

/** The tag. TypeScript's own, so `@internal` already means this to an editor. */
const MARKER = 'internal';

/**
 * Whether the doc comment written directly above a statement marks it.
 *
 * "Directly above" is load-bearing rather than pedantic. TypeScript attaches every
 * JSDoc block that precedes a statement to it, blank lines included, so a module
 * whose *header* carried the tag would silently mark its first export and nothing
 * else. A header in this library is always separated from the code by a blank line;
 * requiring adjacency is what makes that convention the difference between "this
 * module is internal" — which is not a thing you can say here — and "this
 * declaration is".
 *
 * @param {ts.Statement} statement
 * @param {ts.SourceFile} tree
 * @param {string} source
 * @returns {boolean}
 */
function marked(statement, tree, source) {
  const own = (ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? []).at(-1);
  if (own === undefined) return false;

  const ends = tree.getLineAndCharacterOfPosition(own.end).line;
  const begins = tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line;
  if (begins - ends > 1) return false;

  return ts
    .getJSDocTags(statement)
    .some((tag) => tag.tagName.text === MARKER && tag.pos >= own.pos && tag.end <= own.end);
}

/**
 * Read one module's door.
 *
 * @param {string} source
 * @param {string} file Path, used only in the messages below.
 * @returns {ModuleDoor}
 */
export function moduleDoor(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const internal = [];

  for (const statement of tree.statements) {
    const declared = exportedNames(statement, file);
    if (declared.length === 0) continue;
    names.push(...declared);
    if (marked(statement, tree, source)) internal.push(...declared);
  }

  return { names, internal };
}

/**
 * The names one top-level statement exports, or none.
 *
 * The marker is read from the statement's JSDoc, so the unit is the statement:
 * `export const A = 1, B = 2` under one `@internal` marks both, which is what a
 * reader of that comment would expect. Splitting the pair is how you mark one.
 *
 * The three forms this refuses are all forms that would make the door quietly wrong
 * rather than loudly absent — a name forwarded from a file that is not read here, a
 * default a barrel over many modules cannot forward anyway, a binding whose name is
 * a pattern. None exist in the library today, and an error at the build is the
 * cheapest place to find out that one has been written.
 *
 * @param {ts.Statement} statement
 * @param {string} file
 * @returns {string[]}
 */
function exportedNames(statement, file) {
  if (ts.isExportDeclaration(statement)) {
    if (statement.exportClause === undefined) {
      throw new Error(
        `${file} re-exports with \`export *\`. The names it forwards are in another file, so ` +
          `neither this module's door nor a collision inside it can be derived from this one. ` +
          `Name the exports.`,
      );
    }
    if (!ts.isNamedExports(statement.exportClause)) {
      throw new Error(
        `${file} exports a namespace object. A bundle is a barrel of flat names and has nowhere ` +
          `to put one. Re-export the names.`,
      );
    }
    return statement.exportClause.elements.map((element) => element.name.text);
  }

  if (ts.isExportAssignment(statement)) {
    throw new Error(`${file} has a default export, which a barrel over many modules cannot carry.`);
  }

  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
    throw new Error(`${file} has a default export, which a barrel over many modules cannot carry.`);
  }

  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [statement.name.text];
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) => {
      if (!ts.isIdentifier(declaration.name)) {
        throw new Error(
          `${file} exports a destructuring pattern. The door is a list of names, so each one has ` +
            `to be written as its own binding.`,
        );
      }
      return declaration.name.text;
    });
  }

  return [];
}

/**
 * The entry module a bundle is built from: one statement per member.
 *
 * `export *` where a member keeps nothing back, which is the usual case and the one
 * worth keeping. Two members exporting the same name is a build error there rather
 * than a silently missing export, and the one case that looks like a collision —
 * `parseExpression` in both `expression.js` and `expression-parser.js` — is a
 * re-export of a single binding, which `export *` resolves to itself.
 *
 * A member that marks something gets its remaining names listed instead, because
 * there is no `export * except`. A member that keeps everything back is still
 * imported: it is in this bundle because something under the prefix needs it, and
 * dropping the statement would drop its side effects with it.
 *
 * Absolute paths, and the caller's order, so the emitted entry is stable byte for
 * byte across machines.
 *
 * @param {Array<{ file: string, door: ModuleDoor }>} members
 * @returns {string}
 */
export function barrelSource(members) {
  return members
    .map(({ file, door }) => {
      const from = JSON.stringify(file);
      if (door.internal.length === 0) return `export * from ${from};\n`;

      const kept = new Set(door.internal);
      const offered = door.names.filter((name) => !kept.has(name));
      if (offered.length === 0) return `import ${from};\n`;
      return `export { ${offered.join(', ')} } from ${from};\n`;
    })
    .join('');
}
