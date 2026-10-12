/**
 * Parser for the template expression language.
 *
 * Separate from expression.js, so Node tools can build the same AST without loading
 * signals. Its only import is dialect.js, which imports nothing.
 *
 * Every member name written in the source passes through here, so refusing a name
 * here refuses it for the evaluator and the checker at once. Names computed at
 * runtime, as in `row[key] = value`, are refused by the evaluator.
 *
 * The import is relative. `@core/` is an import map entry Node doesn't resolve, and
 * the template checker loads this file by path.
 */

import { refusedMember } from './dialect.js';

/** @import { ExprNode } from '@core/template/types.js' */

// `=>` is one token, so an arrow function is a syntax error rather than an assignment.
// `||` is tried before a single `|`, so a pipe never splits it.
const TOKEN =
  /\s+|(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][A-Za-z0-9_$]*)|(\?\.|===|!==|==|=>|!=|<=|>=|&&|\|\||\?\?|[()[\]{}.,:?!+\-*/%<>=&|])/gy;

/**
 * Names that read as values rather than as members of the component.
 *
 * @internal
 */
export const WORD_LITERALS = new Map([
  ['true', true],
  ['false', false],
  ['null', null],
  ['undefined', undefined],
]);

/** @typedef {{ type: 'number' | 'string' | 'name' | 'punct', text: string, at: number }} Token */

/**
 * The problem an `ExpressionError` names. The template checker reports the code as it
 * stands, so the browser and the checker give one problem one name.
 *
 * @typedef {'templates/expression-syntax' | 'templates/expression-assignment' | 'templates/expression-member'} ExpressionErrorCode
 */

/** A binding expression the dialect cannot parse or refuses. */
export class ExpressionError extends Error {
  /** @param {ExpressionErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ExpressionError';
    /** @readonly */
    this.code = code;
  }
}

/** @param {string} source @param {string} where @returns {Token[]} */
function tokenize(source, where) {
  /** @type {Token[]} */
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (match === null || match.index !== at) {
      throw expressionError('templates/expression-syntax', source, at, where, `Unexpected character ${JSON.stringify(source[at])}`);
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

/**
 * @param {ExpressionErrorCode} code
 * @param {string} source
 * @param {number} at
 * @param {string} where
 * @param {string} message
 */
function expressionError(code, source, at, where, message) {
  return new ExpressionError(code, `${message} in ${where}\n    ${source}\n    ${' '.repeat(at)}^`);
}

class Parser {
  #tokens;
  #source;
  #where;
  #event;
  #index = 0;

  /** @param {string} source @param {string} where @param {boolean} event */
  constructor(source, where, event) {
    this.#source = source;
    this.#where = where;
    this.#event = event;
    this.#tokens = tokenize(source, where);
  }

  /** @returns {ExprNode} */
  parse() {
    if (this.#tokens.length === 0) throw this.#error(0, 'Empty expression');
    const node = this.#expression();
    const extra = this.#peek();

    // A pipe argument is a conditional, so `x | f = 1` stops at the `=`.
    if (extra?.type === 'punct' && extra.text === '=') {
      throw this.#error(extra.at, 'Only an event binding may assign', 'templates/expression-assignment');
    }
    if (extra !== undefined) throw this.#error(extra.at, `Unexpected ${JSON.stringify(extra.text)}`);
    return node;
  }

  /**
   * Every position that may hold an assignment parses through here, so outside an
   * event binding an assignment is refused at any depth.
   *
   * @returns {ExprNode}
   */
  #assignment() {
    const target = this.#conditional();
    const equals = this.#peek();
    if (equals?.type !== 'punct' || equals.text !== '=') return target;
    if (!this.#event) {
      throw this.#error(equals.at, 'Only an event binding may assign', 'templates/expression-assignment');
    }
    this.#index += 1;
    if (target.kind !== 'name' && target.kind !== 'member' && target.kind !== 'index') {
      throw this.#error(0, 'Assignment target must be a name or a member access', 'templates/expression-assignment');
    }
    return { kind: 'assign', target, value: this.#assignment() };
  }

  /**
   * An expression in a delimited position, which a pipe may end. Parentheses, call
   * arguments, an index, array items and object values are delimited.
   *
   * @returns {ExprNode}
   */
  #expression() {
    return this.#pipes(this.#assignment());
  }

  /**
   * Apply each pipe after `head`. `value | name:a:b` is the call `name(value, a, b)`,
   * so the evaluator, the checker and the message catalog read an ordinary call.
   * ADR-0140.
   *
   * @param {ExprNode} head
   * @returns {ExprNode}
   */
  #pipes(head) {
    let node = head;
    for (;;) {
      const bar = this.#peek();
      if (bar?.type !== 'punct' || bar.text !== '|') return node;
      if (this.#event) throw this.#error(bar.at, 'An event binding may not pipe. Call the function instead');
      this.#index += 1;

      const name = this.#peek();
      if (name?.type !== 'name' || WORD_LITERALS.has(name.text)) {
        throw this.#error(name?.at ?? this.#source.length, 'Expected a pipe name after "|"');
      }
      this.#index += 1;

      // An argument is a conditional, so `a ? b : c` fits without parentheses.
      /** @type {ExprNode[]} */
      const args = [node];
      while (this.#eat(':')) args.push(this.#conditional());
      node = { kind: 'call', callee: { kind: 'name', name: name.text, at: name.at }, args };
    }
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
        const index = this.#expression();
        this.#expect(']');
        // `row['constructor']` is refused like `row.constructor`. The evaluator
        // refuses computed keys.
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
    do args.push(this.#expression());
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
      const inner = this.#expression();
      this.#expect(')');
      return inner;
    }
    if (token.text === '[') {
      /** @type {ExprNode[]} */
      const items = [];
      if (!this.#eat(']')) {
        do items.push(this.#expression());
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
          // An object literal assigns each key, so a reserved key is a prototype write.
          this.#refuseMember(key.text, key.at);
          this.#expect(':');
          entries.push({ key: key.text, value: this.#expression() });
        } while (this.#eat(','));
        this.#expect('}');
      }
      return { kind: 'object', entries };
    }
    throw this.#error(token.at, `Unexpected ${JSON.stringify(token.text)}`);
  }

  /**
   * The name after `.` or `?.`, for a read, a call or a write.
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
    if (refusal !== undefined) throw this.#error(at, refusal, 'templates/expression-member');
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
  /** @param {number} at @param {string} message @param {ExpressionErrorCode} [code] */
  #error(at, message, code = 'templates/expression-syntax') {
    return expressionError(code, this.#source, at, this.#where, message);
  }
}

/**
 * Binary operators, loosest binding first. Operators on one level group left to right.
 *
 * @internal
 */
export const BINARY_LEVELS = [
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
  return new Parser(source, where, options?.allowAssignment ?? false).parse();
}
