// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import { forEachChild, ts } from "../ts-api.js";

const ES5_INTRINSIC_OBJECTS: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "JSON",
]);

const ES5_INTRINSIC_PROTOTYPES: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const INTEGRITY_MUTATORS: ReadonlySet<string> = new Set(["freeze", "seal", "preventExtensions"]);

/**
 * (#7106 lever O) The six ES5 integrity statics, keyed by name. A `test`
 * answers a constant for the two operand classes whose answer is fixed at
 * compile time: an intrinsic of the pristine ES5 realm (extensible, neither
 * sealed nor frozen) and a primitive (§20.1.2.12–14: a non-Object is frozen
 * and sealed, and not extensible). A `mutator` returns a primitive operand
 * unchanged (§20.1.2.6, .19, .21 step 1). Every other operand keeps legacy's
 * runtime arm.
 */
type IntegrityStatic =
  | { readonly kind: "test"; readonly intrinsic: boolean; readonly primitive: boolean }
  | { readonly kind: "mutator" };

const INTEGRITY_STATICS: ReadonlyMap<string, IntegrityStatic> = new Map<string, IntegrityStatic>([
  ["isFrozen", { kind: "test", intrinsic: false, primitive: true }],
  ["isSealed", { kind: "test", intrinsic: false, primitive: true }],
  ["isExtensible", { kind: "test", intrinsic: true, primitive: false }],
  ...[...INTEGRITY_MUTATORS].map((name): [string, IntegrityStatic] => [name, { kind: "mutator" }]),
]);

interface SourceIntegrityFacts {
  /** Some source text names an integrity mutator, so no intrinsic is known to be pristine. */
  readonly mayMutate: boolean;
  /** Assigned names: `Object` itself, and `X` of every assigned `Object.X`. */
  readonly reassigned: ReadonlySet<string>;
}

const sourceIntegrityFactsCache = new WeakMap<ts.SourceFile, SourceIntegrityFacts>();

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken
  );
}

function propertyNameText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function sourceIntegrityFacts(sourceFile: ts.SourceFile): SourceIntegrityFacts {
  const cached = sourceIntegrityFactsCache.get(sourceFile);
  if (cached !== undefined) return cached;

  let mayMutate = false;
  const reassigned = new Set<string>();
  const visit = (node: ts.Node): void => {
    // Treat even taking a reference to an integrity mutator as unsafe. This
    // covers aliases such as `const freeze = Object.freeze; freeze(Boolean)`.
    if (
      (ts.isPropertyAccessExpression(node) && INTEGRITY_MUTATORS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        INTEGRITY_MUTATORS.has(propertyNameText(node.argumentExpression) ?? "")) ||
      (ts.isIdentifier(node) && INTEGRITY_MUTATORS.has(node.text))
    ) {
      mayMutate = true;
    }

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = unwrapExpression(node.left as ts.Expression);
      if (ts.isIdentifier(left) && left.text === "Object") reassigned.add("Object");
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "Object"
      ) {
        reassigned.add(left.name.text);
      }
    }

    forEachChild(node, visit);
  };
  visit(sourceFile);
  const facts = { mayMutate, reassigned };
  sourceIntegrityFactsCache.set(sourceFile, facts);
  return facts;
}

function isEs5IntrinsicObject(expr: ts.Expression, isAmbientBinding: (node: ts.Identifier) => boolean): boolean {
  const target = unwrapExpression(expr);
  if (ts.isIdentifier(target)) {
    return ES5_INTRINSIC_OBJECTS.has(target.text) && isAmbientBinding(target);
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === "prototype" && ts.isIdentifier(target.expression)) {
    return ES5_INTRINSIC_PROTOTYPES.has(target.expression.text) && isAmbientBinding(target.expression);
  }
  return false;
}

type OperandClass = "intrinsic" | "primitive" | "nullish";

/**
 * The fixed-answer class of an integrity static's operand: a boolean, number
 * or string literal, `null` / the unshadowed `undefined` (no IR value without
 * a consumer's hint), or an ES5 intrinsic while the source names no mutator.
 */
function operandClass(
  expr: ts.Expression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
  mayMutate: boolean,
): OperandClass | undefined {
  const operand = unwrapExpression(expr);
  if (
    ts.isNumericLiteral(operand) ||
    ts.isStringLiteralLike(operand) ||
    operand.kind === ts.SyntaxKind.TrueKeyword ||
    operand.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return "primitive";
  }
  if (operand.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefined(operand)) return "nullish";
  return !mayMutate && isEs5IntrinsicObject(operand, isAmbientBinding) ? "intrinsic" : undefined;
}

interface IntegrityCall {
  readonly name: string;
  readonly plan: IntegrityStatic;
  readonly operand: ts.Expression;
  readonly operandClass: OperandClass;
}

/**
 * `Object.<integrity static>(<one operand>)` on the ambient `Object`, neither
 * reassigned anywhere in the source, with an operand of a fixed-answer class;
 * else undefined.
 */
function integrityCall(
  expr: ts.CallExpression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
): IntegrityCall | undefined {
  const callee = expr.expression;
  if (
    expr.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object"
  ) {
    return undefined;
  }
  const name = callee.name.text;
  const plan = INTEGRITY_STATICS.get(name);
  const operand = expr.arguments[0]!;
  if (plan === undefined || ts.isSpreadElement(operand) || !isAmbientBinding(callee.expression)) return undefined;
  const facts = sourceIntegrityFacts(expr.getSourceFile());
  if (facts.reassigned.has("Object") || facts.reassigned.has(name)) return undefined;
  const fixed = operandClass(operand, isAmbientBinding, facts.mayMutate);
  return fixed === undefined ? undefined : { name, plan, operand, operandClass: fixed };
}

/** What an admitted integrity call lowers to: a constant answer, or (a mutator's) its own operand. */
export type IrObjectIntegrityFold =
  | { readonly kind: "answer"; readonly value: boolean }
  | { readonly kind: "operand"; readonly operand: ts.Expression };

/**
 * (#7106 lever O) The ONE admission of an integrity static as a fold, read by
 * the selector and by from-ast:
 *   - a test of a pristine intrinsic or of a primitive (`null` and the global
 *     `undefined` included) is its constant answer; the operand is a literal
 *     or an intrinsic read, so leaving it unevaluated is unobservable;
 *   - a mutator of a boolean, number or string literal is that literal. A
 *     mutator of an intrinsic mutates it, and one of `null` / `undefined`
 *     would need its consumer's hint to lower: both keep legacy.
 * Source-conservative like {@link isPristineEs5IntrinsicIsFrozenCall}: a
 * shadowed or reassigned `Object` / `Object.<name>` is never folded.
 */
export function objectIntegrityCallFold(
  expr: ts.CallExpression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
): IrObjectIntegrityFold | undefined {
  const call = integrityCall(expr, isAmbientBinding);
  if (call === undefined) return undefined;
  const { plan, operand, operandClass } = call;
  if (plan.kind === "test") {
    return { kind: "answer", value: operandClass === "intrinsic" ? plan.intrinsic : plan.primitive };
  }
  return operandClass === "primitive" ? { kind: "operand", operand } : undefined;
}

/**
 * Recognise the ES5 initial-realm invariant
 * `Object.isFrozen(%IntrinsicObject%) === false`: legacy's module-init
 * adapter for the original harness folds exactly this call, the intrinsic
 * class of {@link objectIntegrityCallFold}'s `isFrozen` row.
 */
export function isPristineEs5IntrinsicIsFrozenCall(
  expr: ts.CallExpression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
): boolean {
  const call = integrityCall(expr, isAmbientBinding);
  return call?.name === "isFrozen" && call.operandClass === "intrinsic";
}
