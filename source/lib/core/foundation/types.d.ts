/**
 * The two things every other subsystem depends on: a signal, and a typed key for
 * the injector.
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
