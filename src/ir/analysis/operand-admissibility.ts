// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7144 — ONE spelling of AST→IR operand / write admissibility.
//
// `ir/from-ast` types each operator and each write by its operands'
// representations; the selector must refuse exactly the constructs that typing
// withdraws, or it claims a body that then demotes after the claim. Before
// #7144 the selector re-derived those rules by hand and the two spellings
// drifted (ten review rounds of #7113 found a new ring of claim-then-withdraw
// rows each time). These predicates are now the rule itself: from-ast calls
// them at its withdrawal sites over the families of the values it lowered
// (`irOperandFamily`), and the selector calls them over the families it can
// prove before lowering (`plannedClosureOperandFamily`). A family the selector
// cannot name is `unknown`, which every predicate refuses.

import { ts } from "../../ts-api.js";

/**
 * The value family an operand lowers to — the representation class the typing
 * gates below dispatch on, not a JS type.
 *
 * - `number` — an unboxed f64.
 * - `boolean` / `int32` — an i32 with / without a boolean proof (the `irBool`
 *   brand, a syntactically boolean operand). Both share the i32 carrier; only
 *   `boolean` boxes into the dynamic carrier.
 * - `string` — the backend-agnostic IR string.
 * - `dynamic` — the boxed-any carrier.
 * - `vec<number>` / `vec<other>` — a dense array of f64 / of anything else.
 * - `externref` — an extern-class value or a plain externref (nullable, with a
 *   `ref.is_null` test).
 * - `ref` / `nullable-ref` — a non-null / a `ref_null` struct reference.
 * - `reference` — a class / object / closure / callable / boxed value: may be
 *   `null` at runtime, carries a shape identity the families do not.
 * - `nullish` — the `null` literal (selector only; from-ast never lowers one
 *   as an operand).
 * - `undefined` — a value `void x`: from-ast lowers it to the f64 NaN
 *   sentinel, which is right wherever ToNumber(undefined) is what the operator
 *   reads (`- * / %`, the relationals, the bitwise operators, an equality
 *   against an f64) and wrong wherever the VALUE is observed (any other
 *   equality, `+`, a box into the carrier, a slot write, a loose `== null`).
 * - `other` — any other IR representation (unions, packed values, …).
 * - `unknown` — the selector has no proof. Refused by every predicate.
 */
export type OperandFamily =
  | "number"
  | "boolean"
  | "int32"
  | "string"
  | "dynamic"
  | "vec<number>"
  | "vec<other>"
  | "externref"
  | "ref"
  | "nullable-ref"
  | "reference"
  | "nullish"
  | "undefined"
  | "other"
  | "unknown";

/**
 * The `+` operand proof (#2781): a TS-level number / string proof, or the
 * operand produces the dynamic carrier (which takes the dynamic `+`).
 */
export type AdditiveProof = "number" | "string" | "dynamic" | "unprovable";

/**
 * `tryLowerUndefinedCompare`'s `undefined` operand of a strict equality: the
 * unshadowed identifier `undefined` or a literal `void 0` — read DIRECTLY, as
 * the lowering does (`(void 0) === x` types the parenthesised operand like any
 * other). `=== void 0` is how TypeScript and Babel emit `=== undefined`.
 */
export function isUndefinedCompareOperand(expr: ts.Expression, isShadowed: (name: string) => boolean): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "undefined" && !isShadowed(expr.text);
  return ts.isVoidExpression(expr) && ts.isNumericLiteral(expr.expression) && Number(expr.expression.text) === 0;
}

/**
 * The other operand of that strict `undefined` compare. A value `void x` is
 * the NaN sentinel, which no representation test tells from a number (and its
 * static type is `undefined`, so the never-undefined fold cannot apply): it is
 * never lowered. Every other family is decided by the lowering's own dispatch
 * (tag test, externref probe, checker-proved fold).
 */
export function undefinedCompareOperandAdmissible(other: OperandFamily): boolean {
  return other !== "undefined";
}

/** The dynamic carrier boxes exactly these families (`boxConcreteToDynamic`). */
export function boxableIntoDynamic(family: OperandFamily): boolean {
  return family === "number" || family === "boolean" || family === "string" || family === "dynamic";
}

/**
 * #2781 — `+` takes the unboxed numeric add or the string concat only when
 * both operands are proved number or both string; an operand that produces the
 * dynamic carrier takes the dynamic `+` instead (judged by
 * {@link binaryOperandsAdmissible} once lowered).
 */
export function additiveOperandsProvable(left: AdditiveProof, right: AdditiveProof): boolean {
  if (left === "dynamic" || right === "dynamic") return true;
  return left === right && left !== "unprovable";
}

/** The operators whose result is a boolean (the comparisons, `instanceof`, `in`). */
export function isComparisonResultOperator(op: ts.SyntaxKind): boolean {
  return (
    isRelationalOperator(op) ||
    isEqualityOperator(op) ||
    op === ts.SyntaxKind.InstanceOfKeyword ||
    op === ts.SyntaxKind.InKeyword
  );
}

export function isStrictEqualityOperator(op: ts.SyntaxKind): boolean {
  return op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
}

export function isEqualityOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function isRelationalOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

/** `- * / %` — pure ToNumber operators (§13.7, §13.8.2). */
function isNumericArithmeticOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken
  );
}

function isBitwiseOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

/**
 * The eagerly lowered binary operators `binaryOperandsAdmissible` judges: the
 * arithmetic, bitwise, relational and equality operators. `&&` `||` `??` `,`
 * `in` `instanceof` `**` and the assignments have their own lowerings.
 */
export function isTypedBinaryOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusToken ||
    isNumericArithmeticOperator(op) ||
    isBitwiseOperator(op) ||
    isRelationalOperator(op) ||
    isEqualityOperator(op)
  );
}

function numberIfUndefined(family: OperandFamily): OperandFamily {
  return family === "undefined" ? "number" : family;
}

function isI32Carrier(family: OperandFamily): boolean {
  return family === "boolean" || family === "int32";
}

/**
 * from-ast's `lowerBinary` typing of an eagerly lowered operator over its two
 * LOWERED operand families (after the `+` proof of
 * {@link additiveOperandsProvable}, and after the operator-specific arms for a
 * `null` / `undefined` operand):
 * - a dynamic operand: equality and `+` box the other side (`tryLowerDynamicEq`,
 *   `IR_DYN_ADD_FN`); relational and `- * / %` ToNumber it, so the other side
 *   must be the carrier or an f64 (`tryLowerDynamicRelational`,
 *   `tryLowerDynamicArithmetic`). Bitwise operators have no dynamic arm.
 * - a string operand: the other side must be a string, and only `+`, the
 *   equalities and the relationals have a string lowering.
 * - otherwise one carrier on both sides: `+ - * / %` need f64; relational,
 *   equality and bitwise take f64 or i32.
 */
export function binaryOperandsAdmissible(op: ts.SyntaxKind, left: OperandFamily, right: OperandFamily): boolean {
  if (left === "undefined" || right === "undefined") {
    // The NaN sentinel is ToNumber(undefined): exact for the numeric readers.
    // Equality observes the value, and is exact only against an f64 — neither
    // `undefined` nor NaN equals any number, loosely or strictly; against the
    // carrier, a string or another `void` it is not. `+` never is.
    const other = left === "undefined" ? right : left;
    if (op === ts.SyntaxKind.PlusToken || (isEqualityOperator(op) && other !== "number")) return false;
    return binaryOperandsAdmissible(op, numberIfUndefined(left), numberIfUndefined(right));
  }
  if (left === "dynamic" || right === "dynamic") {
    const other = left === "dynamic" ? right : left;
    if (isEqualityOperator(op) || op === ts.SyntaxKind.PlusToken) return boxableIntoDynamic(other);
    if (isRelationalOperator(op) || isNumericArithmeticOperator(op)) return other === "dynamic" || other === "number";
    return false;
  }
  if (left === "string" || right === "string") {
    return left === right && (op === ts.SyntaxKind.PlusToken || isEqualityOperator(op) || isRelationalOperator(op));
  }
  if (op === ts.SyntaxKind.PlusToken || isNumericArithmeticOperator(op)) {
    return left === "number" && right === "number";
  }
  if (isRelationalOperator(op) || isEqualityOperator(op) || isBitwiseOperator(op)) {
    return (left === "number" && right === "number") || (isI32Carrier(left) && isI32Carrier(right));
  }
  return false;
}

/**
 * `tryFoldNullCompare`: an equality against the `null` literal is lowered for
 * a dynamic or externref operand only when STRICT (one tag / `ref.is_null`
 * test — loose equality also matches `undefined`), and constant-folded for a
 * representation that can never hold `null` (f64, i32, vecs, non-null refs;
 * `undefined` strictly only).
 * A string, a nullable struct reference or a class / object value may be
 * `null` at runtime and has no fold.
 */
export function nullComparisonFolds(op: ts.SyntaxKind, other: OperandFamily): boolean {
  // `undefined` is never `null` strictly; loosely it IS (`void 0 == null`),
  // which no constant fold of the NaN sentinel says.
  if (other === "dynamic" || other === "externref" || other === "undefined") return isStrictEqualityOperator(op);
  return (
    other === "number" ||
    other === "boolean" ||
    other === "int32" ||
    other === "vec<number>" ||
    other === "vec<other>" ||
    other === "ref" ||
    other === "other"
  );
}

/** The representations that can carry `null` (an externref, a `ref_null` reference). */
function isNullCarrier(family: OperandFamily): boolean {
  return family === "externref" || family === "nullable-ref";
}

/**
 * `lowerNullish`: `??` tests its left side with `ref.is_null`, so only a null
 * carrier has a lowering (the right side must then lower to the same type).
 */
export function nullishLeftAdmissible(left: OperandFamily): boolean {
  return isNullCarrier(left);
}

/**
 * A bare `null` value lowers only into a consumer whose type is a null carrier
 * (`lowerExpr`'s `null` arm): IR Phase 1 has no nullable union, so `null` in
 * an f64 / i32 / dynamic position has no representation. A discarded
 * expression and a `throw` operand are lowered under an externref hint; an
 * equality against `null` is folded and never lowers the literal.
 */
export function nullValueAdmissible(consumer: OperandFamily): boolean {
  return isNullCarrier(consumer);
}

/**
 * `lowerCompoundAssignment` for an identifier slot (an i32-promoted counter has
 * its own lowering): `+=` concatenates into a string slot only with a string
 * value (string-evidence then also requires an encoding), and is the dynamic
 * `+` into a dynamic slot with a boxable value; `+= -= *= /=` are f64
 * arithmetic on an f64 slot with an f64 value (or `void x`, whose NaN is
 * ToNumber(undefined)). Nothing else lowers.
 */
export function compoundWriteAdmissible(op: ts.SyntaxKind, slot: OperandFamily, value: OperandFamily): boolean {
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    if (slot === "string") return value === "string";
    if (slot === "dynamic") return boxableIntoDynamic(value);
  }
  // ToNumber(undefined) is the NaN sentinel the f64 arithmetic reads.
  return isF64CompoundAssignOperator(op) && slot === "number" && (value === "number" || value === "undefined");
}

/**
 * (#5163) The compound-assignment operators the IR desugars to an f64 binop
 * (`compoundF64Binop` in from-ast is their producer). The selector's
 * compound-statement arms admit exactly these, so an operator outside the set
 * is refused at selection instead of demoting at build.
 */
export function isF64CompoundAssignOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken
  );
}

/** `lowerIncrementDecrement`: `++` / `--` lower on an f64 or a dynamic slot. */
export function incrementSlotAdmissible(slot: OperandFamily): boolean {
  return slot === "number" || slot === "dynamic";
}

/**
 * `lowerIdentifierAssignment` (`x = v` into a slot). `representation-refined`
 * means the families agree but the write still needs representation identity
 * (`irTypeAssignable`: a vec's element type and nullability, a class / object
 * shape, …) that no family carries — the selector cannot prove it and refuses.
 * A `void x` value is inadmissible into every slot: its NaN sentinel would be
 * stored where `undefined` was written (`irTypeAssignable` sees two f64s).
 */
export type SlotWriteVerdict = "admissible" | "representation-refined" | "inadmissible";

export function slotWriteVerdict(slot: OperandFamily, value: OperandFamily): SlotWriteVerdict {
  if (slot === "unknown" || value === "unknown") return "inadmissible";
  if (slot === "dynamic") return boxableIntoDynamic(value) ? "admissible" : "inadmissible";
  // One i32 carrier with and without a boolean proof, or a non-null reference
  // into its nullable slot: the representation decides.
  if ((isI32Carrier(slot) && isI32Carrier(value) && slot !== value) || (slot === "nullable-ref" && value === "ref")) {
    return "representation-refined";
  }
  if (slot !== value) return "inadmissible";
  return slot === "number" || slot === "boolean" || slot === "string" || slot === "vec<number>"
    ? "admissible"
    : "representation-refined";
}
