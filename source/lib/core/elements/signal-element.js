import { LitElement } from 'lit';
import { effect } from '@core/foundation/reactive.js';
import { beginElementUpdate, noteElementProperties } from '@core/diagnostics/updates.js';
import { captureContent, projectContent } from '@core/elements/projection.js';
import { templateFor } from '@core/template/template.js';

/** @import { ElementUpdateCause } from '@core/diagnostics/types.js' */
/** @import { ContentBuckets } from '@core/elements/types.js' */

/**
 * The base class every component extends: Angular's
 * `ChangeDetectionStrategy.OnPush` plus signals, in about eighty lines.
 *
 * Five responsibilities:
 *
 *  1. Render into light DOM, so Tailwind utility classes apply. See projection.js
 *     for why shadow DOM is off the table.
 *  2. Re-render when a signal read by a JavaScript `render()` changes. Compiled
 *     templates track and update each binding independently in template.js.
 *  3. Project authored children at `<x-content>` markers.
 *  4. Expose a lifetime AbortSignal so listeners and timers clean themselves up.
 *  5. Render the component's `.html` template, so `render()` need not be written
 *     at all. Override it and declare `template: false` when a component's markup
 *     is trivial or entirely computed.
 *
 * A base class rather than a mixin: a mixin's added members are close to
 * impossible to express in JSDoc without hand-writing a declaration file for its
 * return type, and a plain base class types itself for free.
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
   * Why the next render is happening.
   *
   * Only the paths that schedule a render can say. The tracking effect knows a
   * signal woke it, `connectedCallback` knows the element came back, and
   * `renderRevisedTemplate` and `renderRevisedDefinition` know an edit replaced
   * the markup or the class. Every other route to `requestUpdate()` is a property
   * write, which is what the default says. Read and reset by `performUpdate`, and
   * reported to `@core/diagnostics/updates.js`. ADR-0109.
   *
   * @type {ElementUpdateCause}
   */
  #updateCause = 'properties';

  /**
   * Hand every class field back to the reactive accessor it shadowed.
   *
   * `static properties = { open: {...} }` makes Lit define an accessor on the
   * prototype. Writing the default next to it — `open = false` — is the shape
   * every Lit example uses, and in plain JavaScript it silently breaks the
   * property: a class field is installed with [[Define]], not [[Set]], so it
   * creates an *own* data property that shadows the accessor. From then on
   * `this.open = true` writes a plain value with no `requestUpdate`, no re-render
   * and no reflection, and nothing throws.
   *
   * Lit solves this in its own constructor, but subclass field initialisers run
   * *after* the base constructor returns. TypeScript escapes it by compiling
   * fields down to assignments; there is no compile step here, which is why it
   * has to be handled at runtime.
   *
   * Delete, then assign: the delete uncovers the accessor and the assignment goes
   * through it, so the value survives and reactivity starts working.
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
   * Light DOM. Returning `this` means lit-html patches our own children rather
   * than a shadow root's, which is what lets Tailwind's document-level
   * stylesheet reach them.
   *
   * @returns {HTMLElement}
   */
  createRenderRoot() {
    return this;
  }

  /**
   * A DOM `AbortSignal` (not a reactive signal, despite living on a class called
   * SignalElement) that aborts when the element leaves the DOM. Angular's
   * `DestroyRef`, and the reason this codebase has no manual `removeEventListener`
   * calls:
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
    // Before anything reads a declared property, including the first render.
    this.#adoptShadowedFields();

    // Must happen before the first render. lit-html clears its container, and
    // the authored children are gone by the time any Lit hook could see them.
    this.#content ??= captureContent(this);

    super.connectedCallback();

    // Re-entering the DOM after a move. Tracking was torn down on disconnect,
    // so nothing is listening to signals any more. Without this the element
    // renders once and then silently stops reacting.
    if (this.#hasRendered && this.#disposeTracking === undefined) {
      this.#updateCause = 'reconnect';
      this.requestUpdate();
    }

    // A component that projects content renders immediately, not next microtask:
    // its authored children have just been removed and are in no document until
    // this render puts them back, which a parent's `firstUpdated` can observe.
    // ADR-0019. Elements with no projected content keep the asynchronous default.
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
   * Dependency tracking.
   *
   * A JavaScript-authored `render()` runs inside an effect, so every signal it
   * reads is recorded; when one changes the effect re-runs and hands control back
   * to Lit's scheduler with `requestUpdate()` instead of rendering itself.
   * Compiled `.html` templates do not read their expressions here — their binding
   * directives each own an effect and patch their own Lit Part.
   *
   * The second pass reads no signals, so this effect ends with an empty
   * dependency set and never fires again. It does not need to: the
   * `requestUpdate()` schedules another `performUpdate()`, which disposes this
   * effect and builds a fresh one that re-records dependencies. Rebuilding is the
   * point — a template branching on `user.value` reads different signals in each
   * branch, and a set captured once would go stale when the branch flipped.
   */
  performUpdate() {
    if (!this.isUpdatePending) return;

    this.#disposeTracking?.();

    // Read before the render, reset before it: anything that schedules the *next*
    // render during this one is describing that one, not this one.
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
    // Inside the render `performUpdate` opened, and the first point at which Lit
    // has said which properties moved.
    noteElementProperties(this, changed.keys());
    if (this.#content !== undefined) projectContent(this, this.#content);
  }

  /**
   * Render the compiled `.html` template against this instance.
   *
   * Synchronous, and it has to be: Lit's render is synchronous, so a template
   * still in flight would mean rendering nothing and patching it in later. That
   * is why `defineComponent` attaches the template *before* registering the
   * element — by the time an instance can exist, its template is compiled and
   * waiting. Reaching this error means the element was registered with a bare
   * `customElements.define` instead.
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
   * Render markup that has replaced this element's template.
   *
   * Development only, and called by `@core/template/template.js` when an edited
   * `.html` file compiles. The attachment has already been replaced by then, so
   * this asks for a render and names the reason it is happening — `render()` reads
   * the current attachment and finds the new one. ADR-0111.
   */
  renderRevisedTemplate() {
    this.#updateCause = 'template';
    this.requestUpdate();
  }

  /**
   * Render after this element's class body was replaced.
   *
   * Development only, and called by `@core/elements/component.js` when an edited
   * `.js` file is adopted. The methods and accessors this render will run are
   * already the new ones; what this adds is the render itself and the reason for
   * it. ADR-0113.
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
 * Delete an own property and write its value back, so the write lands on the
 * accessor the own property was hiding.
 *
 * A free function rather than three lines inline, because the cast it needs
 * would otherwise be an alias of `this`, which the linter refuses — and it is
 * right to: `this` in a loop body is how the wrong object gets mutated.
 *
 * @param {Record<PropertyKey, unknown>} target
 * @param {PropertyKey} name
 */
function reassignThroughAccessor(target, name) {
  const value = target[name];
  delete target[name];
  target[name] = value;
}
