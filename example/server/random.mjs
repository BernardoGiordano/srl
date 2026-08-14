/**
 * A seeded generator, so the dataset is the same on every boot.
 *
 * `Math.random()` would make every restart a different fixture: a screenshot in a
 * bug report would not reproduce, and the smoke test could not assert a row it
 * expects to exist. The algorithm is mulberry32 — thirty-two bits of state, no
 * dependency, and adequate for shaping example data.
 *
 * @param {number} seed
 * @returns {{ next: () => number, int: (max: number) => number, pick: <T>(values: readonly T[]) => T }}
 */
export function createRandom(seed) {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  /** @param {number} max */
  const int = (max) => Math.floor(next() * max);

  /**
   * @template T
   * @param {readonly T[]} values
   * @returns {T}
   */
  const pick = (values) => {
    const value = values[int(values.length)];
    // `noUncheckedIndexedAccess` is on, and the assertion is real: the index is
    // bounded by the length, so the only way here is an empty array, which is a
    // caller bug rather than a data condition.
    if (value === undefined) throw new Error('pick() on an empty array.');
    return value;
  };

  return { next, int, pick };
}
