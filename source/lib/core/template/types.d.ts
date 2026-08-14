/**
 * The template pipeline's surface: what a binding target turned out to be, the
 * scope an expression sees, the AST the parser builds, and the opaque values the
 * security bypasses return.
 */

/**
 * The security context a bound value lands in, as named by `@core/template/dialect.js`.
 * `undefined` from `securityContextFor` means an ordinary sink where escaping is
 * enough. security.js turns these into sanitizers, the template checker turns
 * them into typed sink declarations.
 */
export type SecurityContext = 'html' | 'style' | 'url' | 'urlSet' | 'resourceUrl';

/** What the inside of a `[...]` binding turned out to be. */
export type BindingKind =
  | 'attribute'
  | 'boolean'
  | 'property'
  | 'empty-attribute'
  | 'empty-property'
  | 'inline-handler';

export interface TargetClassification {
  readonly kind: BindingKind;
  /** Camel-cased for `property`, stripped of `?` for `boolean`, empty for the errors. */
  readonly name: string;
}

/**
 * Variables a template expression can see beyond the component's own members:
 * `$event` inside an event binding, and the loop variables `*for` introduces.
 *
 * Prototype-chained rather than copied, so a nested `*for` sees the outer loop's
 * variables through the chain and building a row's scope stays O(1).
 */
export type TemplateLocals = Record<string, unknown>;

export interface Scope {
  /** The component instance. Only its public members are reachable. */
  readonly host: Record<string, unknown>;
  readonly locals: TemplateLocals;
  /**
   * Bumped whenever anything this scope exposes may have changed: a Lit render
   * of the host, or new `*for` locals for this row. A scope keeps its identity
   * for the life of its host or its row, so bindings compare this number rather
   * than the object to decide whether they must be re-evaluated. A row whose
   * item and index are unchanged keeps its version, and its bindings do no work.
   */
  version: number;
}

/** A binding, parsed once and reactively evaluated for only its own dependencies. */
export type Evaluator = (scope: Scope) => unknown;

/**
 * One lit template's worth of compiled output. `strings` is handed to lit's
 * `html` tag on every render and must keep its identity forever: lit caches the
 * parsed template against it, and a rebuilt array means a rebuilt DOM.
 */
export interface TemplateChunks {
  readonly strings: TemplateStringsArray;
  readonly values: readonly Evaluator[];
}

/** Result of compiling a `.html` file. Returns a lit `TemplateResult`. */
export type CompiledTemplate = (host: object) => unknown;

/**
 * Opaque values returned only by the deliberately noisy security bypass APIs.
 * They cannot be constructed by application code or mixed across DOM contexts.
 */
declare const trustedHtmlBrand: unique symbol;
declare const trustedStyleBrand: unique symbol;
declare const trustedUrlBrand: unique symbol;
declare const trustedResourceUrlBrand: unique symbol;

export interface TrustedHtml {
  readonly [trustedHtmlBrand]: true;
}

export interface TrustedStyle {
  readonly [trustedStyleBrand]: true;
}

export interface TrustedUrl {
  readonly [trustedUrlBrand]: true;
}

export interface TrustedResourceUrl {
  readonly [trustedResourceUrlBrand]: true;
}

/** The expression AST. Built by the parser, consumed by the closure compiler. */
export type ExprNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'name'; name: string; at: number }
  | { kind: 'member'; object: ExprNode; name: string; optional: boolean }
  | { kind: 'index'; object: ExprNode; index: ExprNode; optional: boolean }
  | { kind: 'call'; callee: ExprNode; args: ExprNode[] }
  | { kind: 'unary'; operator: string; operand: ExprNode }
  | { kind: 'binary'; operator: string; left: ExprNode; right: ExprNode }
  | { kind: 'conditional'; test: ExprNode; consequent: ExprNode; alternate: ExprNode }
  | { kind: 'array'; items: ExprNode[] }
  | { kind: 'object'; entries: { key: string; value: ExprNode }[] }
  | { kind: 'assign'; target: AssignableNode; value: ExprNode }
  | { kind: 'raw'; operand: ExprNode };

export type AssignableNode = Extract<ExprNode, { kind: 'name' | 'member' | 'index' }>;
