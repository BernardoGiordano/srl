/**
 * The template expression language: a tokenizer, a precedence-climbing parser and a
 * closure compiler.
 *
 * It avoids `new Function`, which would need `script-src 'unsafe-eval'` and still
 * couldn't read private fields. Templates bind to public members, which the type
 * checker can see too.
 *
 * The language supports member access, optional chaining, computed access, calls,
 * arithmetic, comparison, negation, ternaries, `??`, `&&`, `||`, array and object
 * literals, and assignment in event bindings. Functions, `new`, `typeof`, bitwise
 * operators, increments, comma sequences and template literals are left out on
 * purpose, because that logic belongs in the component.
 *
 * Every resolution step unwraps a `Signal`, which also registers the dependency. `&`
 * passes the signal itself, as in `[.target]="&panel"` for `<x-outlet>`.
 */

import { Signal } from '@core/foundation/reactive.js';
import { FORBIDDEN_MEMBERS, refusedMember, strictOperator } from '@core/template/dialect.js';
import { parseExpression } from '@core/template/expression-parser.js';

export { parseExpression } from '@core/template/expression-parser.js';

/** @import { Evaluator, ExprNode, Scope } from '@core/template/types.js' */

/* ── Globals visible to every template ─────────────────────────────────── */

/** @type {Map<string, unknown>} */
const globalsByName = new Map();

/**
 * Publish values every template can reference by bare name, the way Angular exposes
 * pipes. `@core/localization/i18n.js` registers its helpers here.
 *
 * Globals live in a `Map`, so `{{ constructor }}` can't reach `Object.prototype`.
 *
 * @param {Readonly<Record<string, unknown>>} values
 */
export function registerTemplateGlobals(values) {
  for (const [name, value] of Object.entries(values)) globalsByName.set(name, value);
}

/* ── Compiler ──────────────────────────────────────────────────────────── */

/**
 * Parse an expression once and return a closure that evaluates it.
 *
 * This runs at template compile time. The closure does no parsing and no string
 * work, so a fetched template costs the same per render as an inline `html` literal.
 *
 * @param {string} source
 * @param {string} where Template URL and attribute, quoted in error messages.
 * @param {{ allowAssignment?: boolean }} [options]
 * @returns {Evaluator}
 */
export function compileExpression(source, where, options) {
  const ast = parseExpression(source, where, options);
  return compile(ast, where, true);
}

/**
 * @param {ExprNode} node
 * @param {string} where
 * @param {boolean} unwrap Whether a resolved `Signal` should be read.
 * @returns {Evaluator}
 */
function compile(node, where, unwrap) {
  const read = unwrap ? unwrapSignal : identity;

  switch (node.kind) {
    case 'literal': {
      const { value } = node;
      return () => value;
    }

    case 'name': {
      const lookup = compileNameRead(node.name, where);
      return (scope) => read(lookup(scope));
    }

    case 'member': {
      const object = compile(node.object, where, true);
      const { name, optional } = node;
      return (scope) => {
        const target = object(scope);
        if (target === null || target === undefined) {
          if (optional) return undefined;
          throw evaluationError(where, `Cannot read "${name}" of ${String(target)}`);
        }
        // No check here, because the parser already refused reserved names. Only a
        // computed key can still be one.
        return read(/** @type {Record<string, unknown>} */ (target)[name]);
      };
    }

    case 'index': {
      const object = compile(node.object, where, true);
      const index = compile(node.index, where, true);
      return (scope) => {
        const target = object(scope);
        if (target === null || target === undefined) return undefined;
        const key = String(index(scope));
        refuseForbiddenMember(key);
        return read(/** @type {Record<string, unknown>} */ (target)[key]);
      };
    }

    case 'call':
      return compileCall(node, where, read);

    case 'unary': {
      const operand = compile(node.operand, where, true);
      return node.operator === '!'
        ? (scope) => !operand(scope)
        : (scope) => -Number(operand(scope));
    }

    case 'binary':
      return compileBinary(node, where);

    case 'conditional': {
      const test = compile(node.test, where, true);
      const consequent = compile(node.consequent, where, unwrap);
      const alternate = compile(node.alternate, where, unwrap);
      return (scope) => (test(scope) ? consequent(scope) : alternate(scope));
    }

    case 'array': {
      const items = node.items.map((item) => compile(item, where, true));
      return (scope) => items.map((item) => item(scope));
    }

    case 'object': {
      const entries = node.entries.map((entry) => ({
        key: entry.key,
        value: compile(entry.value, where, true),
      }));
      return (scope) => {
        /** @type {Record<string, unknown>} */
        const result = {};
        for (const entry of entries) result[entry.key] = entry.value(scope);
        return result;
      };
    }

    case 'assign':
      return compileAssignment(node, where);

    case 'raw':
      // `&` stops unwrapping only at the outermost step, so `&a.b` still unwraps `a`
      // and keeps the signal at `b`.
      return compile(node.operand, where, false);
  }
}

/**
 * @param {Extract<ExprNode, { kind: 'call' }>} node
 * @param {string} where
 * @param {(value: unknown) => unknown} read
 * @returns {Evaluator}
 */
function compileCall(node, where, read) {
  const args = node.args.map((arg) => compile(arg, where, true));
  const { callee } = node;

  /**
   * Resolve the callee together with its receiver, so `users.reload()` runs with
   * `this` bound and its private fields work.
   *
   * @type {(scope: Scope) => { fn: unknown, receiver: unknown, label: string }}
   */
  const resolveCallee =
    callee.kind === 'member'
      ? (() => {
          const object = compile(callee.object, where, true);
          const { name } = callee;
          return (scope) => {
            const receiver = object(scope);
            if (receiver === null || receiver === undefined) {
              throw evaluationError(where, `Cannot call "${name}" of ${String(receiver)}`);
            }
            return {
              fn: /** @type {Record<string, unknown>} */ (receiver)[name],
              receiver,
              label: name,
            };
          };
        })()
      : callee.kind === 'name'
        ? (() => {
            const { name } = callee;
            const lookup = compileNameResolution(name, where);
            return (scope) => {
              const found = lookup(scope);
              return { fn: found.value, receiver: found.receiver, label: name };
            };
          })()
        : (() => {
            const fn = compile(callee, where, true);
            return (scope) => ({ fn: fn(scope), receiver: undefined, label: 'expression' });
          })();

  return (scope) => {
    const { fn, receiver, label } = resolveCallee(scope);
    if (typeof fn !== 'function') {
      throw evaluationError(where, `"${label}" is not a function, it is ${describe(fn)}`);
    }
    const call = /** @type {(this: unknown, ...rest: unknown[]) => unknown} */ (fn);
    return read(call.apply(receiver, args.map((arg) => arg(scope))));
  };
}

/**
 * @param {Extract<ExprNode, { kind: 'binary' }>} node
 * @param {string} where
 * @returns {Evaluator}
 */
function compileBinary(node, where) {
  const left = compile(node.left, where, true);
  const right = compile(node.right, where, true);

  // `==` and `!=` become strict here, and the template checker emits the same
  // substitution.
  switch (strictOperator(node.operator)) {
    // Short-circuit operators must not evaluate the right side eagerly.
    case '&&':
      return (scope) => (left(scope) ? right(scope) : left(scope));
    case '||':
      return (scope) => left(scope) || right(scope);
    case '??':
      return (scope) => left(scope) ?? right(scope);

    case '+':
      return (scope) => addOrConcat(left(scope), right(scope));
    case '-':
      return (scope) => Number(left(scope)) - Number(right(scope));
    case '*':
      return (scope) => Number(left(scope)) * Number(right(scope));
    case '/':
      return (scope) => Number(left(scope)) / Number(right(scope));
    case '%':
      return (scope) => Number(left(scope)) % Number(right(scope));

    case '===':
      return (scope) => left(scope) === right(scope);
    case '!==':
      return (scope) => left(scope) !== right(scope);

    case '<':
      return (scope) => compare(left(scope), right(scope)) < 0;
    case '<=':
      return (scope) => compare(left(scope), right(scope)) <= 0;
    case '>':
      return (scope) => compare(left(scope), right(scope)) > 0;
    case '>=':
      return (scope) => compare(left(scope), right(scope)) >= 0;

    default:
      throw new Error(`Unsupported operator "${node.operator}" in ${where}`);
    }
}

/**
 * @param {Extract<ExprNode, { kind: 'assign' }>} node
 * @param {string} where
 * @returns {Evaluator}
 */
function compileAssignment(node, where) {
  const value = compile(node.value, where, true);
  const { target } = node;

  if (target.kind === 'name') {
    const { name } = target;
    const lookup = compileNameResolution(name, where);
    return (scope) => {
      const next = value(scope);
      const current = lookup(scope);
      // Assigning to a signal sets its value. Replacing the signal object would
      // detach every subscriber.
      if (current.value instanceof Signal) {
        current.value.value = next;
      } else if (isRecord(current.receiver)) {
        current.receiver[name] = next;
      } else {
        throw evaluationError(where, `Cannot assign to "${name}"`);
      }
      return next;
    };
  }

  const object = compile(target.object, where, true);
  const key =
    target.kind === 'member'
      ? () => target.name
      : (() => {
          const index = compile(target.index, where, true);
          /** @param {Scope} scope */
          return (scope) => String(index(scope));
        })();

  return (scope) => {
    const next = value(scope);
    const receiver = object(scope);
    if (!isRecord(receiver)) throw evaluationError(where, 'Cannot assign to a non-object');

    const name = key(scope);
    // The write side of the member policy. Only a computed key can still be reserved.
    refuseForbiddenMember(name);
    const existing = receiver[name];
    if (existing instanceof Signal) existing.value = next;
    else receiver[name] = next;
    return next;
  };
}

/* ── Scope resolution ──────────────────────────────────────────────────── */

/**
 * Name lookup, in order: template locals, the component instance, then globals.
 *
 * An unknown name yields `undefined`, as in Angular. `npm run templates:check` types
 * every expression against the component and reports it.
 *
 * `$host` and refused names are handled at compile time, so the returned closure
 * only walks the three scopes.
 *
 * @param {string} name
 * @param {string} where
 * @returns {(scope: Scope) => unknown}
 */
function compileNameRead(name, where) {
  if (name === '$host') return (scope) => scope.host;
  refuseUnresolvableName(name, where);

  // `in`, because locals are prototype-chained and component members are mostly
  // prototype getters and methods. The locals chain ends in `null`, and the refusal
  // above blocks `Object.prototype` names, so `{{ toString }}` resolves to nothing.
  // A local set to `undefined` or `null` still shadows a member with the same name.
  return (scope) => {
    if (name in scope.locals) return scope.locals[name];
    if (name in scope.host) return scope.host[name];
    // An unknown name falls through to the globals.
    return globalsByName.get(name);
  };
}

/**
 * The same lookup, also returning the receiver a call or an assignment needs. Kept
 * separate, so plain reads don't allocate a record.
 *
 * @param {string} name
 * @param {string} where
 * @returns {(scope: Scope) => { value: unknown, receiver: unknown }}
 */
function compileNameResolution(name, where) {
  if (name === '$host') return (scope) => ({ value: scope.host, receiver: undefined });
  refuseUnresolvableName(name, where);

  return (scope) => {
    if (name in scope.locals) return { value: scope.locals[name], receiver: scope.locals };
    if (name in scope.host) return { value: scope.host[name], receiver: scope.host };
    return { value: globalsByName.get(name), receiver: undefined };
  };
}

/**
 * @param {string} name
 * @param {string} where
 */
function refuseUnresolvableName(name, where) {
  if (UNRESOLVABLE_NAMES.has(name)) {
    throw new Error(`Templates may not reference "${name}" in ${where}.`);
  }
}

/**
 * Refuse a reserved name that is only known at runtime, such as `row[column] = value`
 * with `column` set to `__proto__`. The parser refuses names written in the source.
 *
 * @param {string} name
 */
function refuseForbiddenMember(name) {
  const refusal = refusedMember(name);
  if (refusal !== undefined) throw new Error(`${refusal}.`);
}

/**
 * Names an identifier may never resolve. The set includes every own property of
 * `Object.prototype`, because the host lookup uses `in`.
 */
const UNRESOLVABLE_NAMES = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...FORBIDDEN_MEMBERS,
]);

/* ── Value helpers ─────────────────────────────────────────────────────── */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function unwrapSignal(value) {
  return value instanceof Signal ? value.value : value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function identity(value) {
  return value;
}

/**
 * `+` concatenates when either side is a string and adds otherwise, as in JavaScript.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {string | number}
 */
function addOrConcat(left, right) {
  if (typeof left === 'string' || typeof right === 'string') {
    return `${stringify(left)}${stringify(right)}`;
  }
  return Number(left) + Number(right);
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
function compare(left, right) {
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const a = Number(left);
  const b = Number(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stringify for `+` concatenation.
 *
 * An object here means the template forgot a property access, and `[object Object]`
 * helps nobody, so an object renders as an empty string. `Date` is the exception.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // A function or a symbol means a missing call or property, which the template
  // check reports.
  return '';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * @param {string} where
 * @param {string} message
 * @returns {Error}
 */
function evaluationError(where, message) {
  return new Error(`${message} in ${where}`);
}
