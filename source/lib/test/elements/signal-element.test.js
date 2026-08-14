import { html } from 'lit';
import { signal } from '@core/foundation/reactive.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { compileTemplate } from '@core/template/template.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/**
 * The tests that matter most, because they cover the two places the reactive
 * plumbing could be subtly wrong in ways an app would not reveal until late:
 * dependency re-tracking across a template branch, and teardown on disconnect.
 */

const count = signal(0);
const branch = signal(false);
const left = signal('L');
const right = signal('R');

let renders = 0;

const fineLeft = signal('left');
const fineRight = signal('right');
let fineRenders = 0;
let fineLeftEvaluations = 0;
let fineRightEvaluations = 0;

const fineTemplate = compileTemplate(
  '<span class="fine-left">{{ readFineLeft() }}</span>' +
    '<span class="fine-right">{{ readFineRight() }}</span>',
  'fine-grained-element.html',
);

class ProbeElement extends SignalElement {
  render() {
    renders += 1;
    return html`<span class="count">${count.value}</span>`;
  }
}
customElements.define('probe-element', ProbeElement);

class BranchElement extends SignalElement {
  render() {
    // Reads a different signal depending on `branch`. A tracking set captured
    // once and reused would keep listening to the signal from the old branch.
    return html`<span class="text">${branch.value ? right.value : left.value}</span>`;
  }
}
customElements.define('branch-element', BranchElement);

class FineGrainedElement extends SignalElement {
  readFineLeft() {
    fineLeftEvaluations += 1;
    return fineLeft.value;
  }

  readFineRight() {
    fineRightEvaluations += 1;
    return fineRight.value;
  }

  render() {
    fineRenders += 1;
    return fineTemplate(this);
  }
}
customElements.define('fine-grained-element', FineGrainedElement);

describe('SignalElement', () => {
  beforeEach(() => {
    count.value = 0;
    branch.value = false;
    left.value = 'L';
    right.value = 'R';
    renders = 0;
    fineLeft.value = 'left';
    fineRight.value = 'right';
    fineRenders = 0;
    fineLeftEvaluations = 0;
    fineRightEvaluations = 0;
  });

  afterEach(() => {
    unmountAll();
  });

  it('renders into light DOM so Tailwind can reach the markup', async () => {
    const element = mount('<probe-element></probe-element>');
    await settled(element);

    assert.equal(element.shadowRoot, null, 'must not create a shadow root');
    assert.ok(element.querySelector('.count'), 'template must be a light-DOM child');
  });

  it('re-renders when a signal read during render changes', async () => {
    const element = mount('<probe-element></probe-element>');
    await settled(element);
    assert.equal(element.querySelector('.count')?.textContent, '0');

    count.value = 7;
    await settled(element);
    assert.equal(element.querySelector('.count')?.textContent, '7');
  });

  it('does not re-render for signals it never read', async () => {
    const element = mount('<probe-element></probe-element>');
    await settled(element);
    const baseline = renders;

    // ProbeElement reads `count` only.
    left.value = 'changed';
    await settled(element);

    assert.equal(renders, baseline, 'unrelated signal must not trigger a render');
  });

  it('updates only the compiled binding that depends on a changed signal', async () => {
    const element = mount('<fine-grained-element></fine-grained-element>');
    await settled(element);

    assert.equal(fineRenders, 1);
    assert.equal(fineLeftEvaluations, 1);
    assert.equal(fineRightEvaluations, 1);

    fineLeft.value = 'changed';
    await settled(element);

    assert.equal(element.querySelector('.fine-left')?.textContent, 'changed');
    assert.equal(element.querySelector('.fine-right')?.textContent, 'right');
    assert.equal(fineRenders, 1, 'a binding update must not render the component again');
    assert.equal(fineLeftEvaluations, 2, 'the dependent binding evaluated again');
    assert.equal(fineRightEvaluations, 1, 'the unrelated binding was not evaluated');
  });

  it('re-tracks dependencies after a template branch flips', async () => {
    const element = mount('<branch-element></branch-element>');
    await settled(element);
    assert.equal(element.querySelector('.text')?.textContent, 'L');

    branch.value = true;
    await settled(element);
    assert.equal(element.querySelector('.text')?.textContent, 'R');

    // Now on the right branch. The left signal must no longer be tracked...
    left.value = 'ignored';
    await settled(element);
    assert.equal(element.querySelector('.text')?.textContent, 'R');

    // ...and the right one must be.
    right.value = 'R2';
    await settled(element);
    assert.equal(element.querySelector('.text')?.textContent, 'R2');
  });

  it('stops reacting once disconnected', async () => {
    const element = mount('<probe-element></probe-element>');
    await settled(element);
    const baseline = renders;

    element.remove();
    count.value = 99;
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(renders, baseline, 'a detached element must not render');
  });

  it('stops compiled binding effects once disconnected', async () => {
    const element = mount('<fine-grained-element></fine-grained-element>');
    await settled(element);
    const baseline = fineLeftEvaluations;

    element.remove();
    fineLeft.value = 'detached';
    await Promise.resolve();

    assert.equal(fineLeftEvaluations, baseline, 'a detached binding must release its signal effect');
  });

  it('resumes reacting when reconnected', async () => {
    const element = mount('<probe-element></probe-element>');
    await settled(element);

    const parent = present(element.parentElement);
    element.remove();
    parent.append(element);
    await settled(element);

    count.value = 42;
    await settled(element);
    assert.equal(element.querySelector('.count')?.textContent, '42');
  });

  it('aborts the lifetime signal on disconnect', async () => {
    const element = /** @type {ProbeElement} */ (mount('<probe-element></probe-element>'));
    await settled(element);

    const lifetime = element.lifetime;
    assert.notOk(lifetime.aborted);

    element.remove();
    assert.ok(lifetime.aborted, 'lifetime must abort so listeners clean themselves up');
  });
});
