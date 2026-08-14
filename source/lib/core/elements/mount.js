/**
 * Dynamic mounting: turning "show this view here, now" into one mounted custom
 * element.
 *
 * Three callers need the same transaction — `<x-outlet>` swapping its child when
 * a signal changes, the router mounting one level of the matched chain, and
 * `@core/remotes/mfe.js` mounting a remote's root — so the rules live here once
 * and each caller describes *what* to mount as a `MountRequest`. What stays with
 * each of them is genuinely its own: the outlet owns a signal, the router owns the
 * frame chain and its outlets, and `mfe.js` owns the revocable host context,
 * because capability lifetime is a security boundary rather than a mounting one.
 *
 * The unified rules:
 *
 *   - A tag already defined is instantiated without calling `load`, so a second
 *     visit to a lazily loaded view costs nothing.
 *   - A tag still undefined after its `load` resolved is an error naming the tag,
 *     not an indefinite wait: `defineComponent` is awaited at the end of a
 *     component module, so an import that resolves without defining the element is
 *     a bug in that module, and a blank view is the worst way to report it.
 *   - Interleaving is settled by generation, not cancellation. Two swaps in quick
 *     succession both run to the point of having an element and the older one
 *     discards its own work: `MountSequence` hands out one `MountAttempt` per
 *     swap, every await is followed by asking whether it is still current, and
 *     that answer is what pairs a `create` with its `release`.
 */

import { resolveTag } from '@core/elements/component.js';

/** @import { MountRequest } from '@core/elements/types.js' */

/**
 * A mount could not be completed. `where` is the caller as it appears at the
 * front of the message — `<x-outlet>`, `Route "/users"`, `Remote "billing"` —
 * kept as a field so a shell-level handler can group failures by their source
 * without parsing the message.
 */
export class MountError extends Error {
  /** @type {string} */
  where;

  /**
   * @param {string} where
   * @param {string} detail
   */
  constructor(where, detail) {
    super(`${where} ${detail}`);
    this.name = 'MountError';
    this.where = where;
  }
}

/* ── Load and definition ───────────────────────────────────────────────── */

/**
 * Resolve the custom element a request names, loading its module first when that
 * element is not defined yet.
 *
 * Returns `undefined` only when the request names no tag at all, which is a
 * caller-level fact rather than a failure: a route level may exist to contribute
 * a path prefix and a guard and render nothing. Every other unhappy path throws.
 *
 * What `load` resolves to is read as a component reference when the request named
 * none itself. That is how a caller discovers what it is mounting while loading
 * it — `load: () => import('./users-page.js').then((m) => m.UsersPage)`, the shape
 * a lazy route uses, and the reason no route table repeats a tag string.
 *
 * @param {MountRequest} request
 * @returns {Promise<string | undefined>}
 */
export async function defineTag(request) {
  const named = readTag(request);
  if (named !== undefined && customElements.get(named) !== undefined) return named;

  if (request.load === undefined) {
    if (named === undefined) return undefined;
    throw new MountError(
      request.where,
      `names <${named}>, which is not a defined custom element and has no \`load\` function ` +
        `to define it.`,
    );
  }

  const loaded = await request.load();

  const tag = named ?? resolveTag(loaded);
  if (tag === undefined) return undefined;
  if (customElements.get(tag) === undefined) {
    throw new MountError(
      request.where,
      `names <${tag}>, still undefined after \`load\` resolved. The loaded module must define ` +
        `it while it evaluates, which is what \`await defineComponent({ tag: '${tag}', ... })\` ` +
        `at the end of a component module does.`,
    );
  }
  return tag;
}

/* ── Instantiation ─────────────────────────────────────────────────────── */

/**
 * Produce the element a request names: load it if needed, build it, validate it,
 * and assign its properties.
 *
 * `null` means the request names nothing to mount, exactly as `defineTag`
 * returns `undefined`. A request carrying `create` never returns null, and a
 * caller for which "nothing" is not a legal answer should use `requireElement`.
 *
 * The element is *not* inserted anywhere. Placement is the caller's, because
 * where a view goes is the one part of this that genuinely differs: the outlet
 * is its own container, and the router has to find the ancestor outlet the level
 * belongs in, after tearing down the level it replaces.
 *
 * @param {MountRequest} request
 * @returns {Promise<HTMLElement | null>}
 */
export async function createElement(request) {
  const { create } = request;
  const element =
    create === undefined ? await fromTag(request) : await fromFactory(request, create);
  if (element === null) return null;

  // Properties, not attributes. Attributes stringify, which would turn an object
  // of props into "[object Object]".
  Object.assign(element, request.props ?? {});
  return element;
}

/**
 * As `createElement`, for a caller whose request must produce an element.
 *
 * @param {MountRequest} request
 * @returns {Promise<HTMLElement>}
 */
export async function requireElement(request) {
  const element = await createElement(request);
  if (element === null) {
    throw new MountError(request.where, 'names no custom element to mount.');
  }
  return element;
}

/**
 * @param {MountRequest} request
 * @returns {Promise<HTMLElement | null>}
 */
async function fromTag(request) {
  const tag = await defineTag(request);
  if (tag === undefined) return null;
  return document.createElement(tag);
}

/**
 * A request that builds its own element still has its result validated, and for
 * a stronger reason than the tag path: `create` is where a route's `mount()` and
 * a remote's `mount(host)` cross into code this module did not write. A factory
 * that returns the wrong thing has to fail here, naming what it returned, rather
 * than at the `replaceChildren` that would otherwise reject it without context.
 *
 * @param {MountRequest} request
 * @param {NonNullable<MountRequest['create']>} create
 * @returns {Promise<HTMLElement>}
 */
async function fromFactory(request, create) {
  const created = await create();
  if (!(created instanceof HTMLElement)) {
    throw new MountError(request.where, 'mount() did not return an HTMLElement.');
  }

  const tag = readTag(request);
  if (tag === undefined) return created;

  if (created.localName !== tag) {
    throw new MountError(
      request.where,
      `names <${tag}> but its mount() returned <${created.localName}>.`,
    );
  }
  if (customElements.get(tag) === undefined) {
    throw new MountError(
      request.where,
      `names <${tag}>, which its mount() returned without defining as a custom element.`,
    );
  }
  return created;
}

/**
 * The tag a request names, whether it named it as a tag, as a component class or
 * as a definition. One resolution point, in `@core/elements/component.js`, so a class is
 * what every caller may hold and no caller has to know how to read a tag out of
 * one.
 *
 * @param {MountRequest} request
 * @returns {string | undefined}
 */
function readTag(request) {
  return resolveTag(request.tag);
}

/* ── Cancellation and replacement ──────────────────────────────────────── */

/**
 * One caller's series of mounts, of which only the newest may complete.
 *
 * Two navigations in quick succession start two mounts; if the first one's module
 * is slow and the second one's is cached, the slow one resolves last and would
 * win, leaving the wrong view on screen. Each mount claims an attempt, and an
 * attempt that is no longer the newest abandons its own work instead.
 *
 * A router shares one sequence between navigation and mounting deliberately:
 * "this navigation has been superseded" and "this mount has been superseded" are
 * the same fact, and keeping two counters for it is how a guard that resolves
 * late gets to publish a URL nobody asked for.
 */
export class MountSequence {
  #generation = 0;

  /**
   * Claim the sequence for a new attempt, superseding whichever attempt was
   * running.
   *
   * @returns {MountAttempt}
   */
  begin() {
    this.#generation += 1;
    return new MountAttempt(this, this.#generation);
  }

  /**
   * Supersede the running attempt without starting one. What a router's `stop`
   * and an outlet's teardown need: nothing further may mount, and nothing new is
   * being asked for.
   */
  cancel() {
    this.#generation += 1;
  }

  /**
   * @param {number} generation
   * @returns {boolean}
   */
  holds(generation) {
    return generation === this.#generation;
  }
}

/**
 * One mount, from a caller's point of view. Obtained from `MountSequence.begin`.
 */
export class MountAttempt {
  #sequence;
  #generation;

  /**
   * @param {MountSequence} sequence
   * @param {number} generation
   */
  constructor(sequence, generation) {
    this.#sequence = sequence;
    this.#generation = generation;
  }

  /** Whether this attempt is still the newest of its sequence. */
  get live() {
    return this.#sequence.holds(this.#generation);
  }

  /**
   * Keep `element` only while this attempt is current, releasing it otherwise.
   *
   * This is the call that goes after every await in an adapter, and the reason
   * `release` is part of a request: an element built by a `create` that acquired
   * resources still has to be torn down when it never reaches the DOM, and a
   * bare generation check would silently leak it.
   *
   * @param {HTMLElement | null} element
   * @param {MountRequest} request
   * @returns {Promise<boolean>}
   */
  async keep(element, request) {
    if (this.live) return true;
    if (element !== null) await request.release?.(element);
    return false;
  }

  /**
   * Place `element` in `container`, replacing whatever it held, when this attempt
   * is still current. Releases the element and returns false otherwise.
   *
   * A null element is legal and places nothing: a request that names nothing to
   * mount still has to be checked for staleness by the caller that asked for it.
   *
   * @param {HTMLElement} container
   * @param {HTMLElement | null} element
   * @param {MountRequest} request
   * @returns {Promise<boolean>}
   */
  async place(container, element, request) {
    if (!(await this.keep(element, request))) return false;
    if (element !== null) container.replaceChildren(element);
    return true;
  }
}
