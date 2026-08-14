/**
 * Parser for the template expression language.
 *
 * Kept apart from expression.js so Node-side tools can consume the exact AST
 * used by the browser without importing signals or browser environment flags.
 * The one import is dialect.js, which imports nothing itself, so this module
 * stays loadable directly from Node.
 *
 * That import is what gives the member policy one enforcement point. Every
 * member name written in the source — after `.`, as an object key, as a string
 * index — passes through here on the way to both adapters, so refusing a name
 * here refuses it for the evaluator and for the checker at once, instead of
 * asking each of the two to remember the rule at six sites. Names that only
 * exist at runtime, as in `row[key] = value`, cannot be seen from here and are
 * refused by the evaluator against the same list.
 *
 * Relative rather than `@core/`, and the only relative import under source/lib:
 * the alias is an import-map entry the browser resolves and Node does not, and
 * tools/checks/template-check.mjs loads this file from Node by path. A sibling
 * specifier resolves to the same module in both.
 */

import { refusedMember } from './dialect.js';

/** @import { ExprNode } from '@core/template/types.js' */

const TOKEN =
  /\s+|(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][A-Za-z0-9_$]*)|(\?\.|===|!==|==|!=|<=|>=|&&|\|\||\?\?|[()[\]{}.,:?!+\-*/%<>=&])/gy;

const WORD_LITERALS = new Map([
  ['true', true],
  ['false', false],
  ['null', null],
  ['undefined', undefined],
]);

/** @typedef {{ type: 'number' | 'string' | 'name' | 'punct', text: string, at: number }} Token */

/** @param {string} source @param {string} where @returns {Token[]} */
function tokenize(source, where) {
  /** @type {Token[]} */
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (match === null || match.index !== at) {
      throw syntaxError(source, at, where, `Unexpected character ${JSON.stringify(source[at])}`);
    }
    const [, number, string, name, punct] = match;
    if (number !== undefined) tokens.push({ type: 'number', text: number, at });
    else if (string !== undefined) tokens.push({ type: 'string', text: unescape(string), at });
    else if (name !== undefined) tokens.push({ type: 'name', text: name, at });
    else if (punct !== undefined) tokens.push({ type: 'punct', text: punct, at });
  }
  return tokens;
}

/** @param {string} quoted @returns {string} */
function unescape(quoted) {
  return quoted.slice(1, -1).replace(/\\(.)/gu, (_all, char) => {
    if (char === 'n') return '\n';
    if (char === 't') return '\t';
    if (char === 'r') return '\r';
    return typeof char === 'string' ? char : '';
  });
}

/** @param {string} source @param {number} at @param {string} where @param {string} message */
function syntaxError(source, at, where, message) {
  return new Error(`${message} in ${where}\n    ${source}\n    ${' '.repeat(at)}^`);
}

class Parser {
  #tokens;
  #source;
  #where;
  #index = 0;

  /** @param {string} source @param {string} where */
  constructor(source, where) {
    this.#source = source;
    this.#where = where;
    this.#tokens = tokenize(source, where);
  }

  /** @param {boolean} allowAssignment @returns {ExprNode} */
  parse(allowAssignment) {
    if (this.#tokens.length === 0) throw this.#error(0, 'Empty expression');
    const node = allowAssignment ? this.#assignment() : this.#conditional();
    const extra = this.#peek();
    if (extra !== undefined) throw this.#error(extra.at, `Unexpected ${JSON.stringify(extra.text)}`);
    return node;
  }

  /** @returns {ExprNode} */
  #assignment() {
    const target = this.#conditional();
    if (!this.#eat('=')) return target;
    if (target.kind !== 'name' && target.kind !== 'member' && target.kind !== 'index') {
      throw this.#error(0, 'Assignment target must be a name or a member access');
    }
    return { kind: 'assign', target, value: this.#assignment() };
  }

  /** @returns {ExprNode} */
  #conditional() {
    const test = this.#binary(0);
    if (!this.#eat('?')) return test;
    const consequent = this.#assignment();
    this.#expect(':');
    return { kind: 'conditional', test, consequent, alternate: this.#assignment() };
  }

  /** @param {number} level @returns {ExprNode} */
  #binary(level) {
    const operators = BINARY_LEVELS[level];
    if (operators === undefined) return this.#unary();
    let left = this.#binary(level + 1);
    for (;;) {
      const token = this.#peek();
      if (token?.type !== 'punct' || !operators.has(token.text)) return left;
      this.#index += 1;
      left = { kind: 'binary', operator: token.text, left, right: this.#binary(level + 1) };
    }
  }

  /** @returns {ExprNode} */
  #unary() {
    const token = this.#peek();
    if (token?.type === 'punct' && (token.text === '!' || token.text === '-')) {
      this.#index += 1;
      return { kind: 'unary', operator: token.text, operand: this.#unary() };
    }
    if (token?.type === 'punct' && token.text === '&') {
      this.#index += 1;
      return { kind: 'raw', operand: this.#unary() };
    }
    return this.#postfix();
  }

  /** @returns {ExprNode} */
  #postfix() {
    let node = this.#primary();
    for (;;) {
      if (this.#eat('.') || this.#eat('?.')) {
        const optional = this.#previous()?.text === '?.';
        node = { kind: 'member', object: node, name: this.#name(), optional };
      } else if (this.#eat('[')) {
        const at = this.#peek()?.at ?? this.#source.length;
        const index = this.#assignment();
        this.#expect(']');
        // `row['constructor']` is the same operation as `row.constructor` and is
        // refused in the same place. A computed key is not visible here and is
        // refused by the evaluator instead.
        if (index.kind === 'literal' && typeof index.value === 'string') this.#refuseMember(index.value, at);
        node = { kind: 'index', object: node, index, optional: false };
      } else if (this.#eat('(')) node = { kind: 'call', callee: node, args: this.#arguments() };
      else return node;
    }
  }

  /** @returns {ExprNode[]} */
  #arguments() {
    /** @type {ExprNode[]} */
    const args = [];
    if (this.#eat(')')) return args;
    do args.push(this.#assignment());
    while (this.#eat(','));
    this.#expect(')');
    return args;
  }

  /** @returns {ExprNode} */
  #primary() {
    const token = this.#peek();
    if (token === undefined) throw this.#error(this.#source.length, 'Unexpected end of expression');
    this.#index += 1;
    if (token.type === 'number') return { kind: 'literal', value: Number(token.text) };
    if (token.type === 'string') return { kind: 'literal', value: token.text };
    if (token.type === 'name') {
      if (WORD_LITERALS.has(token.text)) return { kind: 'literal', value: WORD_LITERALS.get(token.text) };
      return { kind: 'name', name: token.text, at: token.at };
    }
    if (token.text === '(') {
      const inner = this.#assignment();
      this.#expect(')');
      return inner;
    }
    if (token.text === '[') {
      /** @type {ExprNode[]} */
      const items = [];
      if (!this.#eat(']')) {
        do items.push(this.#assignment());
        while (this.#eat(','));
        this.#expect(']');
      }
      return { kind: 'array', items };
    }
    if (token.text === '{') {
      /** @type {{ key: string, value: ExprNode }[]} */
      const entries = [];
      if (!this.#eat('}')) {
        do {
          const key = this.#peek();
          if (key === undefined || (key.type !== 'name' && key.type !== 'string')) {
            throw this.#error(key?.at ?? token.at, 'Object keys must be names or strings');
          }
          this.#index += 1;
          // An object literal builds its result by assigning each key, so a
          // reserved key here is a prototype write with different syntax.
          this.#refuseMember(key.text, key.at);
          this.#expect(':');
          entries.push({ key: key.text, value: this.#assignment() });
        } while (this.#eat(','));
        this.#expect('}');
      }
      return { kind: 'object', entries };
    }
    throw this.#error(token.at, `Unexpected ${JSON.stringify(token.text)}`);
  }

  /**
   * The name after `.` or `?.`, whether the access ends up being read, called
   * or written to.
   *
   * @returns {string}
   */
  #name() {
    const token = this.#peek();
    if (token?.type !== 'name') throw this.#error(token?.at ?? this.#source.length, 'Expected a property name');
    this.#index += 1;
    this.#refuseMember(token.text, token.at);
    return token.text;
  }

  /** @param {string} name @param {number} at */
  #refuseMember(name, at) {
    const refusal = refusedMember(name);
    if (refusal !== undefined) throw this.#error(at, refusal);
  }

  /** @returns {Token | undefined} */
  #peek() { return this.#tokens[this.#index]; }
  /** @returns {Token | undefined} */
  #previous() { return this.#tokens[this.#index - 1]; }
  /** @param {string} text @returns {boolean} */
  #eat(text) {
    const token = this.#peek();
    if (token?.type !== 'punct' || token.text !== text) return false;
    this.#index += 1;
    return true;
  }
  /** @param {string} text */
  #expect(text) {
    if (this.#eat(text)) return;
    const token = this.#peek();
    throw this.#error(
      token?.at ?? this.#source.length,
      `Expected ${JSON.stringify(text)}${token === undefined ? ' but the expression ended' : ` and found ${JSON.stringify(token.text)}`}`,
    );
  }
  /** @param {number} at @param {string} message */
  #error(at, message) { return syntaxError(this.#source, at, this.#where, message); }
}

const BINARY_LEVELS = [
  new Set(['??']),
  new Set(['||']),
  new Set(['&&']),
  new Set(['===', '!==', '==', '!=']),
  new Set(['<', '<=', '>', '>=']),
  new Set(['+', '-']),
  new Set(['*', '/', '%']),
];

/**
 * @param {string} source
 * @param {string} where
 * @param {{ allowAssignment?: boolean }} [options]
 * @returns {ExprNode}
 */
export function parseExpression(source, where, options) {
  return new Parser(source, where).parse(options?.allowAssignment ?? false);
}
