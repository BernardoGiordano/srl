import { html } from 'lit';
import { signal } from '@core/foundation/reactive.js';
import { beginBindingUpdate, beginElementUpdate, isRecordingUpdates, recordUpdates } from '@core/diagnostics/updates.js';
import { formatUpdateReport } from '@core/diagnostics/report.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { compileTemplate } from '@core/template/template.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/** @import { BindingUpdate, ElementUpdate, StopRecording, UpdateRecord } from '@core/diagnostics/types.js' */

/**
 * The two update paths have to be visible separately, which is why this module exists.
 * An element render and a binding patch are different events, and a recorder that saw
 * only the first would report silence for half of what a fine-grained framework does.
 */

const label = signal('start');
const badge = signal(0);
const counter = signal(0);

const probeTemplate = compileTemplate(
  '<span class="label">{{ readLabel() }}</span><span class="badge">{{ readBadge() }}</span>',
  'updates-probe.html',
);

const LABEL_BINDING = 'updates-probe.html {{ readLabel() }}';
const BADGE_BINDING = 'updates-probe.html {{ readBadge() }}';

class UpdatesProbe extends SignalElement {
  static properties = { heading: { type: String } };

  heading = 'first';

  readLabel() {
    return label.value;
  }

  readBadge() {
    return badge.value;
  }

  render() {
    return probeTemplate(this);
  }
}
customElements.define('updates-probe', UpdatesProbe);

class RenderSignalProbe extends SignalElement {
  render() {
    return html`<span class="count">${counter.value}</span>`;
  }
}
customElements.define('render-signal-probe', RenderSignalProbe);

/** @type {StopRecording | null} */
let running = null;

/**
 * Start a recording the suite can always stop, whether or not the test reached
 * its own stop call.
 *
 * @param {number} [limit]
 * @returns {StopRecording}
 */
function start(limit) {
  const stop = recordUpdates(limit === undefined ? undefined : { limit });
  running = stop;
  return () => {
    running = null;
    return stop();
  };
}

/**
 * @param {readonly UpdateRecord[]} records
 * @returns {ElementUpdate[]}
 */
function elementsIn(records) {
  /** @type {ElementUpdate[]} */
  const found = [];
  for (const record of records) if (record.kind === 'element') found.push(record);
  return found;
}

/**
 * @param {readonly UpdateRecord[]} records
 * @returns {BindingUpdate[]}
 */
function bindingsIn(records) {
  /** @type {BindingUpdate[]} */
  const found = [];
  for (const record of records) if (record.kind === 'binding') found.push(record);
  return found;
}

describe('update diagnostics', () => {
  beforeEach(() => {
    label.value = 'start';
    badge.value = 0;
    counter.value = 0;
  });

  afterEach(() => {
    // A recording left running would refuse the next test's.
    running?.();
    running = null;
    unmountAll();
  });

  it('records nothing until a recording starts', () => {
    assert.notOk(isRecordingUpdates(), 'no recording may be running by default');
  });

  it('returns the same no-op from every instrumented path while off', () => {
    const host = document.createElement('div');
    assert.equal(
      beginElementUpdate(host, 'mount'),
      beginElementUpdate(host, 'signal'),
      'the disabled element path must allocate nothing',
    );
    assert.equal(
      beginBindingUpdate({}, 'mount'),
      beginBindingUpdate({}, 'signal'),
      'the disabled binding path must allocate nothing',
    );
  });

  it('records the first render as a mount, with the bindings it committed', async () => {
    const stop = start();
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);
    const report = stop();

    const [render] = elementsIn(report.records);
    assert.equal(elementsIn(report.records).length, 1, 'one element rendered');
    assert.equal(present(render).tag, 'updates-probe');
    assert.equal(present(render).cause, 'mount');

    const committed = bindingsIn(present(render).children).map((record) => record.binding);
    assert.ok(committed.includes(LABEL_BINDING), 'the label binding is a child of the render');
    assert.ok(committed.includes(BADGE_BINDING), 'the badge binding is a child of the render');
  });

  it('names the property that caused a render', async () => {
    const element = /** @type {UpdatesProbe} */ (mount('<updates-probe></updates-probe>'));
    await settled(element);

    const stop = start();
    element.heading = 'second';
    await settled(element);
    const report = stop();

    const [render] = elementsIn(report.records);
    assert.equal(present(render).cause, 'properties');
    assert.sameArray(present(render).properties, ['heading']);
  });

  it('attributes a render to the signal its render() read', async () => {
    const element = mount('<render-signal-probe></render-signal-probe>');
    await settled(element);

    const stop = start();
    counter.value = 7;
    await settled(element);
    const report = stop();

    const [render] = elementsIn(report.records);
    assert.equal(present(render).tag, 'render-signal-probe');
    assert.equal(present(render).cause, 'signal');
  });

  it('reports a binding patch that no element render explains', async () => {
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);

    const stop = start();
    label.value = 'changed';
    await settled(element);
    const report = stop();

    assert.equal(elementsIn(report.records).length, 0, 'no element rendered');

    const patches = bindingsIn(report.records);
    assert.equal(patches.length, 1, 'exactly the dependent binding patched');
    assert.equal(present(patches[0]).binding, LABEL_BINDING);
    assert.equal(present(patches[0]).cause, 'signal');
    assert.ok(present(patches[0]).changed, 'it committed a different value');
  });

  it('nests the bindings a host render re-evaluated inside that render', async () => {
    const element = /** @type {UpdatesProbe} */ (mount('<updates-probe></updates-probe>'));
    await settled(element);

    const stop = start();
    element.heading = 'second';
    await settled(element);
    const report = stop();

    assert.equal(bindingsIn(report.records).length, 0, 'no patch happened outside the render');

    const [render] = elementsIn(report.records);
    const patches = bindingsIn(present(render).children);
    assert.equal(patches.length, 2, 'both bindings re-evaluated under the render');
    for (const patch of patches) {
      assert.equal(patch.cause, 'rerender');
      assert.notOk(patch.changed, 'the values did not move, and the report says so');
    }
  });

  it('counts every tag and binding, heaviest first', async () => {
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);

    const stop = start();
    label.value = 'one';
    await settled(element);
    label.value = 'two';
    await settled(element);
    const report = stop();

    assert.equal(report.elements.length, 0, 'nothing rendered');
    assert.equal(report.bindings.length, 1, 'one binding did all the work');

    const [entry] = report.bindings;
    assert.equal(present(entry).name, LABEL_BINDING);
    assert.equal(present(entry).updates, 2);
    assert.equal(present(entry).changed, 2);
  });

  it('stops recording when the recording is stopped', async () => {
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);

    const stop = start();
    const report = stop();

    label.value = 'after';
    await settled(element);

    assert.equal(report.records.length, 0, 'the report is closed at the moment it was taken');
    assert.notOk(isRecordingUpdates(), 'the recorder released itself');

    const second = start();
    const later = second();
    assert.equal(later.bindings.length, 0, 'a new recording starts empty');
  });

  it('returns the same report however often it is stopped', async () => {
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);

    const stop = start();
    label.value = 'once';
    await settled(element);

    const first = stop();
    const again = stop();
    assert.equal(first, again);
  });

  it('refuses a second recording rather than splitting one', () => {
    start();
    assert.throws(() => recordUpdates(), 'already running');
  });

  it('drops records past the limit and still counts them', async () => {
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);

    const stop = start(1);
    label.value = 'one';
    await settled(element);
    label.value = 'two';
    await settled(element);
    const report = stop();

    assert.equal(report.records.length, 1, 'the limit bounds what is retained');
    assert.equal(report.dropped, 1);
    assert.equal(present(report.bindings[0]).updates, 2, 'the counts stay exact');
  });

  it('formats a report that names the element, the binding and the cause', async () => {
    const stop = start();
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);
    label.value = 'formatted';
    await settled(element);
    const text = formatUpdateReport(stop());

    assert.includes(text, '<updates-probe> mount');
    assert.includes(text, LABEL_BINDING);
    assert.includes(text, 'signal');
    assert.includes(text, 'Timeline');
  });

  it('elides a timeline longer than the caller asked for', async () => {
    const stop = start();
    const element = mount('<updates-probe></updates-probe>');
    await settled(element);
    const text = formatUpdateReport(stop(), { records: 1 });

    assert.includes(text, '...and 2 more');
  });
});
