/**
 * The expression language used inside `.html` templates: a tokenizer, a
 * precedence-climbing parser and a closure compiler.
 *
 * Not `new Function`, for two independent reasons. It would require
 * `script-src 'unsafe-eval'`, the CSP relaxation most likely to be refused by a
 * security review; and it could not read `this.#users` anyway, so a template
 * could never see the private state components hold. Templates bind to *public*
 * members, which the type checker can also see.
 *
 * Supported: member access, optional chaining, computed access, calls,
 * arithmetic, comparison, negation, ternary, `??`/`&&`/`||`, array and object
 * literals, and assignment inside event bindings. Deliberately absent: function
 * and arrow declarations, `new`, `typeof`, bitwise operators, increment, comma
 * sequences, template literals. A template needing any of them is doing work that
 * belongs in the component.
 *
 * Every resolution step unwraps a `Signal`, which is also what registers the
 * dependency with the tracking effect in signal-element.js. The escape hatch is
 * `&`: `[.target]="&panel"` passes the signal itself, which is what `<x-outlet>`
 * wants — it subscribes directly and swaps its child without re-rendering the
 * parent.
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
 * Publish values that every template can reference by bare name, in the way
 * Angular exposes pipes. `@core/localization/i18n.js` registers the translation and
 * formatting helpers through here.
 *
 * Registered under a `Map` rather than an object so a template identifier can
 * never reach `Object.prototype` members: `{{ constructor }}` and
 * `{{ hasOwnProperty }}` resolve to nothing instead of to a function.
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
 * Called at template-compile time, never per render. The returned closure does
 * no parsing, no string work and no allocation beyond what the expression itself
 * requires, which is what makes a fetched template's steady-state cost the same
 * as an inline `html` tagged literal.
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
      const { name } = node;
      return (scope) => read(resolve(name, scope, where));
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
        return read(member(target, name));
      };
    }

    case 'index': {
      const object = compile(node.object, where, true);
      const index = compile(node.index, where, true);
      return (scope) => {
        const target = object(scope);
        if (target === null || target === undefined) return undefined;
        return read(member(target, String(index(scope))));
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
      // The only place `unwrap` is turned off, and it applies to the operand's
      // outermost resolution only: `&a.b` keeps the signal at `b` while still
      // unwrapping `a` on the way there.
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
   * A method must be called with its object as the receiver, or `this` inside
   * `users.reload()` is undefined and the method's own private fields throw.
   * That is why the callee is not simply compiled as a value.
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
            return { fn: member(receiver, name), receiver, label: name };
          };
        })()
      : callee.kind === 'name'
        ? (() => {
            const { name } = callee;
            return (scope) => {
              const found = resolveWithReceiver(name, scope, where);
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

  // `==` and `!=` become their strict forms here, and the template checker emits
  // the same substitution, so a comparison cannot mean one thing to tsc and
  // another at runtime.
  switch (strictOperator(node.operator)) {
    // Short-circuiting operators must not evaluate the right side eagerly:
    // `user && user.name` is the whole reason they appear in templates.
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
    return (scope) => {
      const next = value(scope);
      const current = resolveWithReceiver(name, scope, where);
      // Assigning to a signal sets it rather than replacing it. Without this,
      // `(input)="query = $event.target.value"` would overwrite the signal
      // object on the component and silently detach every subscriber.
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
    // The write side of the same policy the read path applies through `member`.
    // Only a computed key can still be reserved here; a written one was refused
    // while parsing.
    refuseForbiddenMember(name);
    const existing = receiver[name];
    if (existing instanceof Signal) existing.value = next;
    else receiver[name] = next;
    return next;
  };
}

/* ── Scope resolution ──────────────────────────────────────────────────── */

/**
 * Name lookup, in order: template locals (`$event`, `*for` variables), then the
 * component instance, then registered globals.
 *
 * An unresolvable name yields `undefined`, as Angular's does. What reports it is
 * `npm run templates:check`, which types every expression against the component
 * class before the page ever runs — a renamed property is a build failure there
 * rather than a blank spot on the page.
 *
 * @param {string} name
 * @param {Scope} scope
 * @param {string} where
 * @returns {unknown}
 */
function resolve(name, scope, where) {
  return resolveWithReceiver(name, scope, where).value;
}

/**
 * @param {string} name
 * @param {Scope} scope
 * @param {string} where
 * @returns {{ value: unknown, receiver: unknown }}
 */
function resolveWithReceiver(name, scope, where) {
  if (name === '$host') return { value: scope.host, receiver: undefined };

  if (UNRESOLVABLE_NAMES.has(name)) {
    throw new Error(`Templates may not reference "${name}" in ${where}.`);
  }

  // `in` rather than `hasOwn`, because row locals are prototype-chained: a
  // nested `*for` sees the outer loop's variables through the chain instead of
  // holding a copy of them. The chain is rooted in `Object.create(null)`
  // (template.js's EMPTY_LOCALS), so walking it cannot reach `Object.prototype`
  // and `{{ toString }}` still resolves to nothing. `undefined` and `null` in
  // locals still shadow a component member of the same name, which a truthiness
  // check would not.
  if (name in scope.locals) {
    return { value: scope.locals[name], receiver: scope.locals };
  }
  // `in` for the host, because a component's members are mostly getters and
  // methods on its prototype chain. The denylist above is what keeps that from
  // also exposing `Object.prototype`.
  if (name in scope.host) return { value: scope.host[name], receiver: scope.host };
  if (globalsByName.has(name)) return { value: globalsByName.get(name), receiver: undefined };

  // A name the component does not have resolves to nothing. The template checker
  // is what refuses it, statically, against the component's own types.
  return { value: undefined, receiver: undefined };
}

/**
 * Property access that refuses to walk into the prototype chain of plain
 * objects it did not create. The list itself is dialect.js's, so the checker
 * refuses the same names.
 *
 * @param {object} target
 * @param {string} name
 * @returns {unknown}
 */
function member(target, name) {
  refuseForbiddenMember(name);
  return /** @type {Record<string, unknown>} */ (target)[name];
}

/**
 * The runtime half of the member policy: names the parser could not see.
 *
 * A name written in the source is refused while parsing, so by the time an
 * expression is compiled the only unchecked key left is a computed one, whose
 * value is not known until the event fires. `row[column] = value` with a
 * `column` of `__proto__` is the case this exists for.
 *
 * @param {string} name
 */
function refuseForbiddenMember(name) {
  const refusal = refusedMember(name);
  if (refusal !== undefined) throw new Error(`${refusal}.`);
}

/**
 * Names an identifier may never resolve to. Every own property of
 * `Object.prototype`, because the host lookup uses `in` and would otherwise
 * resolve `{{ toString }}` or `{{ valueOf }}` to an inherited function.
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
 * `+` has to serve both string concatenation (`'/users/' + user.id`) and
 * arithmetic, and JavaScript's own rules for the mixed case are the ones
 * template authors already expect.
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
 * An object reaching here means a template concatenated something it should have
 * read a property of. Rendering `[object Object]` onto the page is a diagnostic
 * nobody can act on, so development names the value and production renders
 * nothing. `Date` is the one object with a useful default string.
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
  // A function or a symbol. Neither has a rendering, and both mean the template
  // forgot a call or a property, which is what the template check reports.
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
