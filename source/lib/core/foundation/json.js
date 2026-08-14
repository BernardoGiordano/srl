/**
 * Typed JSON reading.
 *
 * `Response.json()` and `Request.json()` are declared `Promise<any>` by the DOM
 * lib, and that `any` spreads: every call site silently loses type safety, and
 * typescript-eslint's `no-unsafe-*` rules flag each one.
 *
 * A JSDoc cast does not fix the lint side of that, which is worth knowing before
 * committing to this architecture. `/** @type {Foo} *\/ (await r.json())`
 * satisfies tsc, but the JSDoc cast leaves no assertion node in the ESLint AST,
 * so the rule still sees `any` being assigned. Fighting that with per-site
 * disables would put a dozen suppressions across the codebase.
 *
 * Instead the parameter here is typed structurally as `{ json(): Promise<unknown> }`.
 * `Response` and `Request` both satisfy it, and inside this function the awaited
 * value is `unknown` rather than `any`, so narrowing it is an ordinary assertion
 * that no rule objects to. One function, no suppressions, and every caller gets a
 * real type.
 *
 *     const session = await readJson(response);   // typed by the call site
 *
 * `readJson` asserts a shape rather than checking it. Where the payload crosses a
 * trust boundary and must actually be validated, read it as `unknown` and narrow
 * by hand: see `assertManifest` and `assertRemoteModule` in @core/remotes/mfe.js.
 */

/**
 * @template T
 * @param {{ json(): Promise<unknown> }} source
 * @returns {Promise<T>}
 */
export async function readJson(source) {
  return /** @type {T} */ (await source.json());
}
