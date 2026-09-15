/**
 * The template pipeline's types: binding classifications, scopes, the expression AST
 * and the opaque values the security bypasses return.
 */

/**
 * The security context a bound value lands in, as named by `@core/template/dialect.js`.
 * security.js maps each context to a sanitizer, and the template checker maps it to a
 * typed sink.
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
 * Variables an expression sees beyond the component's members, such as `$event` and
 * `*for` variables. They are prototype-chained, so a nested `*for` sees outer
 * variables and a row's scope builds in constant time.
 */
export type TemplateLocals = Record<string, unknown>;

export interface Scope {
  /** The component instance. Only its public members are reachable. */
  readonly host: Record<string, unknown>;
  readonly locals: TemplateLocals;
  /**
   * Bumped when anything this scope exposes may have changed, such as a host render
   * or new `*for` locals. The scope object keeps its identity, so bindings compare
   * this number to decide whether to re-evaluate.
   */
  version: number;
}

/** A binding, parsed once and reactively evaluated for only its own dependencies. */
export type Evaluator = (scope: Scope) => unknown;

/**
 * Authored markup an element renders when and as often as it chooses.
 *
 * `<template *fragment="cell(row, index)">` compiles to one of these and is assigned to
 * the named property of its enclosing element. Calling it returns a renderable value,
 * and its arguments become the body's locals in order. The body reads the declaring
 * component's members, and a consumer supplies only the locals.
 */
export type TemplateFragment = (...args: readonly unknown[]) => unknown;

/**
 * One lit template's compiled output. `strings` goes to lit's `html` tag on every
 * render and keeps its identity, because lit caches the parsed template on it.
 */
export interface TemplateChunks {
  readonly strings: TemplateStringsArray;
  readonly values: readonly Evaluator[];
}

/** Result of compiling a `.html` file. Returns a lit `TemplateResult`. */
export type CompiledTemplate = (host: object) => unknown;

/**
 * Opaque values only the security bypass functions return. Application code can't
 * construct them or use one in another context.
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
