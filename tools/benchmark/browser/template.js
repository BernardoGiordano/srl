/**
 * Template runtime workloads: compiling markup, updating one binding, and moving
 * keyed rows around.
 *
 * These are the workloads that decide whether "templates are compiled at runtime"
 * costs anything worth talking about. Compilation happens once per template per
 * page, so its absolute cost matters at startup and nowhere else; the update and
 * keyed-list workloads are the ones that run while somebody is looking at the
 * screen, and they are measured through the DOM rather than through the compiler's
 * own bookkeeping — a fast update that did not reach an element is not an update.
 *
 * Every source here is generated from a count, so the same workload runs at 10
 * bindings or 200 and the report can say which one regressed.
 */

import { render } from 'lit';
import { signal } from '@core/foundation/reactive.js';
import { compileTemplate } from '@core/template/template.js';

import { expect, makeRows, waitFor } from './support.js';

/** @import { Row } from './support.js' */

/**
 * A template with `bindings` unrelated interpolations, one attribute binding and
 * one event binding, which is the shape of a real screen: mostly text, a few
 * attributes, one or two handlers.
 *
 * @param {number} bindings
 * @returns {string}
 */
function fieldTemplate(bindings) {
  const rows = [];
  for (let index = 0; index < bindings; index += 1) {
    rows.push(
      `<p class="field"><span>label ${String(index)}</span>` +
        `<span data-index="${String(index)}">{{ values.f${String(index)} }}</span></p>`,
    );
  }
  return (
    `<section [class]="tone" (click)="onClick()">` +
    `<h2>{{ title }}</h2>${rows.join('')}</section>`
  );
}

/**
 * @param {number} bindings
 * @returns {{ values: Record<string, string>, title: string, tone: string, onClick: () => void }}
 */
function fieldModel(bindings) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < bindings; index += 1) values[`f${String(index)}`] = `value ${String(index)}`;
  return { values, title: 'Fields', tone: 'plain', onClick: () => undefined };
}

/**
 * Compile a template of a stated size. `where` varies per sample so that nothing
 * downstream can serve a cached compilation and call it a fast compile.
 *
 * @type {import('./support.js').Workload}
 */
export const compile = {
  setup(_scope, args) {
    return { source: fieldTemplate(Number(args.bindings)), sample: 0 };
  },
  run(state) {
    state.sample += 1;
    return compileTemplate(state.source, `bench:${String(state.sample)}`);
  },
  check(answer) {
    expect(typeof answer, 'function', 'compileTemplate returned');
  },
};

/**
 * Render a compiled template of a stated size into a fresh container: the other
 * half of what a component pays on first paint.
 *
 * @type {import('./support.js').Workload}
 */
export const first_render = {
  setup(_scope, args) {
    const bindings = Number(args.bindings);
    return {
      compiled: compileTemplate(fieldTemplate(bindings), 'bench:render'),
      model: fieldModel(bindings),
      bindings,
    };
  },
  run(state, scope) {
    render(state.compiled(state.model), scope.container);
    return scope.container.querySelectorAll('p.field').length;
  },
  check(answer, args) {
    expect(answer, Number(args.bindings), 'rendered fields');
  },
};

/**
 * Change one signal in a template that holds many unrelated bindings, and wait for
 * that text node to change.
 *
 * The measurement the fine-grained reactivity claim rests on: if the cost of this
 * scales with the number of bindings in the template rather than staying flat, the
 * signal path is not doing what the design says it does. Run at two binding counts
 * and compare.
 *
 * @type {import('./support.js').Workload}
 */
export const update_one_binding = {
  setup(scope, args) {
    const bindings = Number(args.bindings);
    const source = fieldTemplate(bindings);
    /** @type {Record<string, import('@core/foundation/reactive.js').Signal<string>>} */
    const values = {};
    for (let index = 0; index < bindings; index += 1) {
      values[`f${String(index)}`] = signal(`value ${String(index)}`);
    }
    const target = /** @type {import('@core/foundation/reactive.js').Signal<string>} */ (values.f0);
    const model = { values, title: 'Fields', tone: 'plain', onClick: () => undefined };

    render(compileTemplate(source, 'bench:update')(model), scope.container);
    const cell = scope.container.querySelector('[data-index="0"]');
    if (cell === null) throw new Error('The fixture rendered no target cell.');
    return { target, cell, generation: 0 };
  },
  async run(state) {
    state.generation += 1;
    const next = `updated ${String(state.generation)}`;
    state.target.value = next;
    await waitFor(() => state.cell.textContent === next, 'the updated binding');
    return state.cell.textContent;
  },
  check(answer) {
    expect(typeof answer === 'string' && answer.startsWith('updated '), true, 'updated text');
  },
};

/**
 * The keyed `*for` list, in the five shapes a list actually takes: built, changed
 * in place, reversed, cut down and grown back.
 *
 * One workload with a `mutation` argument rather than five near-copies, because
 * every one of them is "swap the array behind a signal and wait for the DOM", and
 * five copies of that would drift apart the first time the fixture changed.
 *
 * @type {import('./support.js').Workload}
 */
export const keyed_list = {
  setup(scope, args) {
    const count = Number(args.count);
    const rows = signal(makeRows(count));
    const model = { rows };
    const source =
      '<ul><li *for="row of rows; key: row.id" [data-id]="row.id">{{ row.name }}</li></ul>';

    render(compileTemplate(source, 'bench:for')(model), scope.container);
    const list = scope.container.querySelector('ul');
    if (list === null) throw new Error('The fixture rendered no list.');

    return { rows, list, count, base: makeRows(count) };
  },

  async run(state, _scope, args) {
    const mutation = String(args.mutation);
    const before = state.rows.value;

    /** @type {import('./support.js').Row[]} */
    let next;
    /** @type {(list: HTMLElement) => boolean} */
    let landed;

    if (mutation === 'create') {
      // Built from empty, so this one measures creating `count` elements rather
      // than diffing them.
      state.rows.value = [];
      await waitFor(() => state.list.children.length === 0, 'the emptied list');
      next = state.base;
      landed = (list) => list.children.length === state.count;
    } else if (mutation === 'update') {
      next = before.map(/** @param {Row} row */ (row) => ({ ...row, name: `${row.name}!` }));
      landed = (list) => (list.firstElementChild?.textContent ?? '').endsWith('!');
    } else if (mutation === 'reverse') {
      next = [...before].reverse();
      landed = (list) =>
        list.firstElementChild?.getAttribute('data-id') === String(state.count);
    } else if (mutation === 'shrink') {
      next = before.slice(0, Math.max(1, Math.floor(state.count / 10)));
      landed = (list) => list.children.length === next.length;
    } else if (mutation === 'regrow') {
      state.rows.value = before.slice(0, Math.max(1, Math.floor(state.count / 10)));
      await waitFor(() => state.list.children.length < state.count, 'the shrunk list');
      next = state.base;
      landed = (list) => list.children.length === state.count;
    } else {
      throw new Error(`Unknown list mutation ${JSON.stringify(mutation)}.`);
    }

    state.rows.value = next;
    await waitFor(() => landed(state.list), `the ${mutation} list`);
    return state.list.children.length;
  },

  check(answer, args) {
    const count = Number(args.count);
    const expected = String(args.mutation) === 'shrink' ? Math.max(1, Math.floor(count / 10)) : count;
    expect(answer, expected, `rows after ${String(args.mutation)}`);
  },
};
