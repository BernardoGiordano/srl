/**
 * Generate the same example data on every boot with mulberry32.
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
    // The index is in range when the caller supplies a nonempty array.
    if (value === undefined) throw new Error('pick() on an empty array.');
    return value;
  };

  return { next, int, pick };
}
