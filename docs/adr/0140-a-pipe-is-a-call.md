# ADR-0140: A pipe is a call

- Status: accepted
- Date: 2026-10-12
- Affects: `source/lib/core/template/expression-parser.js`, `cli/message-catalog/index.mjs`, `tools/checks/dialect-reference.mjs`

## Context

Angular templates format values with pipes, as in `{{ created | date:'short' }}`. An
application ported from Angular has one at almost every formatted value, and the
dialect refused `|` as a bitwise operator. Each one had to be rewritten as a call, and
a chain such as `{{ note | trim | truncate:40 }}` became `{{ truncate(trim(note), 40) }}`,
which reads inside out.

The dialect already had what a pipe does. Template globals such as `dt` and `cur`, and
public component methods, are functions a template can call. Only the spelling was
missing.

Lit has no pipe to borrow. A Lit template holds JavaScript, where `|` is bitwise OR, and
the dialect parses its own expressions before Lit sees them.

Three alternatives lost.

**Keep refusing `|`.** Every port rewrites every pipe by hand, and chains stay inside
out.

**A pipe registry, as Angular's `@Pipe`.** A pipe would be a declared class with a
`transform` method and a purity flag. Angular needs the flag because change detection
re-runs every binding on every pass, and a pure pipe lets it skip the call. A binding
here re-runs only when a signal it read changes, so the flag would buy nothing. A
registry would also give the evaluator, the checker and the language server a second
kind of name to resolve.

**A new `pipe` node in the expression tree.** The evaluator, the checker's type emitter
and the message catalog would each need a case for a node that behaves exactly like a
call.

## Decision

The parser reads a pipe and builds the call it stands for. Nothing after the parser
knows pipes exist.

- `value | name:a:b` is the call `name(value, a, b)`. `a | f | g` is `g(f(a))`.
- The pipe name is a bare identifier. It resolves like any other name, so a loop local,
  a template global or a public component method can stand there. A method keeps the
  component as its receiver.
- Each argument after `:` is parsed as a conditional, so `a ? b : c` fits without
  parentheses.
- A pipe binds looser than every other operator. `a + b | upper` pipes the sum.
- A pipe may end the whole binding, or any expression inside parentheses, call
  arguments, an index, array items or object values. A conditional's branches do not
  take a pipe without parentheses.
- An event binding refuses a pipe, with `templates/expression-syntax`, as Angular's
  action expressions do. A handler calls the function.
- `||` is still one token. A bitwise operator is still refused.

The message catalog places a finding on the key whether the key comes after `t`, as in
`t('orders.title')`, or before it, as in `'orders.title' | t`.

## Consequences

- One call has two spellings. Neither is preferred, and the checker treats them the
  same.
- `:` has a third meaning, beside a conditional's `:` and an object literal's `:`.
  Context decides each one, but `a | p ? b : c` is a syntax error, because the pipe's
  argument list ends before `?`. Write `(a | p) ? b : c`.
- A finding about an unknown pipe name sits on the name, as it does for a written call.
- `templates/expression-syntax` covers a pipe in an event binding. A dedicated code
  would need a row in the diagnostic code reference. Reopen this if a quick fix needs to
  tell the case apart.
- Reopen this if a pipe needs state that a function cannot hold, such as an
  asynchronous value. `resource()` covers that case today.
