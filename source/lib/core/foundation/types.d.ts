/**
 * Types every subsystem depends on: signals, injection tokens and the clock. Types that
 * belong to one subsystem live beside it.
 */

import type { ReadonlySignal, Signal } from '@preact/signals-core';

export type { ReadonlySignal, Signal };

/**
 * A typed key for the injector. The `__type` field never exists at runtime. It carries
 * `T` through a value for JSDoc.
 */
export interface InjectionToken<T> {
  readonly description: string;
  readonly __type?: T;
}

export type Provider<T> = () => T;

/**
 * Schedules delayed callbacks away from the wall clock. ADR-0079.
 *
 * `schedule` returns the call that cancels the callback, so a cancel always reaches the
 * clock that scheduled it.
 */
export interface Clock {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ClockConfig {
  /** Defaults to real `setTimeout` timers. */
  readonly clock?: Clock;
}

/** The test clock from `createManualClock()`. It adds two controls for tests. */
export interface ManualClock extends Clock {
  /** How many scheduled callbacks are waiting. */
  readonly pending: number;
  /** Run everything waiting, in the order it came due. */
  flush(): void;
}
