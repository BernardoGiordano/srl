/**
 * The shape of a recorded journey run.
 *
 * One file, read by the documentation check and written by the recorder. It holds what a
 * run observed rather than whether it was green, because a matrix generated from "green"
 * can only say "green".
 */

/** One step of the journey, and the readings it took. */
export interface StepRecord {
  id: string;
  title: string;
  observed: Record<string, unknown>;
}

/** One engine's run of the whole journey. */
export interface EngineRecord {
  id: string;
  title: string;
  /** The rendering engine, which is what a support claim is about. */
  engine: string;
  /** The browser build that ran, as it reports itself. */
  version: string;
  /** The key this engine reaches the next control with. */
  nextControl: string;
  outcome: 'passed' | 'failed';
  durationMs: number;
  failure?: string;
  steps: StepRecord[];
}

export interface JourneyRecord {
  /** The date of the run, not of the file. */
  recordedAt: string;
  /** The application whose built artifact was driven. */
  app: string;
  /** The entry document's Content-Security-Policy, as the build emitted it. */
  csp: string;
  machine: {
    platform: string;
    release: string;
    arch: string;
    cpu: string;
    node: string;
  };
  driver: { name: string; version: string };
  engines: EngineRecord[];
}

/** One manual check against a real screen reader, recorded by the person who ran it. */
export interface AssistiveCheck {
  /** The screen reader and the browser it was driven with. */
  reader: string;
  browser: string;
  platform: string;
  /** The date it was run. A record with no date is an opinion. */
  checkedAt: string;
  /** The journey step ids this pass covered. */
  steps: string[];
  outcome: 'passed' | 'passed-with-notes' | 'failed';
  notes: string;
}

export interface AssistiveRecord {
  /** What a manual pass is expected to cover, so a gap in the list is visible. */
  checks: AssistiveCheck[];
}
