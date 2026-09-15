/**
 * Typed JSON reading.
 *
 * `Response.json()` and `Request.json()` return `Promise<any>`, which spreads through
 * every caller and trips typescript-eslint's `no-unsafe-*` rules. A JSDoc cast satisfies
 * tsc but leaves no assertion node for ESLint to see.
 *
 * This function types its parameter as `{ json(): Promise<unknown> }`, so the value is
 * `unknown` inside and the cast to `T` is an ordinary assertion.
 *
 *     const session = await readJson(response);   // typed by the call site
 *
 * `readJson` asserts a shape without checking it. For data that crosses a trust
 * boundary, read `unknown` and validate it by hand, as `admitManifest` in
 * `@core/remotes/manifest-policy.js` does.
 */

/**
 * @template T
 * @param {{ json(): Promise<unknown> }} source
 * @returns {Promise<T>}
 */
export async function readJson(source) {
  return /** @type {T} */ (await source.json());
}
