/**
 * What an update report holds. Both update paths report through
 * `@core/diagnostics/updates.js`, element renders and compiled binding patches alike.
 */

/**
 * Why an element rendered.
 *
 *  - `mount`      the first render after connecting.
 *  - `signal`     a signal read by `render()` changed.
 *  - `properties` a reactive property was written, or `requestUpdate()` was called.
 *  - `reconnect`  the element re-entered the DOM and rebuilt its tracking.
 *  - `template`   an edit replaced the element's `.html` template. Development only.
 *  - `definition` an edit replaced the element's class body. Development only.
 */
export type ElementUpdateCause =
  | 'mount'
  | 'signal'
  | 'properties'
  | 'reconnect'
  | 'template'
  | 'definition';

/**
 * Why a compiled binding re-evaluated.
 *
 *  - `mount`     the first commit into this Part.
 *  - `signal`    a signal the expression read changed, and no element rendered.
 *  - `rerender`  the host rendered, or the `*for` row got a new item.
 *  - `rebind`    the Part holds a different expression or scope, as after an `*if`
 *                flip or a keyed move.
 *  - `reconnect` the directive reconnected and rebuilt its effect.
 */
export type BindingUpdateCause = 'mount' | 'signal' | 'rerender' | 'rebind' | 'reconnect';

export interface ElementUpdate {
  readonly kind: 'element';
  /** Lowercase tag name, as `document.querySelector` would take it. */
  readonly tag: string;
  readonly cause: ElementUpdateCause;
  /** Reactive properties Lit reported changed. */
  readonly properties: readonly string[];
  /** Milliseconds after the recording started. */
  readonly at: number;
  readonly durationMs: number;
  /** Renders and patches that happened inside this one, in the order they ran. */
  readonly children: readonly UpdateRecord[];
}

export interface BindingUpdate {
  readonly kind: 'binding';
  /** Where the expression is written, such as `employees-page.html {{ employee.name }}`. */
  readonly binding: string;
  readonly cause: BindingUpdateCause;
  /** Whether the value it committed differs from the one it held. */
  readonly changed: boolean;
  readonly at: number;
  readonly durationMs: number;
}

export type UpdateRecord = ElementUpdate | BindingUpdate;

/** One row of a report summary: everything one tag or one binding did. */
export interface UpdateCount {
  readonly name: string;
  readonly updates: number;
  readonly durationMs: number;
  /** How many updates committed a different value. Always 0 for elements. */
  readonly changed: number;
}

export interface UpdateReport {
  /** `performance.now()` when recording started. */
  readonly startedAt: number;
  readonly durationMs: number;
  /** Element renders, plus binding patches that happened outside one. */
  readonly records: readonly UpdateRecord[];
  /** Every tag that rendered, heaviest first. */
  readonly elements: readonly UpdateCount[];
  /** Every binding that re-evaluated, heaviest first. */
  readonly bindings: readonly UpdateCount[];
  /** Records beyond the limit. The summaries still count them. */
  readonly dropped: number;
}

export interface UpdateRecordingOptions {
  /** How many records to retain before dropping them. Defaults to 5000. */
  readonly limit?: number;
}

/** Stop the recording and read what it saw. Calling it again returns the same report. */
export type StopRecording = () => UpdateReport;
