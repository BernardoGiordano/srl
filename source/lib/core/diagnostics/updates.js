/**
 * Why the page just updated.
 *
 * There are two update paths and they are independent. An element renders when a
 * signal its `render()` read changed, or when a reactive property was written;
 * a compiled binding patches its own Lit Part when a signal *its* expression read
 * changed, and no element renders at all (ADR-0014). A timer around element
 * renders therefore sees half of what happened, and the half it misses is the one
 * a fine-grained framework produces the most of.
 *
 * So both paths report here, and this module does the reconstruction rather than
 * leaving it to whoever reads a log. Records nest: a binding patch that happened
 * while an element was rendering is a child of that render, and a binding patch
 * with no render around it is a top-level record — which is exactly the
 * difference between "this component re-rendered and its bindings followed" and
 * "one binding updated on its own". ADR-0109.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * It does not name the signal. `cause: 'signal'` means the effect behind that
 * element or that binding re-ran, which is a fact the update path knows; which
 * signal woke it is not, because nothing in the reactive library reports a
 * dependency by name. Attribution stops where the evidence does.
 *
 * COST WHEN NOTHING IS RECORDING
 *
 * One module-level null check and one call to a shared empty function per update.
 * Compiling a template labels its bindings whether or not anything is recording —
 * a template compiles once per URL, and a recording started afterwards still has
 * to be able to name what it sees.
 */

/** @import { BindingUpdateCause, ElementUpdateCause, StopRecording, UpdateCount, UpdateRecord, UpdateRecordingOptions, UpdateReport } from '@core/diagnostics/types.js' */

/**
 * One open element render: the public record, plus what closing it needs.
 *
 * `host` is held so a late `noteElementProperties` can prove it belongs to the
 * frame on top of the stack rather than to a child that rendered inside it.
 *
 * @typedef {{ record: OpenElement, host: Element, started: number, kept: boolean }} Frame
 */

/**
 * The mutable form of `ElementUpdate`. The report hands out the same objects
 * under their readonly type once recording has stopped.
 *
 * @typedef {{
 *   kind: 'element',
 *   tag: string,
 *   cause: ElementUpdateCause,
 *   properties: string[],
 *   at: number,
 *   durationMs: number,
 *   children: UpdateRecord[],
 * }} OpenElement
 */

/** @typedef {{ name: string, updates: number, durationMs: number, changed: number }} Counter */

const DEFAULT_LIMIT = 5000;

/** What a binding compiled before this module could label it is called in a report. */
const UNLABELLED = 'an unlabelled binding';

/**
 * Where each compiled binding is written, keyed by the evaluator the template
 * commits. Set while compiling, read only while recording.
 *
 * @type {WeakMap<object, string>}
 */
const labels = new WeakMap();

/** @type {Recording | null} */
let active = null;

/** @type {() => void} */
const NO_ELEMENT_RECORD = () => {};

/** @type {(changed: boolean) => void} */
const NO_BINDING_RECORD = () => {};

/**
 * Start recording updates, and return the call that stops it and reads the report.
 *
 * One recording at a time. A second one would have to decide what to do about the
 * records already open in the first, and there is no useful answer: the honest
 * failure is louder than a silently split report.
 *
 *     const stop = recordUpdates();
 *     await userDoesTheSlowThing();
 *     console.log(formatUpdateReport(stop()));
 *
 * @param {UpdateRecordingOptions} [options]
 * @returns {StopRecording}
 */
export function recordUpdates(options) {
  if (active !== null) {
    throw new Error('An update recording is already running. Stop it before starting another.');
  }
  const recording = new Recording(options?.limit ?? DEFAULT_LIMIT);
  active = recording;
  return () => {
    if (active === recording) active = null;
    return recording.stop();
  };
}

/**
 * Whether a recording is running. The instrumented paths ask before doing any
 * work a report would need; application code rarely has a reason to.
 *
 * @returns {boolean}
 */
export function isRecordingUpdates() {
  return active !== null;
}

/**
 * Open an element render. The returned call closes it.
 *
 * @param {Element} host
 * @param {ElementUpdateCause} cause
 * @returns {() => void}
 * @internal
 */
export function beginElementUpdate(host, cause) {
  if (active === null) return NO_ELEMENT_RECORD;
  return active.openElement(host, cause);
}

/**
 * Name the reactive properties Lit reported changed for the render now open.
 *
 * Separate from `beginElementUpdate` because the two facts arrive at different
 * moments: the render starts before Lit has decided anything, and the changed
 * set reaches the element in `updated()`, inside that same render.
 *
 * @param {Element} host
 * @param {Iterable<PropertyKey>} changed
 * @internal
 */
export function noteElementProperties(host, changed) {
  if (active === null) return;
  active.noteProperties(host, changed);
}

/**
 * Open a binding evaluation. The returned call closes it, and takes whether the
 * value it committed differs from the one the binding held.
 *
 * @param {object} evaluate The compiled evaluator, as its own identity.
 * @param {BindingUpdateCause} cause
 * @returns {(changed: boolean) => void}
 * @internal
 */
export function beginBindingUpdate(evaluate, cause) {
  if (active === null) return NO_BINDING_RECORD;
  return active.openBinding(evaluate, cause);
}

/**
 * Record where a compiled binding is written, so a report can name it.
 *
 * Called by the compiler for every binding it emits, recording or not: a binding
 * is compiled once and a recording usually starts long after.
 *
 * @param {object} evaluate
 * @param {string} where
 * @internal
 */
export function labelBinding(evaluate, where) {
  labels.set(evaluate, where);
}

/**
 * One recording: the tree, the two summaries, and the stack that nests them.
 *
 * The limit bounds the tree rather than the summaries. A recording left running
 * across a long session would otherwise retain a record per binding evaluation
 * and change the thing it was measuring; the counts stay exact because they cost
 * one map entry per distinct tag or binding however many updates there are.
 */
class Recording {
  #limit;

  #startedAt = performance.now();

  /** @type {UpdateRecord[]} */
  #records = [];

  /** @type {Frame[]} */
  #frames = [];

  #retained = 0;

  #dropped = 0;

  /** @type {Map<string, Counter>} */
  #elements = new Map();

  /** @type {Map<string, Counter>} */
  #bindings = new Map();

  /** @type {UpdateReport | undefined} */
  #report;

  /** @param {number} limit */
  constructor(limit) {
    this.#limit = limit;
  }

  /**
   * @param {Element} host
   * @param {ElementUpdateCause} cause
   * @returns {() => void}
   */
  openElement(host, cause) {
    const started = performance.now();

    /** @type {OpenElement} */
    const record = {
      kind: 'element',
      tag: host.localName,
      cause,
      properties: [],
      at: started - this.#startedAt,
      durationMs: 0,
      children: [],
    };

    /** @type {Frame} */
    const frame = { record, host, started, kept: this.#retain(record) };
    this.#frames.push(frame);
    return () => this.#closeElement(frame);
  }

  /**
   * @param {Element} host
   * @param {Iterable<PropertyKey>} changed
   */
  noteProperties(host, changed) {
    const frame = this.#frames.at(-1);
    if (frame === undefined || frame.host !== host || !frame.kept) return;
    for (const name of changed) frame.record.properties.push(String(name));
  }

  /**
   * @param {object} evaluate
   * @param {BindingUpdateCause} cause
   * @returns {(changed: boolean) => void}
   */
  openBinding(evaluate, cause) {
    const started = performance.now();
    return (changed) => {
      const durationMs = performance.now() - started;
      const binding = labels.get(evaluate) ?? UNLABELLED;
      count(this.#bindings, binding, durationMs, changed);
      this.#retain({
        kind: 'binding',
        binding,
        cause,
        changed,
        at: started - this.#startedAt,
        durationMs,
      });
    };
  }

  /** @returns {UpdateReport} */
  stop() {
    this.#report ??= {
      startedAt: this.#startedAt,
      durationMs: performance.now() - this.#startedAt,
      records: this.#records,
      elements: rank(this.#elements),
      bindings: rank(this.#bindings),
      dropped: this.#dropped,
    };
    return this.#report;
  }

  /**
   * Put a record where it belongs, or drop it.
   *
   * A record whose parent was dropped is dropped with it, so the tree never holds
   * a child whose context is missing.
   *
   * @param {UpdateRecord} record
   * @returns {boolean} Whether it was retained.
   */
  #retain(record) {
    const parent = this.#frames.at(-1);
    if ((parent !== undefined && !parent.kept) || this.#retained >= this.#limit) {
      this.#dropped += 1;
      return false;
    }
    this.#retained += 1;
    if (parent === undefined) this.#records.push(record);
    else parent.record.children.push(record);
    return true;
  }

  /**
   * Close a render, and anything a throw left open above it.
   *
   * Truncating rather than popping is what keeps the stack honest when a render
   * throws past its own close: the alternative is a frame that stays on top
   * forever and adopts every later record as a child.
   *
   * @param {Frame} frame
   */
  #closeElement(frame) {
    const index = this.#frames.lastIndexOf(frame);
    if (index === -1) return;
    this.#frames.length = index;
    frame.record.durationMs = performance.now() - frame.started;
    count(this.#elements, frame.record.tag, frame.record.durationMs, false);
  }
}

/**
 * @param {Map<string, Counter>} into
 * @param {string} name
 * @param {number} durationMs
 * @param {boolean} changed
 */
function count(into, name, durationMs, changed) {
  let entry = into.get(name);
  if (entry === undefined) {
    entry = { name, updates: 0, durationMs: 0, changed: 0 };
    into.set(name, entry);
  }
  entry.updates += 1;
  entry.durationMs += durationMs;
  if (changed) entry.changed += 1;
}

/**
 * Heaviest first, then busiest. Time is the ordering a slow update is found by;
 * the count breaks ties, which is how a binding that costs nothing each time and
 * runs four hundred times still reaches the top of its group.
 *
 * @param {Map<string, Counter>} counters
 * @returns {UpdateCount[]}
 */
function rank(counters) {
  return [...counters.values()].sort(
    (left, right) => right.durationMs - left.durationMs || right.updates - left.updates,
  );
}
