// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) IR lowering of the ambient boolean statics — `Number.isNaN` /
 * `isFinite` / `isInteger` / `isSafeInteger`, `Object.is`, `Array.isArray` —
 * by operand family, as the #1371 Math whitelist lowers `Math.*`: matched
 * before receiver lowering (an ambient namespace has no IR value), operands
 * lowered unboxed, the answer a native IR boolean, as the checker types it. No
 * realm read, no runtime helper and no host import.
 *
 * The answers are main's: legacy's typed arms
 * (`codegen/expressions/call-builtin-static.ts`) op for op, where it has one:
 *   - a number operand takes `numberIsPredicateOps` / `sameValueNumberOps`
 *     (against a constant, only its bits) and is never `undefined`, as main's
 *     boxed `Object.is` path answers ({@link sameValueWithNumber});
 *   - `Number.is*` of a non-number primitive is `false` (§21.1.2.x: no ToNumber);
 *   - `Object.is` of two strings is string equality, of two booleans `i32.eq`,
 *     of two `undefined` or two `null` `true`, of two different families `false`;
 *   - `Array.isArray` of a primitive is `false`.
 * A missing argument is `undefined`. `./selection.ts` admits only operands of
 * these families and at most the plan's arity of them.
 */

import type { IrFunctionBuilder } from "../builder.js";
import { irBool } from "../boolean-brand.js";
import { irVal, type IrType, type IrValueId } from "../nodes.js";
import { demoteToLegacy } from "../outcomes.js";
import { isUndefinedCompareOperand, type OperandFamily } from "../analysis/operand-admissibility.js";
import { ts } from "../../ts-api.js";

type IrStaticPredicateTest = "nan" | "finite" | "integer" | "safe-integer" | "same-value" | "array";

export interface IrStaticPredicatePlan {
  /** The arguments the predicate reads. */
  readonly arity: 1 | 2;
  readonly test: IrStaticPredicateTest;
}

/** `<Namespace>.<method>` → plan, keyed by the ambient receiver's name. */
const IR_STATIC_PREDICATE_TABLE: Readonly<Record<string, IrStaticPredicatePlan>> = {
  "Number.isNaN": { arity: 1, test: "nan" },
  "Number.isFinite": { arity: 1, test: "finite" },
  "Number.isInteger": { arity: 1, test: "integer" },
  "Number.isSafeInteger": { arity: 1, test: "safe-integer" },
  "Object.is": { arity: 2, test: "same-value" },
  "Array.isArray": { arity: 1, test: "array" },
};

/** The plan of a direct, non-optional `<Namespace>.<m>(…)` on the ambient namespace, else undefined. */
export function staticPredicatePlan(
  call: ts.CallExpression,
  isAmbientNamespace: (receiver: ts.Identifier) => boolean,
): IrStaticPredicatePlan | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  if (callee.questionDotToken !== undefined || call.questionDotToken !== undefined) return undefined;
  const plan = IR_STATIC_PREDICATE_TABLE[`${callee.expression.text}.${callee.name.text}`];
  return plan !== undefined && isAmbientNamespace(callee.expression) ? plan : undefined;
}

/** The family of an operand with no effects and no IR value — `null`, the global `undefined`, `void 0` — else undefined. */
export function staticPredicateLiteralFamily(
  operand: ts.Expression,
  isGlobalUndefined: (operand: ts.Expression) => boolean,
): "nullish" | "undefined" | undefined {
  let candidate = operand;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  if (candidate.kind === ts.SyntaxKind.NullKeyword) return "nullish";
  return isUndefinedCompareOperand(candidate, () => !isGlobalUndefined(candidate)) ? "undefined" : undefined;
}

export interface IrStaticPredicateHost {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  /** Is `operand` the global `name` (`undefined`, `NaN`), unshadowed by a scope or module binding? */
  isUnshadowedGlobal(operand: ts.Expression, name: string): boolean;
  /** Lower an operand unboxed; `family` is the lowered value's `irOperandFamily`. */
  lowerOperand(operand: ts.Expression): { readonly value: IrValueId; readonly family: OperandFamily };
}

interface Operand {
  readonly family: OperandFamily;
  readonly value?: IrValueId;
  /** A number operand that is a constant: `NaN`, or any other value (`1.5`, `-0`, `Infinity`). */
  readonly constant?: "nan" | "number";
}

const IR_BOOL = irBool();
const F64: IrType = irVal({ kind: "f64" });
const I64: IrType = irVal({ kind: "i64" });
/** The families a lowered operand may have: `./selection.ts` admits only these. */
export const LOWERED_FAMILIES: ReadonlySet<OperandFamily> = new Set(["number", "string", "boolean"]);

export function lowerStaticPredicateCall(
  call: ts.CallExpression,
  plan: IrStaticPredicatePlan,
  host: IrStaticPredicateHost,
): IrValueId {
  const operands: Operand[] = [];
  for (let index = 0; index < plan.arity; index++) {
    const argument = call.arguments[index];
    const literal =
      argument === undefined
        ? "undefined"
        : staticPredicateLiteralFamily(argument, (operand) => host.isUnshadowedGlobal(operand, "undefined"));
    operands.push(literal !== undefined ? { family: literal } : lowerOperand(argument!, host));
  }
  const b = host.builder;
  const [x, y] = operands as [Operand, Operand | undefined];
  if (plan.test === "same-value") return sameValue(x, y!, b);
  return plan.test !== "array" && x.family === "number" ? numberTest(plan.test, x.value!, b) : booleanConst(false, b);
}

function lowerOperand(argument: ts.Expression, host: IrStaticPredicateHost): Operand {
  const operand = host.lowerOperand(argument);
  if (!LOWERED_FAMILIES.has(operand.family)) {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: static predicate operand lowered as ${operand.family} (${host.funcName})`,
    );
  }
  return operand.family === "number" ? { ...operand, constant: numberConstant(argument, host) } : operand;
}

/** `operand` without parentheses or a sign (`-(1.5)` → `1.5`): a sign keeps a constant a constant. */
export function unsignedOperand(operand: ts.Expression): ts.Expression {
  let candidate = operand;
  for (;;) {
    if (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
    else if (
      ts.isPrefixUnaryExpression(candidate) &&
      (candidate.operator === ts.SyntaxKind.MinusToken || candidate.operator === ts.SyntaxKind.PlusToken)
    ) {
      candidate = candidate.operand;
    } else return candidate;
  }
}

/** The constant a numeric literal, the global `NaN` or `Infinity` is, signed or not; else undefined. */
function numberConstant(operand: ts.Expression, host: IrStaticPredicateHost): Operand["constant"] {
  const candidate = unsignedOperand(operand);
  if (ts.isNumericLiteral(candidate)) return "number";
  if (!ts.isIdentifier(candidate) || (candidate.text !== "NaN" && candidate.text !== "Infinity")) return undefined;
  if (!host.isUnshadowedGlobal(candidate, candidate.text)) return undefined;
  return candidate.text === "NaN" ? "nan" : "number";
}

function booleanConst(value: boolean, b: IrFunctionBuilder): IrValueId {
  return b.emitConst({ kind: "bool", value }, IR_BOOL);
}

/** `numberIsPredicateOps` (codegen/number-is-predicate-ops.ts) over an f64. */
function numberTest(test: IrStaticPredicateTest, x: IrValueId, b: IrFunctionBuilder): IrValueId {
  if (test === "nan") return selfUnequal(x, b);
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const finite = b.emitBinary("f64.eq", b.emitBinary("f64.sub", x, x, F64), zero, IR_BOOL);
  if (test === "finite") return finite;
  const integral = b.emitBinary("f64.eq", x, b.emitUnary("f64.trunc", x, F64), IR_BOOL);
  const integer = b.emitBinary("i32.and", integral, finite, IR_BOOL);
  if (test === "integer") return integer;
  const maxSafe = b.emitConst({ kind: "f64", value: Number.MAX_SAFE_INTEGER }, F64);
  return b.emitBinary(
    "i32.and",
    integer,
    b.emitBinary("f64.le", b.emitUnary("f64.abs", x, F64), maxSafe, IR_BOOL),
    IR_BOOL,
  );
}

function selfUnequal(x: IrValueId, b: IrFunctionBuilder): IrValueId {
  return b.emitBinary("f64.ne", x, x, IR_BOOL);
}

/** SameValue (§7.2.10) over two admitted operands. */
function sameValue(x: Operand, y: Operand, b: IrFunctionBuilder): IrValueId {
  if (x.family === "number" || y.family === "number") return sameValueWithNumber(x, y, b);
  if (x.family !== y.family) return booleanConst(false, b);
  switch (x.family) {
    case "string": {
      // `string.eq` answers a bare i32; the predicate answers a JS boolean (the `irBool` brand).
      const equal = b.emitStringEq(x.value!, y.value!, false);
      return b.emitBinary("i32.ne", equal, booleanConst(false, b), IR_BOOL);
    }
    case "boolean":
      return b.emitBinary("i32.eq", x.value!, y.value!, IR_BOOL);
    default:
      return booleanConst(true, b);
  }
}

/**
 * SameValue with a number operand, branch-free: `sameValueNumberOps` (equal
 * bits, or both NaN), or against a constant only what it needs (`NaN`: a NaN;
 * any other constant: its bits). A number is never `undefined` here, as main's
 * boxed `Object.is` path answers (it boxes legacy's f64 `undefined` marker as a
 * number). The marker cannot be told from a NaN, because IR f64 ops (`+x`,
 * `Number(x)`, `Math.abs`) carry a NaN's payload through, so
 * `Object.is(+g(), undefined)` would read a marker that JS calls a number
 * (#7106 plan, follow-up 7).
 */
function sameValueWithNumber(x: Operand, y: Operand, b: IrFunctionBuilder): IrValueId {
  if (x.family !== y.family) return booleanConst(false, b);
  const [constant, other] = x.constant !== undefined ? [x, y] : [y, x];
  if (constant.constant === "nan") return selfUnequal(other.value!, b);
  const bits = (value: IrValueId): IrValueId => b.emitUnary("i64.reinterpret_f64", value, I64);
  const bitsEqual = b.emitBinary("i64.eq", bits(x.value!), bits(y.value!), IR_BOOL);
  if (constant.constant === "number") return bitsEqual;
  const bothNaN = b.emitBinary("i32.and", selfUnequal(x.value!, b), selfUnequal(y.value!, b), IR_BOOL);
  return b.emitBinary("i32.or", bitsEqual, bothNaN, IR_BOOL);
}
