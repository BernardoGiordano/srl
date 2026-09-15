/**
 * Records why the page updated.
 *
 * There are two independent update paths. An element renders when a signal its
 * `render()` read changes or a reactive property is written. A compiled binding patches
 * its own lit Part when a signal its expression read changes, and no element renders
 * (ADR-0014). Timing only element renders would miss most updates in this framework.
 *
 * Both paths report here, and records nest. A binding patch during an element render is
 * a child of that render. A binding patch outside any render is a top-level record.
 *
 * `cause: 'signal'` means the effect re-ran. The reactive library doesn't report which
 * signal woke it, so reports don't name one.
 *
 * With nothing recording, each update costs one null check and one call to a shared
 * empty function. Compiling a template still labels its bindings, so a later recording
 * can name them.
 */

/** @import { BindingUpdateCause, ElementUpdateCause, StopRecording, UpdateCount, UpdateRecord, UpdateRecordingOptions, UpdateReport } from '@core/diagnostics/types.js' */

/**
 * One open element render, with what closing it needs. `host` lets
 * `noteElementProperties` confirm that it belongs to the top frame.
 *
 * @typedef {{ record: OpenElement, host: Element, started: number, kept: boolean }} Frame
 */

/**
 * The mutable form of `ElementUpdate`. The report returns the same objects under their
 * readonly type.
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

/** The name a binding without a label gets in a report. */
const UNLABELLED = 'an unlabelled binding';

/**
 * Where each compiled binding is written, keyed by its evaluator. Written while
 * compiling and read while recording.
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
 * Start recording updates, and return the call that stops recording and returns the
 * report.
 *
 * Only one recording runs at a time, because a second one couldn't sensibly share the
 * first one's open records.
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
 * Whether a recording is running. The instrumented paths check this before doing report
 * work.
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
 * Name the reactive properties Lit reported changed for the open render.
 *
 * Separate from `beginElementUpdate`, because Lit reports the changed set in
 * `updated()`, after the render starts.
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
 * Open a binding evaluation. The returned call closes it and takes whether the committed
 * value changed.
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
 * Record where a compiled binding is written, so a report can name it. The compiler
 * calls this for every binding, whether or not anything is recording.
 *
 * @param {object} evaluate
 * @param {string} where
 * @internal
 */
export function labelBinding(evaluate, where) {
  labels.set(evaluate, where);
}

/**
 * One recording, with its record tree, two summaries and the stack that nests records.
 *
 * The limit bounds the tree. The summaries stay exact, since they cost one entry per
 * distinct tag or binding.
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
   * Attach a record to its parent or to the top level, or drop it. A child of a dropped
   * parent is dropped too, so the tree never loses context.
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
   * Close a render and anything a throw left open above it. Truncating the stack keeps a
   * thrown render from adopting every later record.
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
 * Sort by total time, then by update count, so a cheap binding that runs hundreds of
 * times still ranks.
 *
 * @param {Map<string, Counter>} counters
 * @returns {UpdateCount[]}
 */
function rank(counters) {
  return [...counters.values()].sort(
    (left, right) => right.durationMs - left.durationMs || right.updates - left.updates,
  );
}
