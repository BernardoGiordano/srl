/**
 * Definition-scale workloads: what a page pays for having many components.
 *
 * The claim under test is that a buildless application can carry a real component
 * inventory. Two costs decide it, and they are reported as separate metrics of one
 * sample because they are only meaningful together:
 *
 *   define       registering N components through `defineComponent`.
 *   instantiate  creating and connecting instances once the registry holds N.
 *
 * The second is the one that could surprise: if element creation slowed down as
 * the registry grew, a 5,000-component application would pay for its size on every
 * render rather than once at startup. Measuring only the definitions would hide
 * exactly that.
 *
 * `customElements.define` is permanent, so each sample needs a page of its own.
 * That is why this module is driven one sample at a time from Node.
 */

import { html } from 'lit';
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';

import { expect, rendered } from './support.js';

/** How many instances the second half creates, whatever the definition count. */
const INSTANCES = 100;

/**
 * Register `count` components, then build `INSTANCES` of the last one.
 *
 * Definitions are awaited one at a time rather than in parallel, because that is
 * what a module graph does: each component module ends with its own
 * `await defineComponent(...)`, and the next module's body does not run until it
 * resolves.
 *
 * @type {import('./support.js').Workload}
 */
export const define_scale = {
  measured: true,

  async run(_state, scope, args) {
    const count = Number(args.count);

    const started = performance.now();
    /** @type {CustomElementConstructor | undefined} */
    let last;
    for (let index = 0; index < count; index += 1) {
      const element = class extends SignalElement {
        render() {
          return html`<span class="bench-cell">component ${index}</span>`;
        }
      };
      await defineComponent({
        tag: `bench-def-${String(index)}`,
        element,
        module: import.meta.url,
        template: false,
      });
      last = element;
    }
    const defineMs = performance.now() - started;
    if (last === undefined) throw new Error('No component was defined.');

    const host = document.createElement('div');
    scope.container.append(host);

    const createdAt = performance.now();
    for (let index = 0; index < INSTANCES; index += 1) {
      host.append(document.createElement(`bench-def-${String(count - 1)}`));
    }
    await rendered(host);
    const instantiateMs = performance.now() - createdAt;

    return {
      answer: {
        defined: customElements.get(`bench-def-${String(count - 1)}`) === last,
        cells: host.querySelectorAll('.bench-cell').length,
      },
      metrics: { define: defineMs, instantiate: instantiateMs },
    };
  },

  check(answer) {
    expect(answer.defined, true, 'the last component owns its tag');
    expect(answer.cells, INSTANCES, 'rendered instances');
  },
};
