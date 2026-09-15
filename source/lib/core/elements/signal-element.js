import { LitElement } from 'lit';
import { effect } from '@core/foundation/reactive.js';
import { beginElementUpdate, noteElementProperties } from '@core/diagnostics/updates.js';
import { captureContent, projectContent } from '@core/elements/projection.js';
import { templateFor } from '@core/template/template.js';

/** @import { ElementUpdateCause } from '@core/diagnostics/types.js' */
/** @import { ContentBuckets } from '@core/elements/types.js' */

/**
 * Classes whose fields passed the hidden-member check. One instance answers for its
 * class, and a failing class keeps reporting.
 *
 * @type {WeakSet<Function>}
 */
const membersChecked = new WeakSet();

/**
 * The base class every component extends. It pairs lit with signals, much like
 * Angular's `OnPush` change detection.
 *
 * - Renders into light DOM, so Tailwind utilities apply.
 * - Re-renders when a signal read by a JavaScript `render()` changes. Compiled
 *   templates update each binding on their own.
 * - Projects authored children at `<x-content>` markers.
 * - Exposes `lifetime`, an AbortSignal that aborts on disconnect.
 * - Renders the component's `.html` template by default.
 */
export class SignalElement extends LitElement {
  /** @type {(() => void) | undefined} */
  #disposeTracking;

  /** @type {ContentBuckets | undefined} */
  #content;

  /** @type {AbortController | undefined} */
  #lifetimeController;

  #hasRendered = false;

  #hasAdoptedFields = false;

  /**
   * Why the next render happens, reported to `@core/diagnostics/updates.js`.
   *
   * The paths that schedule a render set it: the tracking effect, a reconnect and
   * the two revision methods. Anything else is a property write, which is the
   * default.
   *
   * @type {ElementUpdateCause}
   */
  #updateCause = 'properties';

  /**
   * Route class fields back through the reactive accessors they shadow.
   *
   * `static properties` makes Lit define an accessor on the prototype. A field such
   * as `open = false` is installed with [[Define]], so it creates an own data
   * property that hides the accessor, and writes stop triggering updates.
   * TypeScript avoids this by compiling fields to assignments. With no compile
   * step, the fix happens at runtime.
   *
   * Deleting the own property uncovers the accessor, and reassigning the value goes
   * through it.
   */
  #adoptShadowedFields() {
    if (this.#hasAdoptedFields) return;
    this.#hasAdoptedFields = true;

    const declared = /** @type {{ elementProperties?: Map<PropertyKey, unknown> }} */ (
      /** @type {unknown} */ (this.constructor)
    ).elementProperties;
    if (declared === undefined) return;

    for (const name of declared.keys()) {
      if (!Object.hasOwn(this, name)) continue;
      reassignThroughAccessor(
        /** @type {Record<PropertyKey, unknown>} */ (/** @type {unknown} */ (this)),
        name,
      );
    }
  }

  /**
   * Throw when a field hides an inherited method.
   *
   * `render = 'state'` creates an own property that covers
   * `SignalElement.prototype.render`, and the first update calls a string. Every
   * field is checked, since a fixed list of lifecycle names would go stale.
   * Callable fields pass, and fields over reactive properties were already repaired
   * by `#adoptShadowedFields`.
   *
   * The check needs a live instance, because a class extending HTMLElement can't be
   * constructed before `define`. `cli/project-model/` reports the same mistake
   * statically, at its line.
   */
  #assertNoHiddenMembers() {
    const element = this.constructor;
    if (membersChecked.has(element)) return;

    for (const name of Reflect.ownKeys(this)) {
      const own = Object.getOwnPropertyDescriptor(this, name);
      if (own === undefined || !('value' in own) || typeof own.value === 'function') continue;
      const owner = hiddenMethodOwner(this, name);
      if (owner === undefined) continue;
      throw new Error(
        `<${this.tagName.toLowerCase()}> declares \`${String(name)}\` as a field. A class ` +
          `field is an own property, so it hides the \`${String(name)}()\` method inherited ` +
          `from ${owner} rather than overriding it, and the next call reaches ` +
          `${describeValue(own.value)} instead. Write it as a method, or rename the field.`,
      );
    }

    membersChecked.add(element);
  }

  /**
   * Render into the element itself, so the document's Tailwind stylesheet reaches
   * the markup.
   *
   * @returns {HTMLElement}
   */
  createRenderRoot() {
    return this;
  }

  /**
   * A DOM `AbortSignal` that aborts when the element leaves the DOM, like Angular's
   * `DestroyRef`. Pass it to listeners instead of removing them by hand.
   *
   *     window.addEventListener('resize', this.onResize, { signal: this.lifetime });
   *
   * @returns {AbortSignal}
   */
  get lifetime() {
    this.#lifetimeController ??= new AbortController();
    return this.#lifetimeController.signal;
  }

  connectedCallback() {
    // Before anything reads a declared property.
    this.#adoptShadowedFields();

    // Before anything calls a member a field could hide.
    this.#assertNoHiddenMembers();

    // Before the first render, because lit-html clears its container.
    this.#content ??= captureContent(this);

    super.connectedCallback();

    // A moved element lost its tracking on disconnect and must render to track again.
    if (this.#hasRendered && this.#disposeTracking === undefined) {
      this.#updateCause = 'reconnect';
      this.requestUpdate();
    }

    // A projecting component renders synchronously. Its children stay detached until
    // this render puts them back, and a parent's `firstUpdated` can observe that.
    if (this.#content !== undefined && this.#content.size > 0) this.performUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#disposeTracking?.();
    this.#disposeTracking = undefined;
    this.#lifetimeController?.abort();
    this.#lifetimeController = undefined;
    this.onDestroy();
  }

  /**
   * Track the signals a JavaScript `render()` reads.
   *
   * The render runs inside an effect. When a dependency changes, the effect calls
   * `requestUpdate()`, and the next update disposes this effect and records
   * dependencies again. A branch can read different signals on each render, so the
   * set is rebuilt every time. Compiled templates track each binding separately.
   */
  performUpdate() {
    if (!this.isUpdatePending) return;

    this.#disposeTracking?.();

    // Read and reset before rendering, so a render scheduled during this one reports
    // its own cause.
    const cause = this.#hasRendered ? this.#updateCause : 'mount';
    this.#updateCause = 'properties';

    let isRenderPass = true;
    this.#disposeTracking = effect(() => {
      if (isRenderPass) {
        isRenderPass = false;
        const finish = beginElementUpdate(this, cause);
        try {
          super.performUpdate();
        } finally {
          finish();
        }
        return;
      }
      this.#updateCause = 'signal';
      this.requestUpdate();
    });
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  firstUpdated(changed) {
    super.firstUpdated(changed);
    this.#hasRendered = true;
    this.onMount();
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    // The first point where Lit reports which properties changed.
    noteElementProperties(this, changed.keys());
    if (this.#content !== undefined) projectContent(this, this.#content);
  }

  /**
   * Render the compiled `.html` template against this instance.
   *
   * Lit renders synchronously, so the template must already be compiled.
   * `defineComponent` guarantees that by attaching it before `define`. The error
   * below means the element was registered with a bare `customElements.define`.
   *
   * @returns {unknown}
   */
  render() {
    const compiled = templateFor(this.constructor);
    if (compiled === undefined) {
      throw new Error(
        `<${this.tagName.toLowerCase()}> has no template. Either register it with ` +
          `\`await defineComponent({ tag, element, module: import.meta.url })\` and give it a ` +
          `sibling .html file, or declare \`template: false\` and override render() to build ` +
          `markup in JavaScript.`,
      );
    }
    return compiled(this);
  }

  /**
   * Render after an edit replaced this element's template. Development only, called
   * by `@core/template/template.js`. ADR-0111.
   */
  renderRevisedTemplate() {
    this.#updateCause = 'template';
    this.requestUpdate();
  }

  /**
   * Render after an edit replaced this element's class body. Development only,
   * called by `@core/elements/component.js`. ADR-0113.
   */
  renderRevisedDefinition() {
    this.#updateCause = 'definition';
    this.requestUpdate();
  }

  /** Called once, after the first render, with the DOM in place. */
  onMount() {}

  /** Called when the element leaves the DOM, after `lifetime` has aborted. */
  onDestroy() {}
}

/**
 * Delete an own property and write its value back through the accessor it hid.
 *
 * A function instead of inline code, because the cast would alias `this`, which the
 * linter refuses.
 *
 * @param {Record<PropertyKey, unknown>} target
 * @param {PropertyKey} name
 */
function reassignThroughAccessor(target, name) {
  const value = target[name];
  delete target[name];
  target[name] = value;
}

/**
 * The class whose prototype holds a callable `name`, or undefined.
 *
 * The first prototype with the name decides, since a call would reach it. An
 * accessor doesn't count, because reactive properties are accessors.
 *
 * @param {object} instance
 * @param {PropertyKey} name
 * @returns {string | undefined}
 */
function hiddenMethodOwner(instance, name) {
  let prototype = Reflect.getPrototypeOf(instance);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor !== undefined) {
      if (typeof descriptor.value !== 'function') return undefined;
      const owner = /** @type {{ constructor?: { name?: string } }} */ (prototype).constructor;
      const named = owner?.name;
      return named === undefined || named === '' ? 'a base class' : named;
    }
    prototype = Reflect.getPrototypeOf(prototype);
  }
  return undefined;
}

/**
 * How the error message names a field's value, such as `a string` or `null`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  const kind = typeof value;
  return kind === 'object' ? 'an object' : `a ${kind}`;
}
