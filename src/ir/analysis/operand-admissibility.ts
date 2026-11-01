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
 * - `nullish` — the `null` literal. from-ast lowers one as an operand only of
 *   a {@link isNumericReaderOperator}, as ToNumber(null) = +0.
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
  return isVoidZero(expr);
}

/** A literal `void 0`: the value `undefined`, whatever the scope binds. */
export function isVoidZero(expr: ts.Expression): boolean {
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

/**
 * The family `+` produces over its operands' families: the carrier when either
 * side is dynamic (the dynamic `+`), a number or a string over two of the
 * same, and nothing a selector can name otherwise.
 */
export function additiveResultFamily(left: OperandFamily, right: OperandFamily): OperandFamily {
  if (left === "dynamic" || right === "dynamic") return "dynamic";
  return left === right && (left === "number" || left === "string") ? left : "unknown";
}

/** The family `&&` / `||` produce: a boolean over two booleans, nothing a selector can name otherwise. */
export function logicalResultFamily(left: OperandFamily, right: OperandFamily): OperandFamily {
  return left === "boolean" && right === "boolean" ? "boolean" : "unknown";
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

/**
 * The operators that read their operands through ToNumber (§13.7–§13.12): the
 * relationals, `- * / %` and the bitwise operators. `+` and the equalities
 * observe the value itself.
 */
export function isNumericReaderOperator(op: ts.SyntaxKind): boolean {
  return isRelationalOperator(op) || isNumericArithmeticOperator(op) || isBitwiseOperator(op);
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

/** ToNumber(undefined) is the NaN sentinel and ToNumber(null) is +0: both read as an f64. */
function numberIfNullOrUndefined(family: OperandFamily): OperandFamily {
  return family === "undefined" || family === "nullish" ? "number" : family;
}

function isI32Carrier(family: OperandFamily): boolean {
  return family === "boolean" || family === "int32";
}

/**
 * from-ast's `lowerBinary` typing of an eagerly lowered operator over its two
 * LOWERED operand families (after the `+` proof of
 * {@link additiveOperandsProvable}, and after the operator-specific arms for a
 * `null` / `undefined` operand):
 * - a `null` operand of a numeric reader is +0; `+` and the equalities have no
 *   `null` arm here (`tryFoldNullCompare` owns `== null`).
 * - a dynamic operand: equality and `+` box the other side (`tryLowerDynamicEq`,
 *   `IR_DYN_ADD_FN`); the numeric readers ToNumber it, so the other side must
 *   be the carrier or an f64 (`tryLowerDynamicRelational`,
 *   `tryLowerDynamicArithmetic`).
 * - a string operand: the other side must be a string, and only `+`, the
 *   equalities and the relationals have a string lowering.
 * - otherwise one carrier on both sides: `+ - * / %` need f64; relational,
 *   equality and bitwise take f64 or i32.
 */
export function binaryOperandsAdmissible(op: ts.SyntaxKind, left: OperandFamily, right: OperandFamily): boolean {
  if (left === "nullish" || right === "nullish") {
    if (!isNumericReaderOperator(op)) return false;
    return binaryOperandsAdmissible(op, numberIfNullOrUndefined(left), numberIfNullOrUndefined(right));
  }
  if (left === "undefined" || right === "undefined") {
    // The NaN sentinel is ToNumber(undefined): exact for the numeric readers.
    // Equality observes the value, and is exact only against an f64 — neither
    // `undefined` nor NaN equals any number, loosely or strictly; against the
    // carrier, a string or another `void` it is not. `+` never is.
    const other = left === "undefined" ? right : left;
    if (op === ts.SyntaxKind.PlusToken || (isEqualityOperator(op) && other !== "number")) return false;
    return binaryOperandsAdmissible(op, numberIfNullOrUndefined(left), numberIfNullOrUndefined(right));
  }
  if (left === "dynamic" || right === "dynamic") {
    const other = left === "dynamic" ? right : left;
    if (isEqualityOperator(op) || op === ts.SyntaxKind.PlusToken) return boxableIntoDynamic(other);
    return isNumericReaderOperator(op) && (other === "dynamic" || other === "number");
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
 * (#7136) The selector's {@link binaryOperandsAdmissible} for an operator with
 * a native-i32 class-field operand (`v: i32`, #323). That field is an i32
 * slot, an `int32` operand rather than the `number` its checker type says, so
 * an operator `lowerBinary` cannot lower (`c.v + 1`) is refused before claim.
 */
export function nativeI32OperandsAdmissible(
  expr: ts.BinaryExpression,
  evidence:
    | {
        readonly isNativeI32SlotRead?: (operand: ts.Expression) => boolean;
        readonly classifyPrimitiveExpression?: (operand: ts.Expression) => string | undefined;
      }
    | undefined,
): boolean {
  const op = expr.operatorToken.kind;
  const isNativeI32 = evidence?.isNativeI32SlotRead;
  if (!isNativeI32 || !isTypedBinaryOperator(op) || (!isNativeI32(expr.left) && !isNativeI32(expr.right))) return true;
  const family = (operand: ts.Expression): OperandFamily =>
    isNativeI32(operand)
      ? "int32"
      : evidence.classifyPrimitiveExpression?.(operand) === "number"
        ? "number"
        : "unknown";
  return binaryOperandsAdmissible(op, family(expr.left), family(expr.right));
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
 * `+` into a dynamic slot with a boxable value; every numeric compound is
 * number arithmetic on an f64 slot with an f64 value (or `void x`, whose NaN is
 * ToNumber(undefined)). Nothing else lowers.
 */
export function compoundWriteAdmissible(op: ts.SyntaxKind, slot: OperandFamily, value: OperandFamily): boolean {
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    if (slot === "string") return value === "string";
    if (slot === "dynamic") return boxableIntoDynamic(value);
  }
  // ToNumber(undefined) is the NaN sentinel the number arithmetic reads.
  return isNumberCompoundAssignOperator(op) && slot === "number" && (value === "number" || value === "undefined");
}

/**
 * (#5163, #7183) The numeric compound assignments and the binary operator each
 * applies: `x op= v` is `x = x op v`, lowered by from-ast's `emitNumberBinary`
 * like the binary form. The selector's compound-statement arms admit exactly
 * these keys, so an operator outside the table is refused at selection instead
 * of demoting at build.
 */
const NUMBER_COMPOUND_BINARY_OPERATORS = {
  [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
  [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
  [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
  [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
  [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: ts.SyntaxKind.AsteriskAsteriskToken,
  [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
  [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
  [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
  [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
} as const;

/** The binary operators on two number operands (`+ - * / % ** & | ^ << >> >>>`). */
export type NumberBinaryOperator =
  (typeof NUMBER_COMPOUND_BINARY_OPERATORS)[keyof typeof NUMBER_COMPOUND_BINARY_OPERATORS];

const NUMBER_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set(Object.values(NUMBER_COMPOUND_BINARY_OPERATORS));

export function isNumberBinaryOperator(op: ts.SyntaxKind): op is NumberBinaryOperator {
  return NUMBER_BINARY_OPERATORS.has(op);
}

/**
 * (#7106) The number operators that ToNumeric each operand in turn — every one
 * but `+`, which takes both ToPrimitives first (§13.15.3).
 */
export function isToNumericOperator(op: ts.SyntaxKind): op is NumberBinaryOperator {
  return op !== ts.SyntaxKind.PlusToken && isNumberBinaryOperator(op);
}

/**
 * (#7106) A comparison with a fresh primitive wrapper that observes the
 * wrapper's identity, not its ToPrimitive: strict equality, or loose equality
 * between two wrappers. Selection refuses it; the builder never sees one.
 */
export function wrapperComparisonIsIdentity(op: ts.SyntaxKind, leftWrapper: boolean, rightWrapper: boolean): boolean {
  return isStrictEqualityOperator(op) || (isEqualityOperator(op) && leftWrapper && rightWrapper);
}

/** The binary operator a numeric compound assignment applies, or `undefined`. */
export function numberCompoundBinaryOperator(op: ts.SyntaxKind): NumberBinaryOperator | undefined {
  return NUMBER_COMPOUND_BINARY_OPERATORS[op as keyof typeof NUMBER_COMPOUND_BINARY_OPERATORS];
}

export function isNumberCompoundAssignOperator(op: ts.SyntaxKind): boolean {
  return numberCompoundBinaryOperator(op) !== undefined;
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

/**
 * (#7113) The family of a conditional arm the dynamic join (`m ? m : ''`)
 * takes as written, read syntactically by the selector and by from-ast alike:
 * a primitive literal (`number` / `string` / `boolean`) or a value `void x`
 * (`undefined`). `null` = not such an arm (the other arm must then be the
 * dynamic one, or the conditional is not the join).
 */
export function conditionalJoinArmFamily(arm: ts.Expression): OperandFamily | null {
  let e = arm;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return "string";
  if (ts.isNumericLiteral(e)) return "number";
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  return ts.isVoidExpression(e) ? "undefined" : null;
}

/**
 * (#7113) The family a conditional VALUE joins its two arms on. Equal
 * families join as themselves. A dynamic arm joins a boxable arm
 * ({@link boxableIntoDynamic}) on the carrier: from-ast boxes the concrete arm
 * inside its own branch. A value `void x` arm joins the carrier too — but as
 * the carrier's real `undefined` (`dyn.undefined`), never as its f64 NaN
 * sentinel, which would be observed as a number. Anything else has no join.
 */
export function conditionalJoinFamily(whenTrue: OperandFamily, whenFalse: OperandFamily): OperandFamily {
  if (whenTrue === whenFalse) return whenTrue;
  if (whenTrue !== "dynamic" && whenFalse !== "dynamic") return "unknown";
  const other = whenTrue === "dynamic" ? whenFalse : whenTrue;
  return boxableIntoDynamic(other) || other === "undefined" ? "dynamic" : "unknown";
}

/**
 * (#7113) `lowerThrowStatement`: a thrown value is coerced to externref, which
 * every reference-shaped family has (a class / object instance, an externref,
 * the carrier, a string). An f64 or i32 value — a number, a boolean, a value
 * `void x` — has no box there ("throw val not in slice 9"); the
 * number-boundary projection, where a lane configures it, is the lowering's
 * own earlier arm. An `unknown` family is refused like every other predicate.
 */
export function throwOperandAdmissible(family: OperandFamily): boolean {
  return (
    family !== "number" && family !== "boolean" && family !== "int32" && family !== "undefined" && family !== "unknown"
  );
}

/**
 * (#7113, #7193) `in` on a carrier receiver calls dynamic-runtime helpers a
 * prepared component (a planned member closure inside `<module-init>`) must
 * bind by Program ABI identity; a lane without `prepared-dynamic-helper-abi`
 * withdraws it after the claim, so the selector refuses it there instead.
 */
export function carrierInReceiver(receiver: OperandFamily): boolean {
  return receiver === "dynamic";
}

/**
 * (#7113, #7193) A loose `==` / `!=` with a carrier operand (an `undefined` /
 * `null` operand has its own fold). The carrier helpers miscompile an object
 * operand, so a lane without `native-dynamic-loose-equality` refuses it.
 */
export function carrierLooseOperator(op: ts.SyntaxKind, left: OperandFamily, right: OperandFamily): boolean {
  const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  return loose && (left === "dynamic" || right === "dynamic");
}

/**
 * (#7113, #7177) A member READ on the boxed-any carrier (`r.length`, `r[i]`,
 * `r.x`; `property` is `null` for an element read). An element read never
 * throws on a `null` / `undefined` receiver (`m[k]` with `m === null` answers
 * a value), and WASI's dynamic read has no string or vec receiver arm, so its
 * `.length` / `[i]` answer `undefined`. A named OWN property other than
 * `length` reads correctly on every lane; an inherited one (`r.push`,
 * `r.charAt`, `r.constructor`) answers `undefined` on every lane — the same
 * wrong value legacy gives, so it is not refused here (#7177).
 * `nativeMemberRead` is the lane's `native-dynamic-member-read` capability.
 */
export function carrierMemberReadAdmissible(
  receiver: OperandFamily,
  property: string | null,
  nativeMemberRead: boolean,
): boolean {
  if (receiver !== "dynamic") return true;
  if (property === null) return false;
  return nativeMemberRead || property !== "length";
}

/**
 * (#7113, #7178) A loose `==` / `!=` with a carrier operand, on a lane that
 * admits one at all: the carrier helper ToPrimitives an object / array by an
 * illegal cast and traps (`r == 1` with `r = [1, 2]`); only a string other
 * side takes the string arm.
 */
export function carrierLooseEqualityAdmissible(op: ts.SyntaxKind, left: OperandFamily, right: OperandFamily): boolean {
  if (op !== ts.SyntaxKind.EqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return true;
  if (left !== "dynamic" && right !== "dynamic") return true;
  return (left === "dynamic" ? right : left) === "string";
}

/**
 * (#7113, #7177) A method call `v.m(…)` on the boxed-any carrier: the IR's
 * generic dynamic method call answers a value when `v` is `null` / `undefined`
 * or has no callable `m`, where JS throws a TypeError (`m.g()` on `null` or on
 * an array, standalone and WASI alike). A call `wrapped` by the #7119
 * brand-dispatch wrapper performs the [[Get]] and throws that TypeError itself.
 */
export function carrierMethodCallAdmissible(receiver: OperandFamily, wrapped: boolean): boolean {
  return wrapped || receiver !== "dynamic";
}

/**
 * (#7113) `String(v)` over the carrier calls a dynamic-runtime helper that a
 * prepared component binds by Program ABI identity, like
 * {@link carrierInReceiver} (`prepared-dynamic-helper-abi`): a lane
 * without it withdraws at preparation (`late-preparation-unsupported`).
 */
export function carrierHelperCall(callee: string, argument: OperandFamily): boolean {
  return callee === "String" && argument === "dynamic";
}

/**
 * (#7113) A property or element store `recv.p = v` / `recv[i] = v`: from-ast
 * has no store on the boxed-any carrier (`lowerPropertyAssignment` ends in
 * "property assignment on dynamic is not in slice 4", `lowerElementStore`
 * demotes every non-vec receiver), and an element store into a `vec<f64>`
 * takes only a value that coerces to f64 (an f64, an i32) — a string, the
 * carrier or a reference is `element-store-unsupported`. Stores into other
 * receivers keep their own lowerings and are not judged here.
 */
export function storeAdmissible(receiver: OperandFamily, value: OperandFamily, element: boolean): boolean {
  if (receiver === "dynamic") return false;
  if (!element || receiver !== "vec<number>") return true;
  return value === "number" || value === "int32";
}

/**
 * (#7113) `lowerSwitch` needs an f64 / i32 discriminant (or a string one it
 * dispatches by index): the boxed-any carrier is "switch disc must lower to
 * i32/f64". Other discriminants keep their own checks.
 */
export function switchDiscriminantAdmissible(discriminant: OperandFamily): boolean {
  return discriminant !== "dynamic";
}

/**
 * (#7113) An argument of a call THROUGH the boxed-any carrier (a dynamic
 * parameter called as a function, a method of a carrier value): every
 * argument crosses into the carrier's any-typed parameter list, where a vec
 * has no representation ("array literal flows into a widening/heterogeneous
 * sink"). Other families keep their existing argument lowering.
 */
export function dynamicCallArgumentAdmissible(argument: OperandFamily): boolean {
  return argument !== "vec<number>" && argument !== "vec<other>";
}
