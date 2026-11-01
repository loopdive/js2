// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the shape of a destructuring binding pattern, decided once from the
// AST. Selection and lowering read the same answer, so a pattern the selector
// admits is a pattern the builder can lower.

import { ts } from "../ts-api.js";
import { collectPatternBindingNames, collectReferencedIdentifiers } from "./analysis/ast-scope.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

/**
 * Slice 8a (#1169g): a flat pattern the typed readers lower as one
 * `object.get` / `vec.get` per leaf: identifier leaves, no defaults, no rest,
 * no nesting, no computed keys, and no leaf already in `scope`.
 *
 *   - `{ a, b: x }` — shorthand and renamed keys (identifier or string);
 *   - `[a, , c]`    — positional leaves, elisions allowed.
 */
export function isPhase1BindingPattern(p: ts.BindingPattern, scope: ReadonlySet<string>): boolean {
  if (p.elements.length === 0) return false;
  const localNames = new Set<string>();
  for (const elem of p.elements) {
    if (ts.isOmittedExpression(elem)) continue;
    if (elem.dotDotDotToken || elem.initializer || !ts.isIdentifier(elem.name)) return false;
    if (elem.propertyName && !ts.isIdentifier(elem.propertyName) && !ts.isStringLiteral(elem.propertyName)) {
      return false;
    }
    const name = elem.name.text;
    if (scope.has(name) || localNames.has(name)) return false;
    localNames.add(name);
  }
  return true;
}

// ---------------------------------------------------------------------------
// A pattern over a fresh literal (#7106 S2)
// ---------------------------------------------------------------------------

/** A destructuring leaf: a binding element that binds an identifier. */
export type BindingLeaf = ts.BindingElement & { readonly name: ts.Identifier };

/** What a leaf binds when its source is a fresh literal. */
export type LiteralLeafValue =
  | { readonly kind: "evaluated"; readonly index: number }
  | { readonly kind: "undefined" }
  | { readonly kind: "length"; readonly value: number };

export type LiteralPatternStep =
  | { readonly kind: "bind"; readonly leaf: BindingLeaf; readonly value: LiteralLeafValue }
  | { readonly kind: "default"; readonly leaf: BindingLeaf; readonly initializer: ts.Expression }
  | { readonly kind: "nested"; readonly plan: LiteralPatternPlan };

/**
 * `pattern = <fresh array or object literal>` as scalar steps. The literal is
 * never built: its expressions are evaluated in source order, then each step
 * binds a leaf to the expression at its position, to `undefined` (past the
 * end, a hole, a missing key) or to its default, which runs only then.
 *
 * Sound while the array iterator and `Object.prototype` are the realm's own,
 * which the IR's vec readers already assume. A missing key that
 * `Object.prototype` owns, and any key but `length` or an index on an array,
 * is refused instead.
 */
export interface LiteralPatternPlan {
  readonly evaluations: readonly ts.Expression[];
  readonly steps: readonly LiteralPatternStep[];
}

/** A position in the literal source. */
type SourceNode =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "array"; readonly elements: readonly SourceNode[]; readonly expression: ts.Expression }
  | {
      readonly kind: "object";
      readonly properties: ReadonlyMap<string, SourceNode>;
      readonly order: readonly SourceNode[];
      readonly expression: ts.Expression;
    }
  | { readonly kind: "value"; readonly expression: ts.Expression; readonly defined: boolean };

const UNDEFINED: SourceNode = { kind: "undefined" };
const NULL: SourceNode = { kind: "null" };

type PendingStep =
  | { readonly kind: "bind"; readonly leaf: BindingLeaf; readonly node: SourceNode | number }
  | Exclude<LiteralPatternStep, { kind: "bind" }>;

interface Reading {
  /** Every leaf of the declaration: a default or source expression reading one is refused (TDZ). */
  readonly leaves: ReadonlySet<string>;
  /** Literals a leaf binds whole, so they are built rather than decomposed. */
  readonly whole: Set<SourceNode>;
  readonly read: Set<SourceNode>;
  readonly steps: PendingStep[];
}

/** The plan of `pattern = source`, or null when `source` is not a literal the plan can decompose. */
export function planLiteralPattern(pattern: ts.BindingPattern, source: ts.Expression): LiteralPatternPlan | null {
  return planOver(pattern, source, new Set(collectPatternBindingNames(pattern)));
}

/** Every expression the plan lowers: the evaluations, the defaults it runs, and those of its nested plans. */
export function literalPlanExpressions(plan: LiteralPatternPlan): ts.Expression[] {
  return [
    ...plan.evaluations,
    ...plan.steps.flatMap((step) =>
      step.kind === "default" ? [step.initializer] : step.kind === "nested" ? literalPlanExpressions(step.plan) : [],
    ),
  ];
}

function planOver(
  pattern: ts.BindingPattern,
  source: ts.Expression,
  leaves: ReadonlySet<string>,
): LiteralPatternPlan | null {
  const root = sourceNode(source);
  if (root?.kind !== "array" && root?.kind !== "object") return null;
  const reading: Reading = { leaves, whole: new Set(), read: new Set(), steps: [] };
  if (!readPattern(pattern, root, reading)) return null;
  const evaluations: ts.Expression[] = [];
  const indices = new Map<SourceNode, number>();
  if (!evaluate(root, reading, evaluations, indices)) return null;
  const steps = reading.steps.map(
    (step): LiteralPatternStep =>
      step.kind === "bind" ? { kind: "bind", leaf: step.leaf, value: leafValue(step.node, indices) } : step,
  );
  return { evaluations, steps };
}

function leafValue(node: SourceNode | number, indices: ReadonlyMap<SourceNode, number>): LiteralLeafValue {
  if (typeof node === "number") return { kind: "length", value: node };
  const index = indices.get(node);
  return index === undefined ? { kind: "undefined" } : { kind: "evaluated", index };
}

function sourceNode(expression: ts.Expression): SourceNode | null {
  const node = skipParentheses(expression);
  if (isUndefinedLiteral(node)) return UNDEFINED;
  if (node.kind === ts.SyntaxKind.NullKeyword) return NULL;
  if (ts.isArrayLiteralExpression(node)) return arraySource(node);
  if (ts.isObjectLiteralExpression(node)) return objectSource(node);
  return { kind: "value", expression: node, defined: isDefinedLiteral(node) };
}

function arraySource(literal: ts.ArrayLiteralExpression): SourceNode | null {
  const elements: SourceNode[] = [];
  for (const element of literal.elements) {
    if (ts.isSpreadElement(element)) return null;
    const node = ts.isOmittedExpression(element) ? UNDEFINED : sourceNode(element);
    if (node === null) return null;
    elements.push(node);
  }
  return { kind: "array", elements, expression: literal };
}

/** Data properties with static keys only: a getter, method, spread or `__proto__` key changes what a read sees. */
function objectSource(literal: ts.ObjectLiteralExpression): SourceNode | null {
  const properties = new Map<string, SourceNode>();
  const order: SourceNode[] = [];
  for (const property of literal.properties) {
    let key: string | null = null;
    let node: SourceNode | null = null;
    if (ts.isPropertyAssignment(property)) {
      key = propertyKey(property.name);
      node = sourceNode(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) {
      key = property.name.text;
      node = { kind: "value", expression: property.name, defined: false };
    }
    if (key === null || key === "__proto__" || node === null) return null;
    properties.set(key, node);
    order.push(node);
  }
  return { kind: "object", properties, order, expression: literal };
}

function readPattern(pattern: ts.BindingPattern, node: SourceNode, reading: Reading): boolean {
  if (node.kind === "array") return readList(pattern, node.elements, reading);
  if (node.kind !== "object" || ts.isArrayBindingPattern(pattern)) return false;
  return pattern.elements.every((element) => {
    const key = bindingKey(element);
    if (key === null) return false;
    const property = node.properties.get(key);
    // A key the literal lacks reads `Object.prototype`.
    if (!property && OBJECT_PROTOTYPE_KEYS.has(key)) return false;
    return readElement(element, property ?? UNDEFINED, reading);
  });
}

/** Read `pattern` off a list of positions: an array literal's elements, or the rest of them. */
function readList(pattern: ts.BindingPattern, list: readonly SourceNode[], reading: Reading): boolean {
  if (ts.isObjectBindingPattern(pattern)) {
    return pattern.elements.every((element) => {
      const key = bindingKey(element);
      if (key === "length") return ts.isIdentifier(element.name) && pushBind(element, list.length, reading);
      // Any other key reads `Array.prototype`.
      if (key === null || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
      return readElement(element, list[Number(key)] ?? UNDEFINED, reading);
    });
  }
  return pattern.elements.every((element, index) => {
    if (ts.isOmittedExpression(element)) return true;
    if (!element.dotDotDotToken) return readElement(element, list[index] ?? UNDEFINED, reading);
    // The rest is a fresh array of the remaining values: decomposable, but binding it whole would build one.
    return !ts.isIdentifier(element.name) && readList(element.name, list.slice(index), reading);
  });
}

function readElement(element: ts.BindingElement, node: SourceNode, reading: Reading): boolean {
  if (element.initializer && node.kind === "undefined") return readDefault(element, element.initializer, reading);
  // A default runs on `undefined` only, which an arbitrary expression may produce.
  if (element.initializer && node.kind === "value" && !node.defined) return false;
  if (node.kind !== "undefined" && node.kind !== "null") {
    if (reading.read.has(node)) return false;
    reading.read.add(node);
  }
  if (!ts.isIdentifier(element.name)) return readPattern(element.name, node, reading);
  // A bare `null` value has no carrier in this position.
  if (node.kind === "null") return false;
  if (node.kind === "array" || node.kind === "object") reading.whole.add(node);
  return pushBind(element, node, reading);
}

function readDefault(element: ts.BindingElement, initializer: ts.Expression, reading: Reading): boolean {
  if (referencesLeaf(initializer, reading.leaves)) return false;
  if (!ts.isIdentifier(element.name)) {
    const nested = planOver(element.name, initializer, reading.leaves);
    if (nested) reading.steps.push({ kind: "nested", plan: nested });
    return nested !== null;
  }
  // NamedEvaluation would name an anonymous function after the leaf.
  if (isAnonymousFunctionDefinition(initializer)) return false;
  reading.steps.push({ kind: "default", leaf: element as BindingLeaf, initializer });
  return true;
}

function pushBind(element: ts.BindingElement, node: SourceNode | number, reading: Reading): true {
  reading.steps.push({ kind: "bind", leaf: element as BindingLeaf, node });
  return true;
}

/** Assign evaluation indices in source order; a literal bound whole is evaluated as one expression. */
function evaluate(
  node: SourceNode,
  reading: Reading,
  evaluations: ts.Expression[],
  indices: Map<SourceNode, number>,
): boolean {
  if (node.kind === "undefined" || node.kind === "null") return true;
  if (!reading.whole.has(node)) {
    if (node.kind === "array") return node.elements.every((child) => evaluate(child, reading, evaluations, indices));
    if (node.kind === "object") return node.order.every((child) => evaluate(child, reading, evaluations, indices));
  }
  if (referencesLeaf(node.expression, reading.leaves)) return false;
  indices.set(node, evaluations.length);
  evaluations.push(node.expression);
  return true;
}

function bindingKey(element: ts.BindingElement): string | null {
  if (element.dotDotDotToken) return null;
  if (element.propertyName) return propertyKey(element.propertyName);
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

/** A static property key in canonical form (`1.0` is `"1"`); null for a computed key. */
function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return ts.isNumericLiteral(name) ? String(Number(name.text)) : null;
}

function referencesLeaf(expression: ts.Expression, leaves: ReadonlySet<string>): boolean {
  const names = new Set<string>();
  collectReferencedIdentifiers(expression, names);
  return [...names].some((name) => leaves.has(name));
}

function skipParentheses(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ? skipParentheses(expression.expression) : expression;
}

function isUndefinedLiteral(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === "undefined") ||
    (ts.isVoidExpression(node) && ts.isNumericLiteral(node.expression))
  );
}

/** A primitive literal: never `undefined`, so a default never runs on it. */
function isDefinedLiteral(node: ts.Expression): boolean {
  return (
    ts.isLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
  );
}

function isAnonymousFunctionDefinition(expression: ts.Expression): boolean {
  const node = skipParentheses(expression);
  return ts.isArrowFunction(node) || ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && !node.name);
}
