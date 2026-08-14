import { signal } from '@core/foundation/reactive.js';
import { compileExpression } from '@core/template/expression.js';
import { assert } from '../harness.js';

// Side effect: i18n registers `t`, `num`, `dt` and the rest as template globals.
// Imported explicitly here because expression.js on its own has none — in the
// application, template.js does this import for the same reason.
import '@core/localization/i18n.js';

/**
 * The template expression language.
 *
 * Two groups of tests matter more than the rest. The signal-unwrapping ones,
 * because that behaviour is what lets a template read `users` instead of
 * `users.value` and is therefore load-bearing for every component. And the
 * refusal tests, because the value of throwing on an unknown name is entirely in
 * the fact that it happens rather than silently rendering nothing.
 */

/**
 * @param {string} source
 * @param {Record<string, unknown>} [host]
 * @param {Record<string, unknown>} [locals]
 * @returns {unknown}
 */
function evaluate(source, host = {}, locals = {}) {
  return compileExpression(source, 'test', { allowAssignment: true })({ host, locals, version: 0 });
}

describe('expression language', () => {
  it('reads literals', () => {
    assert.equal(evaluate('1'), 1);
    assert.equal(evaluate('1.5'), 1.5);
    assert.equal(evaluate("'a'"), 'a');
    assert.equal(evaluate('"a"'), 'a');
    assert.equal(evaluate('true'), true);
    assert.equal(evaluate('false'), false);
    assert.equal(evaluate('null'), null);
    assert.equal(evaluate('undefined'), undefined);
  });

  it('unescapes strings', () => {
    assert.equal(evaluate("'a\\nb'"), 'a\nb');
    assert.equal(evaluate("'it\\'s'"), "it's");
  });

  it('resolves names from locals, then host, then globals', () => {
    assert.equal(evaluate('x', { x: 'host' }), 'host');
    assert.equal(evaluate('x', { x: 'host' }, { x: 'local' }), 'local');
    // `t` is registered by @core/localization/i18n.js, which template.js imports.
    assert.equal(typeof evaluate('t'), 'function');
  });

  it('lets a local holding undefined still shadow a host member', () => {
    assert.equal(evaluate('x', { x: 'host' }, { x: undefined }), undefined);
  });

  it('reads members and honours optional chaining', () => {
    const host = { user: { name: 'Ada', address: null } };
    assert.equal(evaluate('user.name', host), 'Ada');
    assert.equal(evaluate('user.address?.city', host), undefined);
    assert.equal(evaluate('missing?.deep?.deeper', { missing: undefined }), undefined);
    assert.throws(() => evaluate('user.address.city', host), 'Cannot read "city" of null');
  });

  it('indexes arrays and objects', () => {
    assert.equal(evaluate('rows[1]', { rows: ['a', 'b'] }), 'b');
    assert.equal(evaluate('map[key]', { map: { a: 1 }, key: 'a' }), 1);
  });

  it('calls methods with the right receiver', () => {
    const service = {
      name: 'svc',
      label() {
        return this.name;
      },
    };
    assert.equal(evaluate('service.label()', { service }), 'svc');
    assert.equal(
      evaluate('label()', {
        name: 'host',
        label() {
          return this.name;
        },
      }),
      'host',
    );
  });

  it('applies operator precedence', () => {
    assert.equal(evaluate('1 + 2 * 3'), 7);
    assert.equal(evaluate('(1 + 2) * 3'), 9);
    assert.equal(evaluate('1 + 2 === 3'), true);
    assert.equal(evaluate('!true === false'), true);
    assert.equal(evaluate('-2 + 1'), -1);
    assert.equal(evaluate('5 % 3'), 2);
  });

  it('short-circuits logical operators', () => {
    let calls = 0;
    const host = {
      user: null,
      boom() {
        calls += 1;
        return 'x';
      },
    };
    assert.equal(evaluate('user && boom()', host), null);
    assert.equal(calls, 0, 'the right side must not run');
    assert.equal(evaluate('user ?? 1', host), 1);
    assert.equal(evaluate('user || 2', host), 2);
  });

  it('evaluates ternaries and comparisons', () => {
    assert.equal(evaluate("n > 2 ? 'big' : 'small'", { n: 3 }), 'big');
    assert.equal(evaluate("'a' < 'b'"), true);
    assert.equal(evaluate('2 <= 2'), true);
  });

  it('concatenates strings with +', () => {
    assert.equal(evaluate("'/users/' + id", { id: 7 }), '/users/7');
    assert.equal(evaluate("'a' + null"), 'a');
  });

  it('builds array and object literals', () => {
    assert.sameArray(/** @type {unknown[]} */ (evaluate('[1, x]', { x: 2 })), [1, 2]);
    const built = /** @type {Record<string, unknown>} */ (evaluate("{ count: n, 'k': 1 }", { n: 3 }));
    assert.equal(built.count, 3);
    assert.equal(built.k, 1);
  });

  /* ── Signals ───────────────────────────────────────────────────────────── */

  it('unwraps a signal read by name', () => {
    const count = signal(2);
    assert.equal(evaluate('count', { count }), 2);
    count.value = 3;
    assert.equal(evaluate('count', { count }), 3);
  });

  it('unwraps a signal reached through a member', () => {
    const service = { users: signal(['a']) };
    assert.sameArray(/** @type {unknown[]} */ (evaluate('service.users', { service })), ['a']);
    assert.equal(evaluate('service.users.length', { service }), 1);
  });

  it('unwraps a signal returned from a call', () => {
    const host = {
      current: () => signal('now'),
    };
    assert.equal(evaluate('current()', host), 'now');
  });

  it('does not unwrap behind &', () => {
    const count = signal(2);
    assert.equal(evaluate('&count', { count }), count);
    // The `&` applies to the outermost resolution only: `service` is still
    // unwrapped on the way through.
    const service = { panel: signal('p') };
    assert.equal(evaluate('&service.panel', { service }), service.panel);
  });

  /* ── Assignment ────────────────────────────────────────────────────────── */

  it('writes through a signal instead of replacing it', () => {
    const query = signal('');
    const host = { query };
    evaluate('query = 5', host);
    assert.equal(query.value, 5);
    assert.equal(host.query, query, 'the signal object must survive');
  });

  it('assigns to a plain host property and to a member', () => {
    const host = { flag: false, nested: { n: 0 } };
    evaluate('flag = true', host);
    assert.equal(host.flag, true);
    evaluate('nested.n = 4', host);
    assert.equal(host.nested.n, 4);
  });

  it('refuses assignment where it is not allowed', () => {
    assert.throws(
      () => compileExpression('x = 1', 'test')({ host: { x: 1 }, locals: {}, version: 0 }),
      'Unexpected "="',
    );
  });

  /* ── Refusals ──────────────────────────────────────────────────────────── */

  it('resolves an unknown name to undefined, leaving the report to the checker', () => {
    // Not a throw: the evaluator has no development mode to be loud in, and
    // `npm run templates:check` types every expression against the component
    // class, so a name the component does not have never reaches a browser.
    assert.equal(evaluate('nope', {}), undefined);
  });

  it('refuses to reach Object.prototype through an identifier', () => {
    assert.throws(() => evaluate('toString', {}), 'may not reference "toString"');
    assert.throws(() => evaluate('constructor', {}), 'may not reference "constructor"');
    assert.throws(() => evaluate('__proto__', {}), 'may not reference "__proto__"');
  });

  it('refuses to reach a prototype through a member', () => {
    assert.throws(() => evaluate('x.constructor', { x: {} }), 'may not access "constructor"');
    assert.throws(() => evaluate('x.__proto__', { x: {} }), 'may not access "__proto__"');
    assert.throws(() => evaluate("x['constructor']", { x: {} }), 'may not access "constructor"');
  });

  it('refuses a reserved member however it is written to', () => {
    // The read path always refused these names, so the write path reading as
    // safe was the whole defect: each of these changed a prototype.
    for (const source of [
      'x.__proto__ = y',
      'x.constructor = y',
      'x.prototype = y',
      "x['__proto__'] = y",
      'x.nested.__proto__ = y',
    ]) {
      const x = { nested: {} };
      assert.throws(() => evaluate(source, { x, y: { polluted: true } }), 'may not access');
      assert.equal(Object.getPrototypeOf(x), Object.prototype, `${source} changed a prototype`);
      assert.equal(Object.getPrototypeOf(x.nested), Object.prototype, `${source} changed a prototype`);
    }
  });

  it('refuses a computed write whose key is only known when the event fires', () => {
    // The one case the parser cannot see, and the reason the evaluator keeps its
    // own copy of the check.
    const x = {};
    assert.throws(
      () => evaluate('x[key] = y', { x, key: '__proto__', y: { polluted: true } }),
      'may not access "__proto__"',
    );
    assert.equal(Object.getPrototypeOf(x), Object.prototype);
    // An ordinary computed write is untouched by the rule.
    const row = /** @type {Record<string, unknown>} */ ({});
    evaluate('row[column] = 1', { row, column: 'total' });
    assert.equal(row.total, 1);
  });

  it('refuses a reserved key in an object literal', () => {
    assert.throws(() => evaluate('{ __proto__: y }', { y: {} }), 'may not access "__proto__"');
    assert.throws(() => evaluate("{ 'constructor': y }", { y: {} }), 'may not access "constructor"');
    const built = /** @type {Record<string, unknown>} */ (evaluate('{ ok: 1 }'));
    assert.equal(Object.getPrototypeOf(built), Object.prototype);
  });

  it('reports a syntax error with a caret and the source', () => {
    assert.throws(() => evaluate('a +'), 'Unexpected end of expression');
    assert.throws(() => evaluate('a ]'), 'Unexpected "]"');
    assert.throws(() => evaluate('a # b'), 'Unexpected character');
    assert.throws(() => evaluate(''), 'Empty expression');
  });

  it('rejects the syntax it deliberately does not support', () => {
    // No arrow functions, no `new`, no bitwise, no increment. Each of these is a
    // sign that logic is being written in a template.
    assert.throws(() => evaluate('() => 1'));
    assert.throws(() => evaluate('new Thing()'));
    assert.throws(() => evaluate('a & b === c'), 'Unexpected');
    assert.throws(() => evaluate('a++'));
  });

  it('says what was called when a non-function is called', () => {
    assert.throws(() => evaluate('x()', { x: 4 }), '"x" is not a function, it is a number');
  });
});
