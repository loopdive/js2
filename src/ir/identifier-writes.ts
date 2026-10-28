// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4495) Every store a single AST node performs into a bare identifier.
 *
 * Both definition-side slot-widening analyses — module bindings
 * (`heterogeneous-module-bindings.ts`) and function locals
 * (`codegen/analysis/mixed-assignment-carrier.ts`) — decide a binding's Wasm
 * slot from "the initializer, unless some reaching write stores a value of
 * another JS type". Both used to recognise a write only as `x = v` (plus the
 * logical forms on the module side), so a string-initialised binding written
 * by `[x] = [f()]`, `({ x } = o)`, `for (x of xs)`, `x++` or `x -= 1` kept its
 * native-string slot. The coercion into that slot answers `null` for a
 * non-string value by design (type-coercion.ts — a generic ToString there would
 * corrupt sentinels), so the next `'' + x` trapped in `__str_concat`.
 *
 * {@link identifierWritesOf} is pure syntax — it names WHAT is stored.
 * {@link identifierWriteTag} then asks the oracle the same question both
 * analyses already ask of a plain assignment's RHS, so the two cannot disagree
 * on what a write stores.
 */
import { jsTagOfFact, type JsTag, type TypeOracle } from "../checker/oracle.js";
import { ts } from "../ts-api.js";

/** One store into an identifier binding. */
export interface IdentifierWrite {
  readonly target: ts.Identifier;
  /**
   * `value`   — stores `expr` (a plain/logical assignment, a destructuring
   *             element paired with a literal source element, or a default).
   * `element` — stores an element of `expr` (a for-of target, or an array
   *             pattern element destructured from a non-literal source).
   * `property` — stores property `key` of `expr` (an object pattern target
   *             destructured from a non-literal source).
   * `unknown` — stores a value the syntax does not name (a rest element, a
   *             nested pattern under a non-literal source, an absent element).
   * `numeric` — stores a ToNumeric result (`++`, `--`, `-=`, `*=`, …).
   */
  readonly kind: "value" | "element" | "property" | "unknown" | "numeric";
  readonly expr?: ts.Expression;
  readonly key?: string;
}

/** What a destructuring target receives, before its target is known. */
type WriteSource = Omit<IdentifierWrite, "target">;
const UNKNOWN: WriteSource = { kind: "unknown" };

/**
 * The JS tag `write` stores into a binding initialised with a value of
 * `initialTag`: the oracle's answer for a named value or an iterated array /
 * string element, `mixed` when nothing names it, and for a ToNumeric
 * write-back the initializer's own numeric tag (`x++` keeps a number a number
 * and a bigint a bigint, but turns a string or a boolean into a number).
 */
export function identifierWriteTag(
  oracle: Pick<TypeOracle, "staticJsTypeOf" | "typeFactOf" | "propertyFactOf">,
  write: IdentifierWrite,
  initialTag: JsTag,
): JsTag | "mixed" {
  switch (write.kind) {
    case "value":
      return oracle.staticJsTypeOf(write.expr!);
    case "numeric":
      return initialTag === "bigint" ? "bigint" : "number";
    case "unknown":
      return "mixed";
    case "element": {
      const iterated = oracle.typeFactOf(write.expr!);
      if (iterated.kind === "string") return "string";
      return (iterated.kind === "array" && jsTagOfFact(iterated.element)) || "mixed";
    }
    case "property":
      return jsTagOfFact(oracle.propertyFactOf(write.expr!, write.key!)) ?? "mixed";
  }
}

/** Operators that store their right operand (conditionally, for the logical forms). */
const STORING_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Compound assignments whose write-back is always a Number or a BigInt. `+=`
 * is absent on purpose: it may produce a string, and its result type is the
 * operand types' business, not this syntax walk's.
 */
const NUMERIC_COMPOUND_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

/** Shared result for the (overwhelmingly common) node that stores nothing — no per-node allocation. */
const NO_WRITES: readonly IdentifierWrite[] = Object.freeze([]);

function stripParens(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

/** Literal property-name text, or undefined for a computed / private name. */
function propertyKey(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

/**
 * What the array-pattern element at `index` receives from `source`: the paired
 * element of a spread-free array literal, an element of a non-literal source,
 * and unknown otherwise (an absent literal element is `undefined`).
 */
function arrayElementSource(source: ts.Expression | undefined, index: number): WriteSource {
  if (!source) return UNKNOWN;
  if (!ts.isArrayLiteralExpression(source))
    return ts.isObjectLiteralExpression(source) ? UNKNOWN : { kind: "element", expr: source };
  if (source.elements.some((e) => ts.isSpreadElement(e))) return UNKNOWN;
  const element = source.elements[index];
  return element && !ts.isOmittedExpression(element) ? { kind: "value", expr: element } : UNKNOWN;
}

/**
 * What the object-pattern property `name` receives from `source`: the value of
 * a spread-free object literal naming it once, property `name` of a
 * non-literal source, and unknown otherwise.
 */
function propertySource(source: ts.Expression | undefined, name: ts.PropertyName): WriteSource {
  const key = propertyKey(name);
  if (!source || key === undefined || ts.isArrayLiteralExpression(source)) return UNKNOWN;
  if (!ts.isObjectLiteralExpression(source)) return { kind: "property", expr: source, key };
  let found: WriteSource = UNKNOWN;
  for (const property of source.properties) {
    if (ts.isSpreadAssignment(property) || !property.name) return UNKNOWN;
    const propertyName = propertyKey(property.name);
    if (propertyName === undefined) return UNKNOWN;
    if (propertyName !== key) continue;
    if (ts.isPropertyAssignment(property)) found = { kind: "value", expr: property.initializer };
    else if (ts.isShorthandPropertyAssignment(property)) found = { kind: "value", expr: property.name };
    else return UNKNOWN; // accessor / method: not a plain stored value
  }
  return found;
}

/** Record `target` receiving `source`, plus an optional default. */
function pushTarget(
  out: IdentifierWrite[],
  target: ts.Expression,
  source: WriteSource,
  defaultValue?: ts.Expression,
): void {
  const stripped = stripParens(target);
  if (ts.isIdentifier(stripped)) {
    out.push({ target: stripped, ...source });
    if (defaultValue) out.push({ target: stripped, kind: "value", expr: defaultValue });
  } else if (ts.isArrayLiteralExpression(stripped) || ts.isObjectLiteralExpression(stripped)) {
    // A nested pattern sees a literal source, or its default when that is absent.
    collectPatternWrites(out, stripped, source.kind === "value" ? source.expr : defaultValue);
  }
}

/** Identifier targets of an assignment pattern, each with what it receives from `source`. */
function collectPatternWrites(
  out: IdentifierWrite[],
  pattern: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
  source: ts.Expression | undefined,
): void {
  const from = source ? stripParens(source) : undefined;
  if (ts.isArrayLiteralExpression(pattern)) {
    pattern.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      if (ts.isSpreadElement(element)) return pushTarget(out, element.expression, UNKNOWN);
      const received = arrayElementSource(from, index);
      if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return pushTarget(out, element.left, received, element.right);
      }
      pushTarget(out, element, received);
    });
    return;
  }
  for (const property of pattern.properties) {
    if (ts.isSpreadAssignment(property)) {
      pushTarget(out, property.expression, UNKNOWN);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      pushTarget(out, property.name, propertySource(from, property.name), property.objectAssignmentInitializer);
    } else if (ts.isPropertyAssignment(property)) {
      const received = propertySource(from, property.name);
      const init = property.initializer;
      if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        pushTarget(out, init.left, received, init.right);
      } else {
        pushTarget(out, init, received);
      }
    }
  }
}

/**
 * The identifier stores `node` itself performs (children are not visited —
 * callers drive their own walk). Empty for every node that stores nothing.
 */
export function identifierWritesOf(node: ts.Node): readonly IdentifierWrite[] {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    const left = stripParens(node.left);
    if (STORING_ASSIGNMENTS.has(operator)) {
      if (ts.isIdentifier(left)) return [{ target: left, kind: "value", expr: node.right }];
      if (
        operator === ts.SyntaxKind.EqualsToken &&
        (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left))
      ) {
        const out: IdentifierWrite[] = [];
        collectPatternWrites(out, left, node.right);
        return out;
      }
      return NO_WRITES;
    }
    if (NUMERIC_COMPOUND_ASSIGNMENTS.has(operator) && ts.isIdentifier(left)) {
      return [{ target: left, kind: "numeric" }];
    }
    return NO_WRITES;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const operand = stripParens(node.operand);
    return ts.isIdentifier(operand) ? [{ target: operand, kind: "numeric" }] : NO_WRITES;
  }
  if (ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
    const target = stripParens(node.initializer);
    if (ts.isIdentifier(target)) return [{ target, kind: "element", expr: node.expression }];
    const out: IdentifierWrite[] = [];
    pushTarget(out, target, UNKNOWN);
    return out;
  }
  return NO_WRITES;
}
