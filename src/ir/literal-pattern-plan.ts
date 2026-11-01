// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S2 — `pattern = <fresh array or object literal>` as scalar steps. The
// literal is never built: its expressions are evaluated in source order, then
// each step binds a leaf to the expression at its position, to `undefined`
// (past the end, a hole, a missing key) or to its default, which runs only
// then. Destructuring `null` or `undefined` throws a TypeError.
//
// Sound while the array iterator, `Array.prototype` and `Object.prototype` are
// the realm's own: selection refuses every destructuring declaration of a
// program that patches one (`programPatchesDestructuringRealm`). A missing key
// that `Object.prototype` owns, and any key but `length` or an index inside an
// array literal, is refused here. So is any `undefined` identifier as the
// value `undefined` in a program that binds the name (`programBindsUndefined`).

import { forEachChild, ts } from "../ts-api.js";
import { stripParens } from "../shared/binding-writes.js";
import { isAnonymousFunctionDefinition } from "../shared/named-evaluation.js";
import { collectPatternBindingNames, collectReferencedIdentifiers } from "./analysis/ast-scope.js";
import { isUndefinedCompareOperand } from "./analysis/operand-admissibility.js";
import type { BindingLeaf, PatternLeafValue, PatternPlan, PatternStep } from "./binding-pattern-plan.js";
import { phase1PropertyName } from "./property-key-fold.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

/** A position in the literal source. */
type SourceNode =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "array"; readonly elements: readonly SourceNode[] }
  | {
      readonly kind: "object";
      readonly properties: ReadonlyMap<string, SourceNode>;
      readonly order: readonly SourceNode[];
    }
  | { readonly kind: "value"; readonly expression: ts.Expression; readonly defined: boolean };

const UNDEFINED: SourceNode = { kind: "undefined" };
const NULL: SourceNode = { kind: "null" };

type PendingStep =
  | { readonly kind: "bind"; readonly leaf: BindingLeaf; readonly node: SourceNode | number }
  | Exclude<PatternStep<never>, { kind: "bind" }>;

interface Reading {
  /** The identifier `undefined` is the global value: the program binds no other. */
  readonly undefinedIsGlobal: boolean;
  /** Every leaf of the declaration: a default or source expression reading one is refused (TDZ). */
  readonly leaves: ReadonlySet<string>;
  readonly read: Set<SourceNode>;
  readonly steps: PendingStep[];
}

/** The plan of `pattern = source`, or null when `source` is not a literal the plan can decompose. */
export function planLiteralPattern(pattern: ts.BindingPattern, source: ts.Expression): PatternPlan | null {
  const undefinedIsGlobal = !programBindsUndefined(source.getSourceFile());
  return planOver(pattern, source, new Set(collectPatternBindingNames(pattern)), undefinedIsGlobal);
}

/** What a leaf binds: an expression (its source position or its default), `undefined`, or an array's length. */
export type LiteralLeafSource = ts.Expression | "undefined" | "length";

/** The source of `leaf` when its declaration takes the literal plan; undefined otherwise. */
export function literalLeafSource(leaf: ts.BindingElement): LiteralLeafSource | undefined {
  let declaration: ts.Node = leaf;
  while (
    ts.isBindingElement(declaration) ||
    ts.isObjectBindingPattern(declaration) ||
    ts.isArrayBindingPattern(declaration)
  ) {
    declaration = declaration.parent;
  }
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || ts.isIdentifier(declaration.name)) {
    return undefined;
  }
  const plan = planLiteralPattern(declaration.name, declaration.initializer);
  return plan ? sourceOfLeaf(plan, leaf) : undefined;
}

function sourceOfLeaf(plan: PatternPlan, leaf: ts.BindingElement): LiteralLeafSource | undefined {
  for (const step of plan.steps) {
    if (step.kind === "nested") {
      const nested = sourceOfLeaf(step.plan, leaf);
      if (nested !== undefined) return nested;
    } else if (step.kind === "default" && step.leaf === leaf) {
      return step.initializer;
    } else if (step.kind === "bind" && step.leaf === leaf) {
      const value = step.value;
      if (value.kind === "read") return value.read;
      return value.kind === "evaluated" ? plan.evaluations[value.index] : value.kind;
    }
  }
  return undefined;
}

const programsBindingUndefined = new WeakMap<ts.SourceFile, boolean>();

/**
 * Whether the program declares a binding named `undefined` anywhere. Then no
 * `undefined` identifier is proven to be the global value: a later block's
 * `let undefined` holds it in TDZ, a hoisted `function undefined` replaces it.
 */
function programBindsUndefined(sourceFile: ts.SourceFile): boolean {
  let binds = programsBindingUndefined.get(sourceFile);
  if (binds === undefined) {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      found = ts.isIdentifier(node) && node.text === "undefined" && declaresName(node);
      if (!found) forEachChild(node, visit);
    };
    visit(sourceFile);
    binds = found;
    programsBindingUndefined.set(sourceFile, binds);
  }
  return binds;
}

function declaresName(name: ts.Identifier): boolean {
  const parent = name.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === name
  );
}

/** Every expression the plan lowers: the evaluations, the defaults it runs, and those of its nested plans. */
export function literalPlanExpressions(plan: PatternPlan): ts.Expression[] {
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
  undefinedIsGlobal: boolean,
): PatternPlan | null {
  const reading: Reading = { undefinedIsGlobal, leaves, read: new Set(), steps: [] };
  const root = sourceNode(source, reading);
  if (root === null || root.kind === "value") return null;
  if (!readPattern(pattern, root, reading)) return null;
  const evaluations: ts.Expression[] = [];
  const indices = new Map<SourceNode, number>();
  if (!evaluate(root, reading, evaluations, indices)) return null;
  const steps = reading.steps.map(
    (step): PatternStep<never> =>
      step.kind === "bind" ? { kind: "bind", leaf: step.leaf, value: planLeafValue(step.node, indices) } : step,
  );
  return { evaluations, steps };
}

function planLeafValue(node: SourceNode | number, indices: ReadonlyMap<SourceNode, number>): PatternLeafValue<never> {
  if (typeof node === "number") return { kind: "length", value: node };
  const index = indices.get(node);
  return index === undefined ? { kind: "undefined" } : { kind: "evaluated", index };
}

function sourceNode(expression: ts.Expression, reading: Reading): SourceNode | null {
  const node = stripParens(expression);
  if (isUndefinedCompareOperand(node, () => !reading.undefinedIsGlobal)) return UNDEFINED;
  if (node.kind === ts.SyntaxKind.NullKeyword) return NULL;
  if (ts.isArrayLiteralExpression(node)) return arraySource(node, reading);
  if (ts.isObjectLiteralExpression(node)) return objectSource(node, reading);
  return { kind: "value", expression: node, defined: isDefinedLiteral(node) };
}

function arraySource(literal: ts.ArrayLiteralExpression, reading: Reading): SourceNode | null {
  const elements: SourceNode[] = [];
  for (const element of literal.elements) {
    if (ts.isSpreadElement(element)) return null;
    const node = ts.isOmittedExpression(element) ? UNDEFINED : sourceNode(element, reading);
    if (node === null) return null;
    elements.push(node);
  }
  return { kind: "array", elements };
}

/** Data properties with static keys only: a getter, method, spread or `__proto__` key changes what a read sees. */
function objectSource(literal: ts.ObjectLiteralExpression, reading: Reading): SourceNode | null {
  const properties = new Map<string, SourceNode>();
  const order: SourceNode[] = [];
  for (const property of literal.properties) {
    let key: string | null = null;
    let node: SourceNode | null = null;
    if (ts.isPropertyAssignment(property)) {
      key = phase1PropertyName(property.name);
      node = sourceNode(property.initializer, reading);
    } else if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) {
      key = property.name.text;
      node = { kind: "value", expression: property.name, defined: false };
    }
    if (key === null || key === "__proto__" || node === null) return null;
    properties.set(key, node);
    order.push(node);
  }
  return { kind: "object", properties, order };
}

function readPattern(pattern: ts.BindingPattern, node: SourceNode, reading: Reading): boolean {
  if (node.kind === "undefined" || node.kind === "null") {
    reading.steps.push({ kind: "throw-type-error" });
    bindUnreachableLeaves(pattern, reading);
    return true;
  }
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
      // Any other key, or an index past the end, reads `Array.prototype` (and is typed as an element).
      if (key === null || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= list.length) return false;
      return readElement(element, list[Number(key)]!, reading);
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
  // A leaf binds a scalar: a bare `null` has no carrier there, and a literal bound whole would be built.
  if (node.kind === "null" || node.kind === "array" || node.kind === "object") return false;
  return pushBind(element, node, reading);
}

function readDefault(element: ts.BindingElement, initializer: ts.Expression, reading: Reading): boolean {
  if (referencesLeaf(initializer, reading.leaves)) return false;
  if (!ts.isIdentifier(element.name)) {
    const nested = planOver(element.name, initializer, reading.leaves, reading.undefinedIsGlobal);
    if (nested) reading.steps.push({ kind: "nested", plan: nested });
    return nested !== null;
  }
  // NamedEvaluation would name an anonymous function after the leaf.
  if (isAnonymousFunctionDefinition(initializer)) return false;
  reading.steps.push({ kind: "default", leaf: element as BindingLeaf, initializer });
  return true;
}

/** The leaves a TypeError skips still bind (`undefined`), so the code after the throw compiles. */
function bindUnreachableLeaves(pattern: ts.BindingPattern, reading: Reading): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) pushBind(element, UNDEFINED, reading);
    else bindUnreachableLeaves(element.name, reading);
  }
}

function pushBind(element: ts.BindingElement, node: SourceNode | number, reading: Reading): true {
  reading.steps.push({ kind: "bind", leaf: element as BindingLeaf, node });
  return true;
}

/** Assign evaluation indices in source order: every literal is decomposed, every value evaluated once. */
function evaluate(
  node: SourceNode,
  reading: Reading,
  evaluations: ts.Expression[],
  indices: Map<SourceNode, number>,
): boolean {
  if (node.kind === "undefined" || node.kind === "null") return true;
  if (node.kind === "array") return node.elements.every((child) => evaluate(child, reading, evaluations, indices));
  if (node.kind === "object") return node.order.every((child) => evaluate(child, reading, evaluations, indices));
  if (referencesLeaf(node.expression, reading.leaves)) return false;
  indices.set(node, evaluations.length);
  evaluations.push(node.expression);
  return true;
}

function bindingKey(element: ts.BindingElement): string | null {
  if (element.dotDotDotToken) return null;
  if (element.propertyName) return phase1PropertyName(element.propertyName);
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function referencesLeaf(expression: ts.Expression, leaves: ReadonlySet<string>): boolean {
  const names = new Set<string>();
  collectReferencedIdentifiers(expression, names);
  return [...names].some((name) => leaves.has(name));
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
