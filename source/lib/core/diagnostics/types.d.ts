/**
 * What an update report holds. Two update paths produce records, both named by
 * `@core/diagnostics/updates.js`: an element render and a compiled binding patch.
 */

/**
 * Why an element rendered, as the render path itself knew it.
 *
 *  - `mount`      the first render after the element connected.
 *  - `signal`     a signal read by `render()` changed, so the tracking effect
 *                 re-ran and asked Lit for another render.
 *  - `properties` something wrote a reactive property, or called `requestUpdate()`.
 *  - `reconnect`  the element re-entered the DOM and rebuilt its tracking.
 *  - `template`   an edit to the element's `.html` file replaced its compiled
 *                 template, so the same host rendered new markup. Development only.
 *  - `definition` an edit to the element's `.js` file replaced its class body, so
 *                 the same host rendered from new code. Development only.
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
 *  - `mount`     first commit into this Part.
 *  - `signal`    a signal the expression read changed. The binding's own effect
 *                re-ran and patched its Part; no element rendered.
 *  - `rerender`  the scope it reads bumped its version: the host rendered, or its
 *                `*for` row was given a different item.
 *  - `rebind`    the Part now holds a different expression or a different scope,
 *                which is what an `*if` branch flip and a keyed move look like.
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
  /** Where the expression is written: `employees-page.html {{ employee.name }}`. */
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
  /** Bindings only: how many updates committed a different value. Always 0 for an element. */
  readonly changed: number;
}

export interface UpdateReport {
  /** `performance.now()` when recording started. */
  readonly startedAt: number;
  readonly durationMs: number;
  /** Element renders, and the binding patches that happened outside one. */
  readonly records: readonly UpdateRecord[];
  /** Every tag that rendered, heaviest first. */
  readonly elements: readonly UpdateCount[];
  /** Every binding that re-evaluated, heaviest first. */
  readonly bindings: readonly UpdateCount[];
  /** Records the limit refused to retain. They are counted in the summaries either way. */
  readonly dropped: number;
}

export interface UpdateRecordingOptions {
  /** How many records to retain before dropping them. Defaults to 5000. */
  readonly limit?: number;
}

/** Stop the recording and read what it saw. Calling it again returns the same report. */
export type StopRecording = () => UpdateReport;
