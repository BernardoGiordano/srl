/**
 * The three things every other subsystem depends on: a signal, a typed key for
 * the injector, and the clock a scheduled callback goes through.
 *
 * Nothing here belongs to one subsystem, which is the test for being in this
 * file. Everything else lives beside the code it describes.
 */

import type { ReadonlySignal, Signal } from '@preact/signals-core';

export type { ReadonlySignal, Signal };

/**
 * A typed key for the injector. The phantom `__type` field never exists at
 * runtime; it is the only way to carry `T` through a value in JSDoc-land.
 */
export interface InjectionToken<T> {
  readonly description: string;
  readonly __type?: T;
}

export type Provider<T> = () => T;

/**
 * Somewhere for a delayed callback to go that is not the wall clock. ADR-0079.
 *
 * One method, because a debounce needs one thing: schedule this, and give me the
 * call that undoes it. Cancelling is the returned closure rather than a handle,
 * so a handle can never reach a clock other than the one that issued it.
 */
export interface Clock {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ClockConfig {
  /** Defaults to real `setTimeout` timers. */
  readonly clock?: Clock;
}

/** The test clock `createManualClock()` returns: a Clock plus the two controls a suite uses. */
export interface ManualClock extends Clock {
  /** How many scheduled callbacks are waiting. */
  readonly pending: number;
  /** Run everything waiting, in the order it came due. */
  flush(): void;
}
